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
  assert.match(lines[3] ?? "", /keep briefs short/i);
  assert.match(lines[3] ?? "", /explores, verifies, and retries/i);
  assert.doesNotMatch(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /stranger/i,
    "the old prescriptive brief rule is gone",
  );
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

await test("lead prompt offers worktree isolation for overlapping parallel writers once", () => {
  const lines = ORCHESTRATOR_SYSTEM_PROMPT.split("\n");
  assert.match(lines[3] ?? "", /isolation:"worktree"/);
  assert.match(lines[3] ?? "", /which you land yourself/i);
  assert.equal(ORCHESTRATOR_SYSTEM_PROMPT.split('isolation:"worktree"').length - 1, 1);
});

await test("lead prompt says the host reuses the sidekick and fresh:true opts out", () => {
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /the host reuses your sidekick automatically/i,
    "prompt must say the host continues the sidekick on its own",
  );
  assert.doesNotMatch(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /reuse a child/i,
    "the lead no longer picks a child to reuse by hand",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /preserves context\/cache/i,
    "prompt must make the context/cache tradeoff explicit",
  );
  assert.match(
    ORCHESTRATOR_SYSTEM_PROMPT,
    /fresh:true for parallel\/independent slices/i,
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
  // 1a: delegation strategy lives only in the orchestrator_mode section, so
  // the lead adds no per-run guideline and the cached prefix stays small.
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, []);
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
  const toolResult = handlers["tool_result"];
  assert.ok(toolResult, "tool_result handler registered");
  const call = (event: unknown) =>
    (toolCall as (e: never, c: never) => Promise<unknown>)(event as never, ctx as never);
  const result = (chars: number, extra: Record<string, unknown> = {}) =>
    (toolResult as (e: never, c: never) => Promise<unknown>)(
      { toolName: "read", content: [{ type: "text", text: "x".repeat(chars) }], ...extra } as never,
      ctx as never,
    );
  const rerun = () => before(makePromptEvent() as never, ctx as never);
  return { call, result, rerun };
}

function bashCall(command: string) {
  return { toolName: "bash", input: { command } };
}

type GateResult = { block?: boolean; reason?: string } | undefined;

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
  assert.match(blocked?.reason ?? "", /Direct-work limit reached: 3 /);
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
    assert.match(blocked?.reason ?? "", /Direct-work limit reached: 1 /);
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
      assert.match(blocked?.reason ?? "", /Direct-work limit reached: 3 /);
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

await test("cd-prefixed reads and diagnostics never spend the direct-work budget", async () => {
  const { call } = await makeLeadHarness("lead-gate-cd-reads");
  for (let i = 0; i < 10; i++) {
    assert.equal(await call(bashCall(`cd /repo && sed -n '${i},+40p' src/a.ts`)), undefined);
    assert.equal(
      await call(bashCall("cd /repo\ngit log --oneline -3\necho ---\nps -eo pid")),
      undefined,
    );
  }
  assert.equal(await call(editCall("apps/a/x.ts", "c1")), undefined);
  assert.equal(await call(editCall("apps/a/y.ts", "c2")), undefined);
  assert.equal(await call(editCall("apps/a/z.ts", "c3")), undefined, "reads left all 3 slots");
});

await test("test/build runs share the budget and the block names what was counted", async () => {
  const { call } = await makeLeadHarness("lead-gate-verification");
  assert.equal(await call(editCall("apps/a/x.ts", "c1")), undefined);
  assert.equal(
    await call(bashCall("cd /repo && pnpm --filter @pi-gui/desktop run typecheck")),
    undefined,
  );
  assert.equal(await call(bashCall("rm -rf apps/a/dist")), undefined);
  const blocked = (await call(bashCall("cd /repo && cargo test -p core"))) as GateResult;
  assert.equal(blocked?.block, true, "4th counted action must block");
  const reason = blocked?.reason ?? "";
  assert.match(reason, /Direct-work limit reached: 3 /);
  assert.match(reason, /edit apps\/a\/x\.ts; pnpm --filter @pi-gui\/desktop run typecheck/);
  assert.match(reason, /rm -rf apps\/a\/dist/);
  assert.match(reason, /remaining test\/build runs/);
  assert.match(reason, /mode "worker" and scope "apps\/a\/x\.ts"/);
  assert.match(reason, /Reads stay free/);
});

await test("read budget bounces one exploratory call to a scout, then lets reads through", async () => {
  process.env.PI_APP_LEAD_READ_BUDGET_CHARS = "1000";
  try {
    const { call, result } = await makeLeadHarness("lead-gate-read-budget");
    assert.equal(await call(bashCall("rg -n foo src")), undefined);
    await result(600);
    assert.equal(await call({ toolName: "read", input: { path: "src/a.ts" } }), undefined);
    await result(600);
    const nudged = (await call(bashCall("cd /repo && sed -n '1,400p' src/b.ts"))) as GateResult;
    assert.equal(nudged?.block, true, "first read past the budget is bounced");
    assert.match(nudged?.reason ?? "", /about 1k characters/);
    assert.match(nudged?.reason ?? "", /mode "scout"/);
    assert.match(nudged?.reason ?? "", /repeat it and it will run/);
    assert.equal(
      await call(bashCall("cd /repo && sed -n '1,400p' src/b.ts")),
      undefined,
      "the repeated targeted read runs",
    );
    for (const toolName of ["read_thread", "create_child_thread", "send_message_to_thread"]) {
      assert.equal(await call({ toolName }), undefined, `${toolName} is never nudged`);
    }
    await result(999);
    assert.equal(await call({ toolName: "grep", input: { pattern: "x" } }), undefined);
    await result(1);
    assert.equal(
      ((await call({ toolName: "grep", input: { pattern: "x" } })) as GateResult)?.block,
      true,
      "another budget's worth nudges again",
    );
    assert.equal(
      await call(editCall("apps/a/x.ts", "c1")),
      undefined,
      "edits use their own budget",
    );
  } finally {
    delete process.env.PI_APP_LEAD_READ_BUDGET_CHARS;
  }
});

await test("lead prompt teaches rescue for stuck children once", async () => {
  const lines = ORCHESTRATOR_SYSTEM_PROMPT.split("\n");
  assert.equal(lines.length, 6, "lead prompt must have exactly six rules");
  assert.match(
    lines[4] ?? "",
    /stuck on one tool call/i,
    "prompt must name the stuck-tool rescue case",
  );
  assert.match(
    lines[4] ?? "",
    /rescue:true/,
    "prompt must teach the rescue flag",
  );
  assert.equal(
    ORCHESTRATOR_SYSTEM_PROMPT.split("rescue:true").length - 1,
    1,
    "the rescue flag must appear exactly once",
  );
});

await test("lead prompt contains each policy sentence exactly once", async () => {
  const { pi, handlers } = makeMockPi();
  await createOrchestratorModeExtension(() => true)(pi as never);
  const event = makePromptEvent();
  const before = handlers["before_agent_start"];
  assert.ok(before, "before_agent_start handler registered");
  await before(event as never, mockCtx as never);
  const assembled = [
    ...event.systemPromptOptions.promptGuidelines,
    ...Object.values(event.systemPromptOptions.sections),
  ].join("\n");
  const sentences = ORCHESTRATOR_SYSTEM_PROMPT.split("\n");
  assert.equal(sentences.length, 6, "lead prompt must have exactly six rules");
  for (const sentence of sentences) {
    const occurrences = assembled.split(sentence).length - 1;
    assert.equal(
      occurrences,
      1,
      `lead prompt must contain each policy sentence exactly once: ${sentence.slice(0, 60)}…`,
    );
  }
});

/** Lead-only delegation phrases: present in the lead section, absent from the solo guideline. */
const LEAD_STRATEGY_PHRASES = [
  "Delegate by default",
  "expensive resource",
  "Spawn one child thread per independent part",
  "Keep briefs short",
  "report back automatically",
  "do not poll",
  "poll read_thread",
  "take the work back",
  "verify by reading the diff",
  "never re-run a suite",
  "Never dump a whole file",
  "one-line brief",
  "disjoint scopes",
  "writer rule",
  "Keep your own context small",
  "own the plan",
  "final review",
  "scout review",
  "preserves context/cache",
];

await test("solo and child prompts contain no delegation-strategy text", async () => {
  // Child sessions never enable orchestrator mode, so they share the solo path.
  for (const name of ["solo-session", "child-session"]) {
    const { pi, handlers } = makeMockPi();
    await createOrchestratorModeExtension(() => false)(pi as never);
    const event = makePromptEvent();
    const before = handlers["before_agent_start"];
    assert.ok(before, "before_agent_start handler registered");
    await before(event as never, { sessionManager: { getSessionId: () => name } } as never);
    assert.deepEqual(event.systemPromptOptions.sections, {}, `${name} gains no prompt section`);
    assert.deepEqual(
      event.systemPromptOptions.promptGuidelines,
      [SOLO_SYSTEM_GUIDELINE],
      `${name} keeps only the solo guideline`,
    );
    const assembled = event.systemPromptOptions.promptGuidelines.join("\n");
    for (const phrase of LEAD_STRATEGY_PHRASES) {
      assert.equal(
        assembled.includes(phrase),
        false,
        `${name} prompt must not contain delegation-strategy text: ${phrase}`,
      );
    }
  }
  // The phrases above are non-vacuous: the lead prompt contains each of them.
  const leadSentences = ORCHESTRATOR_SYSTEM_PROMPT;
  for (const phrase of LEAD_STRATEGY_PHRASES) {
    assert.ok(
      leadSentences.includes(phrase),
      `lead prompt must contain the strategy phrase under test: ${phrase}`,
    );
  }
});

await test("read budget ignores nested tool output, resets per run, and skips solo threads", async () => {
  process.env.PI_APP_LEAD_READ_BUDGET_CHARS = "100";
  try {
    const lead = await makeLeadHarness("lead-gate-read-reset");
    await lead.result(5000, { parentToolCallId: "outer" });
    assert.equal(
      await lead.call(bashCall("rg foo")),
      undefined,
      "nested output is the tool's work",
    );
    await lead.result(150);
    assert.equal(((await lead.call(bashCall("rg foo"))) as GateResult)?.block, true);
    await lead.rerun();
    assert.equal(await lead.call(bashCall("rg foo")), undefined, "a new run starts a fresh budget");

    const solo = await makeLeadHarness("lead-gate-read-solo", false);
    await solo.result(5000);
    assert.equal(await solo.call(bashCall("rg foo")), undefined);
  } finally {
    delete process.env.PI_APP_LEAD_READ_BUDGET_CHARS;
  }
});
