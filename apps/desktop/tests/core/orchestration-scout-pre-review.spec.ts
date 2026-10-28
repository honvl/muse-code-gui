import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
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
import { SCOUT_PRE_REVIEW_BRIEF_OPENING } from "../../electron/orchestration/scout-pre-review";

const WORKER_TOKEN = "WORKER-TASK-77";
const WORKER_REPLY = "WORKER-77 wrote alpha and beta";
const SCOUT_VERDICT = "Verdict: needs attention. Hunks: beta.txt:1 - SCOUT-77 flags this line";

type RequestKind = "worker-tools" | "worker-final" | "scout" | "lead" | "other";

/**
 * OpenAI-completions SSE fake. The worker's first request answers with two
 * `write` tool calls (a two-file change); after the tool results it reports.
 * The review scout and the lead each get a fixed text answer.
 */
async function startScriptedServer(): Promise<{
  readonly baseUrl: string;
  readonly requests: Array<{ kind: RequestKind; transcript: string }>;
  readonly close: () => Promise<void>;
}> {
  const requests: Array<{ kind: RequestKind; transcript: string }> = [];
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
        messages?: Array<{ role?: string }>;
      };
      const transcript = JSON.stringify(payload.messages ?? []);
      // Side requests (next-message suggestions) quote the transcript, and
      // the scout brief and the lead's history both quote the worker brief,
      // so classify in this order. Only the lead sees a child report.
      const kind: RequestKind = transcript.includes("most useful next message")
        ? "other"
        : transcript.includes(SCOUT_PRE_REVIEW_BRIEF_OPENING)
          ? "scout"
          : transcript.includes("thread_id:")
            ? "lead"
            : transcript.includes(WORKER_TOKEN)
              ? (payload.messages ?? []).some((message) => message.role === "tool")
                ? "worker-final"
                : "worker-tools"
              : "other";
      requests.push({ kind, transcript });
      const chunk = {
        id: "chatcmpl-pre-review",
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
      writeChunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
      if (kind === "worker-tools") {
        const calls = [
          { name: "alpha.txt", content: "alpha\n" },
          { name: "beta.txt", content: "beta\n" },
        ];
        calls.forEach((file, index) => {
          writeChunk([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: `call_write_${index}`,
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ path: file.name, content: file.content }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ]);
        });
        writeChunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      } else {
        const reply =
          kind === "scout" ? SCOUT_VERDICT : kind === "worker-final" ? WORKER_REPLY : "LEAD ACK";
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
    requests,
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

test("a two-file worker run reaches the lead as one report with the scout's verdict", async () => {
  test.setTimeout(120_000);
  const server = await startScriptedServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-scout-pre-review");
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
    await createNamedThread(window, "Lead with pre-review");
    const leadRef = await selectedSessionRef(window);

    await window.getByRole("button", { name: "Solo", exact: true }).click();
    await expect(window.getByRole("button", { name: "Lead", exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const session = state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === leadRef.sessionId);
        return session?.config?.orchestratorMode === true;
      })
      .toBe(true);

    await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-pre-review-worker",
      sessionRef: leadRef,
      params: { prompt: `Write alpha.txt and beta.txt. ${WORKER_TOKEN}`, mode: "worker" },
    });

    // Worker writes two files, the host starts a review scout, and only the
    // combined report wakes the lead.
    await expect
      .poll(() => server.requests.some((entry) => entry.kind === "lead"), { timeout: 90_000 })
      .toBe(true);
    expect(await readFile(join(workspacePath, "alpha.txt"), "utf8")).toBe("alpha\n");
    expect(await readFile(join(workspacePath, "beta.txt"), "utf8")).toBe("beta\n");

    const kinds = server.requests.map((entry) => entry.kind);
    const scoutIndex = kinds.indexOf("scout");
    expect(scoutIndex, "a review scout ran").toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("lead"), "the lead was not woken before the verdict").toBeGreaterThan(
      scoutIndex,
    );
    const scoutRequest = server.requests[scoutIndex]?.transcript ?? "";
    expect(scoutRequest).toContain("alpha.txt");
    expect(scoutRequest).toContain("beta.txt");

    const leadRequest = server.requests.find((entry) => entry.kind === "lead")?.transcript ?? "";
    expect(leadRequest).toContain(WORKER_REPLY);
    expect(leadRequest).toContain("SCOUT-77 flags this line");
    expect(leadRequest).toContain("Scout pre-review (thread_id:");

    const reports = window.getByTestId("timeline-custom-message");
    await expect(reports).toHaveCount(1);
    await expect(reports).toContainText(WORKER_REPLY);
    await expect(reports).toContainText("SCOUT-77 flags this line");

    const state = await getDesktopState(window);
    const worker = state.orchestrationChildren.find(
      (child) => child.parentSessionId === leadRef.sessionId,
    );
    const scout = state.orchestrationChildren.find((child) => child.mode === "scout");
    expect(worker?.mode).toBe("worker");
    // The review scout belongs to the worker, not to the lead's budget.
    expect(scout?.parentSessionId).toBe(worker?.childSessionId);
    expect(
      state.orchestrationChildren.filter((child) => child.parentSessionId === leadRef.sessionId),
    ).toHaveLength(1);
  } finally {
    await harness.close();
    await server.close();
  }
});
