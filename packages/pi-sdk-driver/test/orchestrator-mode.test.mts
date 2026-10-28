import assert from "node:assert/strict";
import test from "node:test";
import {
  ORCHESTRATOR_ALLOWED_TOOLS,
  ORCHESTRATOR_SYSTEM_PROMPT,
  createOrchestratorModeExtension,
} from "../dist/orchestrator-mode.js";
import { SessionSupervisor } from "../dist/session-supervisor.js";

await test("delegation tool names are still exported for prompt text", () => {
  assert.deepEqual([...ORCHESTRATOR_ALLOWED_TOOLS].sort(), [
    "create_child_thread",
    "list_threads",
    "read_thread",
    "send_message_to_thread",
  ]);
});

await test("lead prompt covers the six lead rules in order", () => {
  const lines = ORCHESTRATOR_SYSTEM_PROMPT.split("\n");
  assert.equal(lines.length, 6, "lead prompt must have exactly six rules");
  assert.match(lines[0] ?? "", /you own the plan/i);
  assert.match(lines[0] ?? "", /final review/i);
  assert.match(lines[1] ?? "", /delegate first/i);
  assert.match(lines[1] ?? "", /parallel/i);
  assert.match(lines[2] ?? "", /do it yourself/i);
  assert.match(lines[2] ?? "", /trivial/i);
  assert.match(lines[3] ?? "", /stranger/i);
  assert.match(lines[3] ?? "", /what NOT to do/i);
  assert.match(lines[4] ?? "", /report back automatically/i);
  assert.match(lines[4] ?? "", /do not poll/i);
  assert.match(lines[4] ?? "", /take the work back/i);
  assert.match(lines[5] ?? "", /keep your own context small/i);
});

await test("lead prompt names every delegation tool and teaches lead-first behavior", () => {
  for (const tool of ORCHESTRATOR_ALLOWED_TOOLS) {
    assert.ok(ORCHESTRATOR_SYSTEM_PROMPT.includes(tool), `prompt must name ${tool}`);
  }
  assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /delegate/i, "prompt must teach delegation-first");
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /do it yourself/i,
    "prompt must teach the do-it-yourself-when-small rule",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /do not poll/i,
    "prompt must forbid polling read_thread",
  );
});

const ALL_TOOLS = [
  { name: "read", exposure: "direct" },
  { name: "bash", exposure: "direct" },
  { name: "edit", exposure: "direct" },
  { name: "write", exposure: "direct" },
  { name: "grep", exposure: "direct" },
  { name: "create_child_thread", exposure: "direct" },
  { name: "list_threads", exposure: "direct" },
  { name: "read_thread", exposure: "direct" },
  { name: "send_message_to_thread", exposure: "direct" },
  { name: "model_only_helper", exposure: "model-only" },
  { name: "codemode_shadow", exposure: "codemode" },
  { name: "deferred_loader", exposure: "deferred" },
  { name: "pi_gui_hidden", exposure: "hidden" },
];

function makeMockPi() {
  const handlers: Record<string, (...args: never[]) => unknown> = {};
  const activeToolsCalls: string[][] = [];
  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers[event] = handler;
    },
    getAllTools: () => ALL_TOOLS,
    setActiveTools: (names: string[]) => {
      activeToolsCalls.push(names);
    },
  };
  return { pi, handlers, activeToolsCalls };
}

function makePromptEvent() {
  return {
    systemPromptOptions: {
      selectedTools: ["read", "bash", "edit", "write"],
      promptGuidelines: [] as string[],
      sections: {} as Record<string, string>,
    },
  };
}

const mockCtx = { sessionManager: { getSessionId: () => "pi-1" } };

await test("lead extension restores pi's default loadout to defeat a resumed cage", async () => {
  const { pi, handlers, activeToolsCalls } = makeMockPi();
  await createOrchestratorModeExtension(() => true)(pi as never);
  const event = makePromptEvent();
  const before = handlers["before_agent_start"];
  assert.ok(before, "before_agent_start handler registered");
  await before(event as never, mockCtx as never);
  assert.equal(activeToolsCalls.length, 1, "lead mode must re-assert tools every run");
  const restored = activeToolsCalls[0] ?? [];
  for (const name of ["read", "bash", "edit", "write", "create_child_thread"]) {
    assert.ok(restored.includes(name), `restored set must include ${name}`);
  }
  assert.ok(
    restored.includes("model_only_helper"),
    "model-only tools are declarable per pi's _isDeclarable rule",
  );
  assert.ok(!restored.includes("pi_gui_hidden"), "hidden tools must stay out");
  assert.ok(
    !restored.includes("codemode_shadow"),
    "codemode-exposure tools are not default-active and must stay out",
  );
  assert.ok(
    !restored.includes("deferred_loader"),
    "deferred-exposure tools are not default-active and must stay out",
  );
  assert.ok(
    restored.length > ORCHESTRATOR_ALLOWED_TOOLS.length,
    "restored set must be the default loadout, not the 4-tool cage",
  );
  assert.ok(
    event.systemPromptOptions.sections["orchestrator_mode"]?.includes("create_child_thread"),
    "lead section injected",
  );
  assert.equal(event.systemPromptOptions.promptGuidelines.length, 1);
  assert.match(
    event.systemPromptOptions.promptGuidelines[0] ?? "",
    /delegate/i,
    "guideline must teach delegation",
  );
});

await test("lead extension blocks nothing at tool_call", async () => {
  const { pi, handlers } = makeMockPi();
  await createOrchestratorModeExtension(() => true)(pi as never);
  const toolCall = handlers["tool_call"];
  assert.ok(toolCall, "tool_call handler registered");
  for (const tool of [
    ...ORCHESTRATOR_ALLOWED_TOOLS,
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "codemode",
  ]) {
    assert.equal(
      await toolCall({ toolName: tool } as never, mockCtx as never),
      undefined,
      `tool_call must not block ${tool}`,
    );
  }
});

await test("lead extension leaves prompt and tools untouched when disabled", async () => {
  const { pi, handlers, activeToolsCalls } = makeMockPi();
  await createOrchestratorModeExtension(() => false)(pi as never);
  const event = makePromptEvent();
  const before = handlers["before_agent_start"];
  assert.ok(before, "before_agent_start handler registered");
  await before(event as never, mockCtx as never);
  assert.deepEqual(event.systemPromptOptions.selectedTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(activeToolsCalls, []);
  assert.deepEqual(event.systemPromptOptions.sections, {});
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, []);
  const toolCall = handlers["tool_call"];
  assert.ok(toolCall, "tool_call handler registered");
  assert.equal(await toolCall({ toolName: "read" } as never, mockCtx as never), undefined);
});

function makeCountingCatalog() {
  const writes: string[] = [];
  return {
    writes,
    sessions: {
      upsertSession: async (entry: { title: string }) => {
        writes.push(entry.title);
      },
      getSession: async () => {
        throw new Error("must not reopen for an active record");
      },
    },
    workspaces: {
      getWorkspace: async () => {
        throw new Error("must not reopen for an active record");
      },
    },
    setSessionFile: async () => undefined,
  };
}

function makeOrchestratorRecord(emitted: Array<{ type: string }>) {
  const sessionManager = {
    getSessionId: () => "pi-1",
    buildSessionContext: () => ({ thinkingLevel: "off", model: null }),
  };
  return {
    ref: { workspaceId: "ws-1", sessionId: "sess-1" },
    workspace: { workspaceId: "ws-1", path: "/tmp/ws-1", displayName: "ws-1" },
    title: "orchestrator probe",
    status: "idle",
    updatedAt: new Date().toISOString(),
    archivedAt: undefined,
    preview: undefined,
    config: undefined,
    runningRunId: undefined,
    queuedMessages: [],
    closed: false,
    session: { sessionManager },
    listeners: new Set([
      (event: { type: string }) => {
        emitted.push(event);
      },
    ]),
  };
}

await test("setSessionOrchestratorMode is idempotent: redundant calls write nothing", async () => {
  const catalog = makeCountingCatalog();
  const supervisor = new SessionSupervisor({
    catalogStorage: catalog as never,
  });
  const emitted: Array<{ type: string }> = [];
  const record = makeOrchestratorRecord(emitted);
  const key = `${record.ref.workspaceId}:${record.ref.sessionId}`;
  (supervisor as unknown as { records: Map<string, unknown> }).records.set(key, record);

  await supervisor.setSessionOrchestratorMode(record.ref, true);
  assert.equal(catalog.writes.length, 1);
  assert.equal(emitted.length, 1);
  assert.equal(
    (record as { config?: { orchestratorMode?: boolean } }).config?.orchestratorMode,
    true,
  );

  await supervisor.setSessionOrchestratorMode(record.ref, true);
  assert.equal(catalog.writes.length, 1, "second enable must not persist again");
  assert.equal(emitted.length, 1, "second enable must not emit again");

  await supervisor.setSessionOrchestratorMode(record.ref, false);
  assert.equal(catalog.writes.length, 2);
  assert.equal(emitted.length, 2);
  assert.equal(
    (record as { config?: { orchestratorMode?: boolean } }).config?.orchestratorMode,
    undefined,
  );

  await supervisor.setSessionOrchestratorMode(record.ref, false);
  assert.equal(catalog.writes.length, 2, "second disable must not persist again");
  assert.equal(emitted.length, 2, "second disable must not emit again");
});

await test("setSessionSidekickModel is idempotent: redundant calls write nothing", async () => {
  const catalog = makeCountingCatalog();
  const supervisor = new SessionSupervisor({
    catalogStorage: catalog as never,
  });
  const emitted: Array<{ type: string }> = [];
  const record = makeOrchestratorRecord(emitted);
  const key = `${record.ref.workspaceId}:${record.ref.sessionId}`;
  (supervisor as unknown as { records: Map<string, unknown> }).records.set(key, record);

  await supervisor.setSessionSidekickModel(record.ref, {
    provider: "acme",
    modelId: "sidekick-1",
  });
  assert.equal(catalog.writes.length, 1);
  assert.equal(emitted.length, 1);
  assert.deepEqual(
    (record as { config?: { sidekick?: { provider: string; modelId: string } } }).config?.sidekick,
    { provider: "acme", modelId: "sidekick-1" },
  );

  await supervisor.setSessionSidekickModel(record.ref, {
    provider: "acme",
    modelId: "sidekick-1",
  });
  assert.equal(catalog.writes.length, 1, "second set must not persist again");
  assert.equal(emitted.length, 1, "second set must not emit again");

  await supervisor.setSessionSidekickModel(record.ref, undefined);
  assert.equal(catalog.writes.length, 2);
  assert.equal(emitted.length, 2);
  assert.equal(
    (record as { config?: { sidekick?: { provider: string; modelId: string } } }).config?.sidekick,
    undefined,
  );

  await supervisor.setSessionSidekickModel(record.ref, undefined);
  assert.equal(catalog.writes.length, 2, "second clear must not persist again");
  assert.equal(emitted.length, 2, "second clear must not emit again");
});
