import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompactionModelRouteExtension } from "../dist/compaction-model-route.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";
import { SessionSupervisor } from "../dist/session-supervisor.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const SIDEKICK = { provider: "acme", id: "sidekick-1" };
const LEAD = { provider: "acme", id: "lead-1" };

function makeHarness(options: {
  route?: unknown;
  routerError?: Error;
  setModelResult?: boolean;
  knownModels?: readonly { provider: string; id: string }[];
}) {
  const handlers: Record<string, Handler> = {};
  const setModelCalls: unknown[] = [];
  const thinkingCalls: string[] = [];
  const routerRequests: unknown[] = [];
  const routed: unknown[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers[event] = handler;
      return () => {};
    },
    getThinkingLevel: () => "low",
    setModel: async (model: unknown) => {
      setModelCalls.push(model);
      return options.setModelResult ?? true;
    },
    setThinkingLevel: (level: string) => {
      thinkingCalls.push(level);
    },
  };
  const known = options.knownModels ?? [SIDEKICK, LEAD];
  const ctx = {
    model: SIDEKICK,
    sessionManager: { getSessionId: () => "child-session" },
    modelRegistry: {
      find: (provider: string, id: string) =>
        known.find((model) => model.provider === provider && model.id === id),
    },
  };
  const factory = createCompactionModelRouteExtension({
    workspaceId: "ws",
    router: async (request) => {
      routerRequests.push(request);
      if (options.routerError) throw options.routerError;
      return options.route as never;
    },
    onRouted: (sessionRef, route) => routed.push({ sessionRef, route }),
  });
  return { handlers, pi, ctx, factory, setModelCalls, thinkingCalls, routerRequests, routed };
}

function compactEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "session_before_compact",
    preparation: { tokensBefore: 120_000 },
    branchEntries: [],
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function fire(harness: ReturnType<typeof makeHarness>, event = compactEvent()) {
  await harness.factory(harness.pi as never);
  const handler = harness.handlers["session_before_compact"];
  assert.ok(handler, "session_before_compact handler registered");
  return handler(event, harness.ctx);
}

await test("a route swaps the model at compaction without touching the compaction", async () => {
  const harness = makeHarness({
    route: { model: { provider: "acme", modelId: "lead-1" }, thinkingLevel: "high" },
  });
  const result = await fire(harness);

  assert.equal(result, undefined, "never cancels or replaces pi's compaction");
  assert.deepEqual(harness.routerRequests, [
    {
      sessionRef: { workspaceId: "ws", sessionId: "child-session" },
      reason: "threshold",
      willRetry: false,
      tokensBefore: 120_000,
      model: { provider: "acme", modelId: "sidekick-1" },
      thinkingLevel: "low",
    },
  ]);
  assert.deepEqual(harness.setModelCalls, [LEAD]);
  assert.deepEqual(harness.thinkingCalls, ["high"]);
  assert.deepEqual(harness.routed, [
    {
      sessionRef: { workspaceId: "ws", sessionId: "child-session" },
      route: { model: { provider: "acme", modelId: "lead-1" }, thinkingLevel: "high" },
    },
  ]);
});

await test("no route keeps the session as is", async () => {
  const harness = makeHarness({ route: undefined });
  assert.equal(await fire(harness), undefined);
  assert.equal(harness.routerRequests.length, 1);
  assert.deepEqual(harness.setModelCalls, []);
  assert.deepEqual(harness.thinkingCalls, []);
  assert.deepEqual(harness.routed, []);
});

await test("the current model only changes the thinking level", async () => {
  const harness = makeHarness({
    route: { model: { provider: "acme", modelId: "sidekick-1" }, thinkingLevel: "xhigh" },
  });
  await fire(harness);
  assert.deepEqual(harness.setModelCalls, [], "no model_change for the same model");
  assert.deepEqual(harness.thinkingCalls, ["xhigh"]);
  assert.equal(harness.routed.length, 1);
});

await test("an unknown or unauthenticated model is skipped, thinking included", async () => {
  const unknown = makeHarness({
    route: { model: { provider: "acme", modelId: "missing" }, thinkingLevel: "high" },
  });
  await fire(unknown);
  assert.deepEqual(unknown.setModelCalls, []);
  assert.deepEqual(unknown.thinkingCalls, []);
  assert.deepEqual(unknown.routed, []);

  const noAuth = makeHarness({
    route: { model: { provider: "acme", modelId: "lead-1" }, thinkingLevel: "high" },
    setModelResult: false,
  });
  await fire(noAuth);
  assert.deepEqual(noAuth.setModelCalls, [LEAD]);
  assert.deepEqual(noAuth.thinkingCalls, []);
  assert.deepEqual(noAuth.routed, []);
});

await test("a failing router or an aborted compaction never fails or reroutes", async () => {
  const failing = makeHarness({ routerError: new Error("policy exploded") });
  assert.equal(await fire(failing), undefined);
  assert.deepEqual(failing.setModelCalls, []);

  const controller = new AbortController();
  controller.abort();
  const aborted = makeHarness({ route: { model: { provider: "acme", modelId: "lead-1" } } });
  assert.equal(await fire(aborted, compactEvent({ signal: controller.signal })), undefined);
  assert.deepEqual(aborted.setModelCalls, []);
});

async function loadedExtensionNames(
  t: test.TestContext,
  router: unknown,
): Promise<readonly string[]> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-compaction-route-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  let names: readonly string[] = [];
  const supervisor = new SessionSupervisor({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    ...(router ? { compactionModelRouter: router as never } : {}),
    createAgentSessionRuntimeImpl: async (options) => {
      names = (options?.resourceLoaderOptions?.extensionFactories ?? []).flatMap((entry) =>
        typeof entry === "function" ? [] : [(entry as { name: string }).name],
      );
      return createAgentSessionRuntimeWithNpmFallback(options);
    },
  });
  const session = await supervisor.createSession({ workspaceId: "ws", path: workspacePath });
  t.after(() => supervisor.closeSession(session.ref));
  return names;
}

await test("the supervisor loads the hidden extension only when the host supplies a router", async (t) => {
  assert.equal(
    (await loadedExtensionNames(t, undefined)).includes("pi-gui-compaction-model-route"),
    false,
    "off by default",
  );
  assert.equal(
    (await loadedExtensionNames(t, () => undefined)).includes("pi-gui-compaction-model-route"),
    true,
  );
});
