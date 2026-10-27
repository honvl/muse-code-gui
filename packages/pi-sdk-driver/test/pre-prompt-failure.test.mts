import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

await test("pre-prompt failure reports a failed run and allows a later send", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-pre-prompt-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], cacheWarming: "off" }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "local-test": {
          baseUrl: "http://127.0.0.1:9",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  let runtime: AgentSessionRuntime;
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (options) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({ ...options, tools: [] });
      runtime.session.agent.streamFunction = (model) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      };
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "pre-prompt", path: cwd },
    { initialModel: { provider: "local-test", modelId: "scripted" } },
  );
  const events: SessionDriverEvent[] = [];
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });
  const stats = runtime!.session.getSessionStats.bind(runtime!.session);
  runtime!.session.getSessionStats = () => {
    throw new Error("pre-prompt check failed");
  };
  await assert.rejects(driver.sendUserMessage(ref, { text: "first" }), /pre-prompt check failed/);
  assert.ok(events.some((event) => event.type === "runFailed"));
  runtime!.session.getSessionStats = stats;
  await driver.sendUserMessage(ref, { text: "retry" });
  await runtime!.session.waitForIdle();
  assert.ok(
    runtime!.session.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text === "OK"),
    ),
  );
});
