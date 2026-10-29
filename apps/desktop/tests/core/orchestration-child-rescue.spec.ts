import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
} from "../helpers/electron-app";

const CHILD_TOKEN = "RESCUE-CHILD-SLEEP";
const FOLLOW_UP_TOKEN = "RESCUE-FOLLOW-UP";
const CHILD_DONE = "RESCUE-CHILD-DONE";

const execFileAsync = promisify(execFile);
/**
 * Three process levels under the tool shell (tool shell → bash → sleep),
 * mirroring the hung `bash → node --test → node worker` tree: pi kills the
 * whole process group on abort, so the grandchild must die with the shell.
 * `exec -a` gives the grandchild a unique name, so the survivors check
 * cannot match unrelated sleepers on the machine.
 */
const SLEEP_COMMAND = 'bash -c "exec -a rescue-sleep-probe sleep 120"';
const SLEEP_MARKER = "rescue-sleep-probe";

/**
 * Scripted OpenAI-completions SSE server. A child prompt carrying the token
 * gets a bash tool call that sleeps far longer than the test; any later turn
 * (the aborted tool result, the lead's follow-up) gets a final text answer so
 * the rescued run can complete.
 */
async function startScriptedServer(): Promise<{
  readonly baseUrl: string;
  readonly prompts: string[];
  readonly close: () => Promise<void>;
}> {
  const prompts: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (!request.url?.includes("/chat/completions")) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const payload = JSON.parse(body || "{}") as {
        model?: string;
        messages?: unknown;
      };
      const transcript = JSON.stringify(payload.messages ?? []);
      prompts.push(transcript);
      const chunk = {
        id: "chatcmpl-child-rescue",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: payload.model ?? "scripted",
      };
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const writeChunk = (choices: unknown[], extra: Record<string, unknown> = {}) => {
        response.write(`data: ${JSON.stringify({ ...chunk, choices, ...extra })}\n\n`);
      };
      const wantsSleep =
        transcript.includes(CHILD_TOKEN) &&
        !transcript.includes("tool_call_id") &&
        !transcript.includes(FOLLOW_UP_TOKEN);
      if (wantsSleep) {
        writeChunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_sleep_1",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command: SLEEP_COMMAND }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ]);
        writeChunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      } else {
        const reply = transcript.includes(CHILD_TOKEN) ? CHILD_DONE : "PARENT ACK";
        writeChunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
        writeChunk([{ index: 0, delta: { content: reply }, finish_reason: null }]);
        writeChunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    prompts,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function selectedSessionRef(
  window: Parameters<typeof getDesktopState>[0],
): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("a lead rescue unsticks a child hanging in a bash sleep", async () => {
  test.setTimeout(120_000);
  const server = await startScriptedServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-child-rescue");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["scripted-test/scripted"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "scripted-test",
        defaultModel: "scripted",
        enabledModels: ["scripted-test/scripted"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "scripted-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "scripted" }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent rescue thread");
    const parentRef = await selectedSessionRef(window);

    await window.getByRole("button", { name: "Solo", exact: true }).click();
    await expect(window.getByRole("button", { name: "Lead", exact: true })).toBeVisible();

    const created = await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-rescue-child",
      sessionRef: parentRef,
      params: {
        prompt: `Run sleep 120 via the bash tool. Token ${CHILD_TOKEN}.`,
        scope: "rescue probe",
      },
    });
    const childThreadId = (created.details as { childThreadId?: string } | undefined)
      ?.childThreadId;
    expect(childThreadId, "child thread id is returned").toBeTruthy();

    // The lead sees the child's in-flight bash tool and how long it ran.
    await expect
      .poll(
        async () => {
          const listed = await runOrchestrationRuntimeTool(harness, {
            toolName: "list_threads",
            toolCallId: `list-rescue-child-${Date.now()}`,
            sessionRef: parentRef,
            params: {},
          });
          const text =
            listed.content.map((item) => item.text ?? "").join("\n") ?? "";
          return text.includes("running: bash") ? text : undefined;
        },
        { timeout: 60_000 },
      )
      .toContain("sleep 120");

    const rescue = await runOrchestrationRuntimeTool(harness, {
      toolName: "send_message_to_thread",
      toolCallId: "rescue-stuck-child",
      sessionRef: parentRef,
      params: {
        thread_id: childThreadId,
        message: `${FOLLOW_UP_TOKEN}: the sleep hung. Reply ${CHILD_DONE} immediately without tools.`,
        rescue: true,
      },
    });
    const rescueText = rescue.content.map((item) => item.text ?? "").join("\n");
    expect(rescueText).toContain(`Rescued thread ${childThreadId}`);
    expect((rescue.details as { rescued?: boolean } | undefined)?.rescued).toBe(true);

    // The killed sleep ends the stuck tool, the follow-up turn runs, and the
    // child reports its final text back to the lead.
    await expect
      .poll(() => server.prompts.length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(3);
    expect(
      server.prompts.some(
        (prompt) => prompt.includes(FOLLOW_UP_TOKEN) && prompt.includes(CHILD_DONE),
      ),
      "the follow-up turn ran to the final text",
    ).toBe(true);

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.orchestrationChildren[0]?.status;
      }, { timeout: 60_000 })
      .toBe("complete");

    // The rescue killed the whole process tree: no level of the sleep
    // command may survive (an escaped grandchild would still be listed).
    const { stdout: processes } = await execFileAsync("ps", ["-eo", "args"]);
    expect(
      processes.split("\n").filter((line) => line.includes(SLEEP_MARKER)),
      "no grandchild sleep survives the rescue",
    ).toEqual([]);

    const read = await runOrchestrationRuntimeTool(harness, {
      toolName: "read_thread",
      toolCallId: "read-rescued-child",
      sessionRef: parentRef,
      params: { thread_id: childThreadId, full: true },
    });
    const readText = read.content.map((item) => item.text ?? "").join("\n");
    expect(readText).toContain("bash");
    expect(readText).toContain("[error]");
    expect(readText).toContain(CHILD_DONE);
  } finally {
    await harness.close();
    await server.close();
  }
});
