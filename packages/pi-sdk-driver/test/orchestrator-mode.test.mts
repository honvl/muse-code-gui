import assert from "node:assert/strict";
import test from "node:test";
import {
  ORCHESTRATOR_ALLOWED_TOOLS,
  ORCHESTRATOR_SYSTEM_PROMPT,
  SOLO_SYSTEM_GUIDELINE,
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
  assert.match(lines[1] ?? "", /delegate by default/i);
  assert.match(lines[1] ?? "", /parallel/i);
  assert.match(lines[2] ?? "", /one-line fixes/i);
  assert.match(lines[2] ?? "", /worker child with a one-line brief/i);
  assert.match(lines[2] ?? "", /writer rule/i);
  assert.match(lines[3] ?? "", /stranger/i);
  assert.match(lines[3] ?? "", /what NOT to do/i);
  assert.match(lines[4] ?? "", /report back automatically/i);
  assert.match(lines[4] ?? "", /do not poll/i);
  assert.match(lines[4] ?? "", /take the work back/i);
  assert.match(lines[5] ?? "", /keep your own context small/i);
  assert.match(lines[5] ?? "", /line ranges/i);
  assert.match(lines[5] ?? "", /never dump a whole file/i);
  assert.match(lines[0] ?? "", /never re-run a suite/i);
  assert.match(lines[0] ?? "", /reading the diff/i);
});

await test("lead prompt teaches reusing a live child instead of always spawning fresh", () => {
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /reuse a child/i,
    "prompt must teach reusing a child whose context covers the work",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /send_message_to_thread/,
    "reuse rule must name send_message_to_thread as the continue path",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /list_threads/,
    "reuse rule must name list_threads to find the child",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /preserves context\/cache/i,
    "prompt must make the context/cache tradeoff explicit",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /parallel\/independent slices/i,
    "prompt must scope fresh spawns to parallel/independent work",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /drifted|out of scope/i,
    "prompt must scope fresh spawns to drifted or out-of-scope children",
  );
});

await test("lead prompt treats a child report as a claim requiring verification", () => {
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /a report is a claim, not proof/i,
    "prompt must teach that a report is a claim, not proof",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /verify by reading the diff/i,
    "prompt must require checking the diff/files before signoff",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /success criteria/i,
    "prompt must require checking the brief's success criteria",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /never re-run a suite/i,
    "prompt must not spend lead tokens re-running a child's validation",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /scout review/i,
    "prompt must delegate risky reviews to a read-only scout",
  );
});

await test("lead prompt names every delegation tool and teaches lead-first behavior", () => {
  for (const tool of ORCHESTRATOR_ALLOWED_TOOLS) {
    assert.ok(ORCHESTRATOR_SYSTEM_PROMPT.includes(tool), `prompt must name ${tool}`);
  }
  assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /delegate/i, "prompt must teach delegation-first");
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /your own hands are for reading/i,
    "prompt must limit the lead's own hands to reads and one-line fixes",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /wait or narrow scope instead of doing the edit yourself/i,
    "prompt must route writer-rule blocks to waiting or narrower scope, not lead edits",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /do not poll/i,
    "prompt must forbid polling read_thread",
  );
});

await test("lead prompt teaches scout read-only shell", () => {
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /scouts may run read-only shell commands/i,
    "scout guidance must grant read-only shell",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /cannot edit, write, or mutate/i,
    "scout guidance must still forbid edits and writes",
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

await test("lead extension allows the first mutations at tool_call", async () => {
  const { pi, handlers } = makeMockPi();
  await createOrchestratorModeExtension(() => true)(pi as never);
  const toolCall = handlers["tool_call"];
  assert.ok(toolCall, "tool_call handler registered");
  // The soft gate only trips past the limit: three direct mutations pass.
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

await test("solo mode leaves tools untouched and adds only the solo guideline", async () => {
  const { pi, handlers, activeToolsCalls } = makeMockPi();
  await createOrchestratorModeExtension(() => false)(pi as never);
  const event = makePromptEvent();
  const before = handlers["before_agent_start"];
  assert.ok(before, "before_agent_start handler registered");
  await before(event as never, mockCtx as never);
  // The switch changes policy, not capability: solo threads keep their tools
  // and gain no loadout call, but the model is told to work here by default.
  assert.deepEqual(event.systemPromptOptions.selectedTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(activeToolsCalls, []);
  assert.deepEqual(event.systemPromptOptions.sections, {});
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, [SOLO_SYSTEM_GUIDELINE]);
  assert.match(SOLO_SYSTEM_GUIDELINE, /Solo mode/);
  assert.match(SOLO_SYSTEM_GUIDELINE, /create_child_thread/);
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

async function makeLeadHarness(sessionId: string, enabled = true) {
  const { pi, handlers } = makeMockPi();
  await createOrchestratorModeExtension(() => enabled)(pi as never);
  const before = handlers["before_agent_start"];
  const toolCall = handlers["tool_call"];
  assert.ok(before, "before_agent_start handler registered");
  assert.ok(toolCall, "tool_call handler registered");
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  await before(makePromptEvent() as never, ctx as never);
  const call = (event: unknown) =>
    (toolCall as (e: never, c: never) => Promise<unknown>)(event as never, ctx as never);
  const rerun = () => before(makePromptEvent() as never, ctx as never);
  return { call, rerun };
}

function editCall(path: string, id: string) {
  return { toolName: "edit", input: { path, edits: [] }, toolCallId: id };
}

await test("lead soft gate blocks the 4th direct mutation and names create_child_thread", async () => {
  const { call } = await makeLeadHarness("lead-gate-block");
  assert.equal(await call(editCall("apps/a/x.ts", "c1")), undefined);
  assert.equal(await call(editCall("apps/a/y.ts", "c2")), undefined);
  assert.equal(await call(editCall("apps/a/z.ts", "c3")), undefined);
  const blocked = (await call(editCall("apps/a/w.ts", "c4"))) as
    { block?: boolean; reason?: string } | undefined;
  assert.equal(blocked?.block, true, "4th mutation must block");
  assert.match(blocked?.reason ?? "", /create_child_thread/);
  assert.match(blocked?.reason ?? "", /3 direct edits/);
});

await test("read-only bash, reads, and delegation tools never consume the mutation budget", async () => {
  const { call } = await makeLeadHarness("lead-gate-readonly");
  const freeCalls: unknown[] = [
    { toolName: "bash", input: { command: "rg foo" } },
    { toolName: "bash", input: { command: "git log --oneline" } },
    { toolName: "bash", input: { command: "ls apps" } },
    { toolName: "read", input: { path: "apps/a/x.ts" } },
    { toolName: "grep", input: { pattern: "foo" } },
    { toolName: "find", input: { path: "apps" } },
    { toolName: "ls", input: { path: "apps" } },
    ...ORCHESTRATOR_ALLOWED_TOOLS.map((toolName) => ({ toolName })),
  ];
  for (const event of freeCalls) {
    assert.equal(await call(event), undefined);
  }
  assert.equal(await call(editCall("apps/a/x.ts", "c1")), undefined);
  assert.equal(await call(editCall("apps/a/y.ts", "c2")), undefined);
  assert.equal(await call(editCall("apps/a/z.ts", "c3")), undefined, "3rd mutation still allowed");
  const blocked = (await call(editCall("apps/a/w.ts", "c4"))) as
    { block?: boolean; reason?: string } | undefined;
  assert.equal(blocked?.block, true, "budget is exactly 3: the 4th mutation blocks");
});

await test("PI_APP_LEAD_DIRECT_MUTATION_LIMIT overrides the gate; junk falls back to 3", async () => {
  process.env.PI_APP_LEAD_DIRECT_MUTATION_LIMIT = "1";
  try {
    const { call } = await makeLeadHarness("lead-gate-env-1");
    assert.equal(await call(editCall("apps/a/x.ts", "c1")), undefined);
    const blocked = (await call(editCall("apps/a/y.ts", "c2"))) as
      { block?: boolean; reason?: string } | undefined;
    assert.equal(blocked?.block, true, "limit 1 must block the 2nd mutation");
    assert.match(blocked?.reason ?? "", /1 direct edits/);
  } finally {
    delete process.env.PI_APP_LEAD_DIRECT_MUTATION_LIMIT;
  }
  for (const junk of ["abc", "0", "-3"]) {
    process.env.PI_APP_LEAD_DIRECT_MUTATION_LIMIT = junk;
    try {
      const { call } = await makeLeadHarness(`lead-gate-env-junk-${junk}`);
      assert.equal(await call(editCall("apps/a/x.ts", "c1")), undefined);
      assert.equal(await call(editCall("apps/a/y.ts", "c2")), undefined);
      assert.equal(await call(editCall("apps/a/z.ts", "c3")), undefined);
      const blocked = (await call(editCall("apps/a/w.ts", "c4"))) as
        { block?: boolean; reason?: string } | undefined;
      assert.equal(blocked?.block, true, `junk ${junk} must fall back to 3`);
      assert.match(blocked?.reason ?? "", /3 direct edits/);
    } finally {
      delete process.env.PI_APP_LEAD_DIRECT_MUTATION_LIMIT;
    }
  }
});

await test("solo mode never blocks direct mutations", async () => {
  const { call } = await makeLeadHarness("lead-gate-solo", false);
  for (let i = 1; i <= 5; i++) {
    assert.equal(
      await call(editCall(`apps/a/file-${i}.ts`, `c${i}`)),
      undefined,
      `solo edit ${i} must pass`,
    );
  }
});

await test("before_agent_start resets the mutation budget for a new run", async () => {
  const { call, rerun } = await makeLeadHarness("lead-gate-reset");
  assert.equal(await call(editCall("apps/a/x.ts", "c1")), undefined);
  assert.equal(await call(editCall("apps/a/y.ts", "c2")), undefined);
  assert.equal(await call(editCall("apps/a/z.ts", "c3")), undefined);
  assert.equal(
    ((await call(editCall("apps/a/w.ts", "c4"))) as { block?: boolean } | undefined)?.block,
    true,
  );
  await rerun();
  assert.equal(await call(editCall("apps/a/x.ts", "c5")), undefined);
  assert.equal(await call(editCall("apps/a/y.ts", "c6")), undefined);
  assert.equal(await call(editCall("apps/a/z.ts", "c7")), undefined, "new run allows 3 more");
  assert.equal(
    ((await call(editCall("apps/a/w.ts", "c8"))) as { block?: boolean } | undefined)?.block,
    true,
  );
});
