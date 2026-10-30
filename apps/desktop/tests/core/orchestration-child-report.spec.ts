import { createServer } from "node:http";
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

const CHILD_TOKEN = "CHILD-TASK-42";
const CHILD_REPLY = "CHILD-42 RESULT";

/**
 * Minimal OpenAI-completions SSE server. The child's prompt gets a distinct
 * answer so the parent's request proves it received the child's final text.
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
      const reply = transcript.includes(CHILD_TOKEN) ? CHILD_REPLY : "PARENT ACK";
      const chunk = {
        id: "chatcmpl-child-report",
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
      writeChunk([{ index: 0, delta: { content: reply }, finish_reason: null }]);
      writeChunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
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

test("a finished child wakes its orchestrator with a visible report", async () => {
  test.setTimeout(90_000);
  const server = await startScriptedServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-child-report");
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
    await createNamedThread(window, "Parent orchestrator thread");
    const parentRef = await selectedSessionRef(window);

    // The report only wakes dispatcher-only threads; a normal thread keeps
    // owning its children through tool results.
    await window.getByRole("button", { name: "Solo", exact: true }).click();
    await expect(window.getByRole("button", { name: "Lead", exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const session = state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === parentRef.sessionId);
        return session?.config?.orchestratorMode === true;
      })
      .toBe(true);

    await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-child-report",
      sessionRef: parentRef,
      params: { prompt: `Reply with the token ${CHILD_TOKEN}` },
    });

    // The child's turn finishes, its report wakes the parent, and the parent
    // runs a turn over that report — visible as a second model request.
    // Two requests can be the lead's first turn and the child's own, before the report's turn.
    await expect
      .poll(
        () =>
          server.prompts.some(
            (prompt) => prompt.includes(CHILD_REPLY) && prompt.includes("finished."),
          ),
        {
          message: "the parent's request carries the child's final text",
          timeout: 60_000,
        },
      )
      .toBe(true);

    await expect(window.getByTestId("timeline-custom-message")).toContainText(
      "pi-gui.child-report",
    );
    await expect(window.getByTestId("timeline-custom-message")).toContainText(CHILD_REPLY);
    await expect(window.getByTestId("timeline-custom-message")).toContainText("finished.");

    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.orchestrationChildren[0]?.status;
      })
      .toBe("complete");
  } finally {
    await harness.close();
    await server.close();
  }
});
