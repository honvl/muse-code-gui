import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "tool-group-failure-test";
const MODEL_ID = "scripted";
const THREAD_TITLE = "Batch with a broken call";

// The scripted model asks for two tools in one message: one succeeds, one throws.
// Both land as consecutive rows, so the timeline collapses them into a single
// "Ran 2 tools" group that has to show the failure without painting the batch red.
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function batch(pi) {
  pi.registerTool({
    name: "probe",
    description: "Read something harmless",
    parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    async execute(_id, input) {
      return { content: [{ type: "text", text: "probe ok: " + input.topic }], details: {} };
    },
  });
  pi.registerTool({
    name: "crash",
    description: "Fail on purpose",
    parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    async execute() {
      throw new Error("kaboom");
    },
  });
  pi.registerProvider("tool-group-failure-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "tool-group-failure-test",
    models: [{
      id: "scripted",
      name: "Scripted",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const ranTools = context.messages.some((message) => message.role === "toolResult");
      const content = ranTools
        ? [{ type: "text", text: "One probe worked, one crash failed." }]
        : [
            { type: "toolCall", id: "probe-1", name: "probe", arguments: { topic: "disk" } },
            { type: "toolCall", id: "crash-1", name: "crash", arguments: { topic: "disk" } },
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
        stopReason: ranTools ? "stop" : "toolUse",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (ranTools) stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    },
  });
}
`;

const color = (target: Locator) => target.evaluate((element) => getComputedStyle(element).color);
const pipColor = (target: Locator) =>
  target.evaluate((element) => getComputedStyle(element).backgroundColor);

async function expectNeutralGroupWithOneRedRow(window: Page) {
  const transcript = window.getByTestId("transcript");
  const group = transcript.getByTestId("tool-group");
  await expect(group).toHaveCount(1);
  // Children render below the group's own header once it is expanded, so the
  // first header row always belongs to the summary.
  const groupHeader = group.locator(".timeline-tool__header-row").first();

  // The summary reports the failure but does not become the failure.
  await expect(groupHeader.locator(".timeline-tool__label")).toHaveText("Ran 2 tools");
  await expect(groupHeader.locator(".timeline-tool__meta-inline")).toContainText("2 tools");
  await expect(groupHeader.locator(".timeline-tool__meta-inline")).toContainText("1 failed");
  await expect(group).not.toHaveClass(/timeline-tool--error/);

  await group.getByTestId("tool-group-header").click();
  const rows = group.locator(".timeline-tool-group__tools .timeline-tool");
  await expect(rows).toHaveCount(2);
  const failedRow = rows.filter({ hasText: "crash" });
  const okRow = rows.filter({ hasText: "probe" });
  await expect(failedRow).toHaveClass(/timeline-tool--error/);
  await expect(okRow).toHaveClass(/timeline-tool--success/);

  const failedLabel = failedRow.locator(".timeline-tool__label");
  const okLabel = okRow.locator(".timeline-tool__label");
  const groupLabel = groupHeader.locator(".timeline-tool__label");
  const failedColor = await color(failedLabel);
  // The failing row is the only red label: its sibling and the summary keep the
  // ordinary tool ink instead of inheriting the group's failure.
  expect(await color(okLabel)).not.toBe(failedColor);
  expect(await color(groupLabel)).not.toBe(failedColor);
  expect(await color(groupLabel)).toBe(await color(okLabel));

  const failedPip = failedRow.locator(".timeline-tool__status-pip");
  const okPip = okRow.locator(".timeline-tool__status-pip");
  const groupPip = groupHeader.locator(".timeline-tool__status-pip");
  const failedPipColor = await pipColor(failedPip);
  expect(await pipColor(okPip)).not.toBe(failedPipColor);
  // A small pip still carries the failure so the collapsed row is not a silent pass.
  expect(await pipColor(groupPip)).toBe(failedPipColor);
}

test("one failed call in a tool group leaves its siblings and the summary uncolored", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("tool-group-failure");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspacePath, "batch.ts", extensionSource);

  const run = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await run.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, THREAD_TITLE);
    const composer = window.getByTestId("composer");
    await composer.click();
    await composer.fill("Probe the disk and crash on purpose.");
    await composer.press("Enter");
    await expect(window.locator(".timeline-item--assistant")).toContainText(
      "One probe worked, one crash failed.",
    );
    await expectNeutralGroupWithOneRedRow(window);
  } finally {
    await run.close();
  }
});
