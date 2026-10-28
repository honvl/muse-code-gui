import { appendFile, readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForSelectedSessionReady,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";
import {
  createSessionFileBeside,
  sessionFilePathFromCatalog,
  type SeededSessionFileMessage,
} from "../helpers/session-file";

const PROVIDER_ID = "subagent-lane-test";
const MODEL_ID = "scripted";
const FOUND_DESCRIPTION = "Probe session found";
const MISSING_DESCRIPTION = "Probe session missing";
const SUBAGENT_SECRET = "SUBAGENT-SECRET-42";

// A stub `agent` tool mirroring the third-party pi-cc-subagent result shape
// (details with type/description/status/activity/finalText), plus a scripted
// provider that emits two parallel agent calls in one turn.
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function subagents(pi) {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description: "Launch a subagent (test stub mirroring pi-cc-subagent's result shape)",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        subagent_type: { type: "string" },
      },
    },
    async execute(_id, input) {
      const description = String(input.description ?? "");
      return {
        content: [{ type: "text", text: "Subagent finished: " + description }],
        details: {
          id: "agent-1",
          type: String(input.subagent_type ?? "general-purpose"),
          description,
          status: "done",
          turns: 2,
          toolCalls: 3,
          cost: 0,
          activity: ["read: src/auth.ts", "grep: token flow"],
          finalText: "Subagent finished: " + description,
          elapsedMs: 1500,
        },
      };
    },
  });
  pi.registerProvider("subagent-lane-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "subagent-lane-test",
    models: [{
      id: "scripted",
      name: "Scripted",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const called = context.messages.some((message) => message.role === "toolResult");
      const content = called
        ? [{ type: "text", text: "Both probes are back." }]
        : [
            {
              type: "toolCall",
              id: "subagent-call-found",
              name: "agent",
              arguments: {
                description: "Probe session found",
                prompt: "Summarize the auth flow.",
                subagent_type: "explore",
              },
            },
            {
              type: "toolCall",
              id: "subagent-call-missing",
              name: "agent",
              arguments: {
                description: "Probe session missing",
                prompt: "Check the billing page.",
                subagent_type: "plan",
              },
            },
          ];
      const message = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: called ? "stop" : "toolUse",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    },
  });
}
`;

/**
 * Fabricate a named subagent session file beside the parent's, the way the
 * standalone `pi` behind the third-party extension would: same directory
 * (same cwd), a `session_info` name entry like `agent:<type>: <desc>`,
 * then the given messages.
 */
async function createNamedSubagentSession(
  siblingSessionFilePath: string,
  fileName: string,
  name: string,
  messages: readonly SeededSessionFileMessage[],
): Promise<string> {
  const sessionFilePath = await createSessionFileBeside(siblingSessionFilePath, fileName, []);
  const lines = (await readFile(sessionFilePath, "utf8")).split("\n").filter(Boolean);
  const parentId = (JSON.parse(lines.at(-1) ?? "{}") as { id?: string }).id ?? null;
  await appendFile(
    sessionFilePath,
    `${JSON.stringify({
      type: "session_info",
      id: `seeded-name-${Date.now()}`,
      parentId,
      timestamp: new Date().toISOString(),
      name,
    })}\n`,
    "utf8",
  );
  const { appendMessagesToSessionFile } = await import("../helpers/session-file");
  await appendMessagesToSessionFile(sessionFilePath, messages);
  return sessionFilePath;
}

test("agent tool rows surface as read-only subagent lanes", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("subagent-lane");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
    }),
  );
  await writeProjectExtension(workspacePath, "subagents.ts", extensionSource);

  // Create the parent thread once so its session file is tracked, then close
  // to flush the catalog before fabricating the subagent session beside it.
  let workspaceId = "";
  let sessionId = "";
  const firstRun = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Lead with subagents");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });
  } finally {
    await firstRun.close();
  }

  const parentFile = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await createNamedSubagentSession(parentFile, "subagent-probe.jsonl", `agent:explore: ${FOUND_DESCRIPTION}`, [
    { role: "user", text: "Summarize the auth flow." },
    { role: "assistant", text: `The auth flow lives in src/auth.ts. ${SUBAGENT_SECRET}` },
  ]);

  const run = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await run.firstWindow();
    await run.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1500, height: 950 });
    });
    await waitForWorkspaceByPath(window, workspacePath);
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });

    const composer = window.getByTestId("composer");
    await composer.click();
    await composer.fill("Delegate two probes in parallel.");
    await composer.press("Enter");

    const card = window.getByTestId("session-rail-subagents");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText(`explore · ${FOUND_DESCRIPTION}`);
    await expect(card).toContainText(`plan · ${MISSING_DESCRIPTION}`);
    await expect(card).toContainText("Done");
    await expect(card).toContainText("grep: token flow");

    // The lane without a session file still shows its tool-row status, and
    // opening it explains the miss instead of failing.
    await card.getByRole("button", { name: new RegExp(MISSING_DESCRIPTION) }).click();
    await expect(card).toContainText("Session file not found");

    // The located lane opens the subagent's own transcript read-only: the
    // secret text renders, but no composer or thread action reaches the lane.
    await card.getByRole("button", { name: new RegExp(FOUND_DESCRIPTION) }).click();
    await expect(card).toContainText(SUBAGENT_SECRET, { timeout: 15_000 });
    await expect(card.getByTestId("composer")).toHaveCount(0);

    await window.screenshot({ path: "/tmp/subagent-lane.png" });
  } finally {
    await run.close();
  }
});
