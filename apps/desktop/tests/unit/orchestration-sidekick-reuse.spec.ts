import { expect, test } from "@playwright/test";
import type {
  SessionModelSelection,
  SessionRef,
  SessionUsageSnapshot,
} from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import {
  createChildThreadAction,
  createChildThreadToolName,
  isFirstCreateChildThreadCallInTurn,
} from "../../electron/orchestration/orchestration-runtime";
import {
  DEFAULT_SIDEKICK_REUSE_WINDOW_MS,
  SIDEKICK_MAX_GENERATION,
  decideSidekickReuse,
  resolveSidekickReuseWindowMs,
  sidekickContextBudgetNote,
  type SidekickReuseCandidate,
} from "../../electron/orchestration/sidekick-reuse";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const WINDOW = DEFAULT_SIDEKICK_REUSE_WINDOW_MS;
const SIDEKICK: SessionModelSelection = { provider: "acme", modelId: "sidekick-1" };

function agoIso(ms: number, now = NOW): string {
  return new Date(now - ms).toISOString();
}

function child(n: number, overrides: Partial<OrchestrationChildThread> = {}) {
  return {
    id: `child-${n}`,
    parentWorkspaceId: "ws",
    parentSessionId: "lead",
    childWorkspaceId: "ws",
    childSessionId: `child-session-${n}`,
    title: `Sidekick ${n}`,
    goal: `Goal ${n}`,
    mode: "worker",
    depth: 1,
    status: "complete",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt: agoIso(60 * 60_000),
    updatedAt: agoIso(60_000),
    ...overrides,
  } satisfies OrchestrationChildThread;
}

function candidate(
  record: OrchestrationChildThread,
  overrides: Partial<Omit<SidekickReuseCandidate, "child">> = {},
): SidekickReuseCandidate {
  return { child: record, generation: 1, model: SIDEKICK, busy: false, ...overrides };
}

function decide(
  candidates: readonly SidekickReuseCandidate[],
  overrides: Partial<Parameters<typeof decideSidekickReuse>[0]> = {},
) {
  return decideSidekickReuse({
    parentWorkspaceId: "ws",
    parentSessionId: "lead",
    candidates,
    nowMs: NOW,
    windowMs: WINDOW,
    expectedModel: SIDEKICK,
    ...overrides,
  });
}

test("reuses the most recent idle worker inside the window", () => {
  const older = child(1, { updatedAt: agoIso(3 * 60_000) });
  const newer = child(2, { updatedAt: agoIso(30_000), status: "failed" });
  const decision = decide([candidate(older), candidate(newer)]);
  expect(decision).toEqual({ reuse: true, child: newer });
});

test("skips busy, active, scout, foreign, stale and exhausted children", () => {
  const cases: Array<[string, SidekickReuseCandidate]> = [
    ["busy", candidate(child(1), { busy: true })],
    ["running record", candidate(child(2, { status: "running" }))],
    ["queued record", candidate(child(3, { status: "queued" }))],
    ["scout", candidate(child(4, { mode: "scout" }))],
    ["other parent", candidate(child(5, { parentSessionId: "someone-else" }))],
    ["outside window", candidate(child(6, { updatedAt: agoIso(WINDOW + 1) }))],
    ["generation limit", candidate(child(7), { generation: SIDEKICK_MAX_GENERATION })],
    ["other model", candidate(child(8), { model: { provider: "acme", modelId: "frontier" } })],
    ["unknown model", candidate(child(9), { model: undefined })],
    ["legacy record", candidate(child(10, { childSessionId: "" }))],
    ["bad timestamp", candidate(child(11, { updatedAt: "not a date" }))],
  ];
  for (const [name, entry] of cases) {
    expect(decide([entry]), name).toEqual({ reuse: false, reason: "no-candidate" });
  }
});

test("worktree and shared-checkout children never take each other's briefs", () => {
  const worktreeChild = child(1, {
    updatedAt: agoIso(10_000),
    worktreePath: "/repo/.worktrees/child-1",
    branch: "child/child-1",
    baseCommit: "0123456789ab",
  });
  const sharedChild = child(2, { updatedAt: agoIso(60_000) });
  // A shared-checkout brief passes over the newer worktree child.
  expect(decide([candidate(worktreeChild), candidate(sharedChild)])).toEqual({
    reuse: true,
    child: sharedChild,
  });
  expect(decide([candidate(worktreeChild)])).toEqual({ reuse: false, reason: "no-candidate" });
  // A worktree brief only continues a worktree child.
  expect(decide([candidate(worktreeChild), candidate(sharedChild)], { worktree: true })).toEqual({
    reuse: true,
    child: worktreeChild,
  });
  expect(decide([candidate(sharedChild)], { worktree: true })).toEqual({
    reuse: false,
    reason: "no-candidate",
  });
});

test("the window edge is inclusive and a workspace-default lead accepts any model", () => {
  const edge = child(1, { updatedAt: agoIso(WINDOW) });
  expect(decide([candidate(edge)]).reuse).toBe(true);
  const otherModel = candidate(child(2), { model: { provider: "x", modelId: "y" } });
  expect(decide([otherModel], { expectedModel: undefined }).reuse).toBe(true);
});

test("an older idle worker is not used when the newest one is over budget", () => {
  const older = candidate(child(1, { updatedAt: agoIso(2 * 60_000) }));
  const full = candidate(child(2, { updatedAt: agoIso(10_000) }), {
    context: { tokens: 130_000, contextWindow: 200_000 },
  });
  expect(decide([older, full])).toEqual({
    reuse: false,
    reason: "context-budget",
    note: 'Started a fresh sidekick: "Sidekick 2" is at 65% of its context window.',
  });
});

test("fresh and parallel calls never reuse", () => {
  const ready = [candidate(child(1))];
  expect(decide(ready, { fresh: true })).toEqual({ reuse: false, reason: "fresh" });
  expect(decide(ready, { parallel: true })).toEqual({ reuse: false, reason: "parallel" });
});

test("context budget: 60% of the window or two compactions", () => {
  const at = (tokens: number | null) =>
    decide([candidate(child(1), { context: { tokens, contextWindow: 100_000 } })]);
  expect(at(60_000).reuse).toBe(true);
  expect(at(60_001)).toMatchObject({ reuse: false, reason: "context-budget" });
  // Null right after a compaction: unknown, not over budget.
  expect(at(null).reuse).toBe(true);
  expect(decide([candidate(child(1), { compactions: 1 })]).reuse).toBe(true);
  expect(decide([candidate(child(1), { compactions: 2 })])).toEqual({
    reuse: false,
    reason: "compactions",
    note: 'Started a fresh sidekick: "Sidekick 1" has compacted 2 times.',
  });
  expect(sidekickContextBudgetNote("S", undefined, undefined)).toBeUndefined();
  expect(sidekickContextBudgetNote("S", { tokens: 10, contextWindow: 0 }, 0)).toBeUndefined();
});

test("PI_APP_SIDEKICK_REUSE_WINDOW_MS overrides the window; 0 disables; junk is ignored", () => {
  expect(resolveSidekickReuseWindowMs({})).toBe(4 * 60_000);
  expect(resolveSidekickReuseWindowMs({ PI_APP_SIDEKICK_REUSE_WINDOW_MS: "90000" })).toBe(90_000);
  expect(resolveSidekickReuseWindowMs({ PI_APP_SIDEKICK_REUSE_WINDOW_MS: "0" })).toBe(0);
  expect(resolveSidekickReuseWindowMs({ PI_APP_SIDEKICK_REUSE_WINDOW_MS: "-5" })).toBe(WINDOW);
  expect(resolveSidekickReuseWindowMs({ PI_APP_SIDEKICK_REUSE_WINDOW_MS: "soon" })).toBe(WINDOW);
});

test("only the first create_child_thread call of an assistant message is first in turn", () => {
  const entries = new Map<string, Record<string, unknown>>([
    [
      "assistant",
      {
        id: "assistant",
        parentId: "user",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Splitting the work." },
            { type: "toolCall", id: "read-1", name: "read", arguments: {} },
            { type: "toolCall", id: "spawn-a", name: createChildThreadToolName, arguments: {} },
            { type: "toolCall", id: "spawn-b", name: createChildThreadToolName, arguments: {} },
          ],
        },
      },
    ],
    [
      "result-a",
      {
        id: "result-a",
        parentId: "assistant",
        type: "message",
        message: { role: "toolResult", toolCallId: "read-1", content: [] },
      },
    ],
  ]);
  const sessionManager = (leafId: string) =>
    ({
      getLeafEntry: () => entries.get(leafId),
      getEntry: (id: string) => entries.get(id),
    }) as unknown as Parameters<typeof isFirstCreateChildThreadCallInTurn>[0];

  expect(isFirstCreateChildThreadCallInTurn(sessionManager("assistant"), "spawn-a")).toBe(true);
  // Tool results appended before the call runs: walk back to the message.
  expect(isFirstCreateChildThreadCallInTurn(sessionManager("result-a"), "spawn-b")).toBe(false);
  expect(isFirstCreateChildThreadCallInTurn(sessionManager("assistant"), "unknown")).toBe(
    undefined,
  );
  expect(isFirstCreateChildThreadCallInTurn(undefined, "spawn-a")).toBe(undefined);
});

// ---- Owner integration: reuse goes through the follow-up path ----

const leadRef: SessionRef = { workspaceId: "ws", sessionId: "lead" };
const brief = "Implement the next slice.";

interface ReuseHostState {
  children: OrchestrationChildThread[];
  orchestrator?: boolean;
  usage?: SessionUsageSnapshot;
  compactions?: number;
  /** The thread's sidekick reasoning setting. */
  sidekickThinking?: string;
  /** The app-global default sidekick reasoning; the built-in xhigh when unset. */
  sidekickThinkingDefault?: "low" | "xhigh";
  /** The reused child's current reasoning level. */
  childThinking?: string;
  failThinkingChange?: boolean;
}

function makeHost(state: ReuseHostState) {
  const createSessionCalls: string[] = [];
  const thinkingChanges: Array<{ sessionId: string; level: string }> = [];
  const submitted: Array<{ sessionId: string; text: string }> = [];
  const runningSessions = new Set<string>();
  let counter = 0;
  const transcript: TranscriptMessage[] = [
    { kind: "message", role: "user", id: "u1", text: brief, createdAt: agoIso(0, Date.now()) },
    { kind: "message", role: "assistant", id: "a1", text: "Done.", createdAt: agoIso(0) },
  ];
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => {
        counter += 1;
        const sessionId = `spawned-${counter}`;
        createSessionCalls.push(sessionId);
        runningSessions.add(sessionId);
        return {
          ref: { workspaceId: "ws", sessionId },
          title: `Spawned ${counter}`,
          preview: "",
          status: "running",
          updatedAt: new Date().toISOString(),
        };
      },
      getSessionTree: async () => {
        // Async like the real driver, so parallel calls interleave here.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          nodes: Array.from({ length: state.compactions ?? 0 }, (_unused, index) => ({
            id: `c${index}`,
            parentId: null,
            kind: "compaction",
            timestamp: "",
            title: "Compaction",
          })),
        };
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
      setSessionThinkingLevel: async (ref: SessionRef, level: string) => {
        if (state.failThinkingChange) throw new Error("thinking change failed");
        thinkingChanges.push({ sessionId: ref.sessionId, level });
        state.childThinking = level;
      },
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "lead",
      workspaces: [],
      orchestrationChildren: state.children,
    }),
    replaceOrchestrationChildren: (next: readonly OrchestrationChildThread[]) => {
      state.children = [...next];
    },
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) => {
      if (ref.sessionId === leadRef.sessionId) {
        return { status: "running", title: "Lead", updatedAt: agoIso(0) };
      }
      return {
        status: runningSessions.has(ref.sessionId) ? "running" : "idle",
        title: "Child",
        updatedAt: agoIso(0),
      };
    },
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: (ref: SessionRef) =>
      (state.orchestrator ?? true) && ref.sessionId === leadRef.sessionId,
    sidekickModelFor: () => SIDEKICK,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => state.sidekickThinking,
    defaultSidekickThinkingLevel: () => state.sidekickThinkingDefault ?? "xhigh",
    defaultScoutThinkingLevel: () => undefined,
    sessionModelFor: (ref: SessionRef) =>
      ref.sessionId === leadRef.sessionId ? undefined : SIDEKICK,
    sessionThinkingLevelFor: (ref: SessionRef) =>
      ref.sessionId === leadRef.sessionId ? undefined : state.childThinking,
    sessionUsageFor: () => state.usage,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) => (ref.sessionId === leadRef.sessionId ? [] : transcript),
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (ref: SessionRef, text: string) => {
      submitted.push({ sessionId: ref.sessionId, text });
      runningSessions.add(ref.sessionId);
      return {} as never;
    },
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, createSessionCalls, submitted, state, thinkingChanges };
}

function idleSidekick(overrides: Partial<OrchestrationChildThread> = {}) {
  return child(1, { updatedAt: agoIso(30_000, Date.now()), ...overrides });
}

/** Deliveries to the idle sidekick (spawned children get their own first prompt). */
function toSidekick(submitted: ReadonlyArray<{ sessionId: string; text: string }>) {
  return submitted.filter((entry) => entry.sessionId === "child-session-1");
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

test("a sequential worker brief continues the idle sidekick as a follow-up", async () => {
  const { owner, createSessionCalls, submitted, state } = makeHost({
    children: [idleSidekick()],
  });

  const result = await owner.createChildThreadToolResult(leadRef, {
    prompt: brief,
    scope: "apps/desktop",
    toolCallId: "call-second-brief",
  });

  expect(createSessionCalls).toHaveLength(0);
  expect(submitted).toEqual([{ sessionId: "child-session-1", text: brief }]);
  expect(result.details).toMatchObject({
    action: createChildThreadAction,
    reused: true,
    childThreadId: "child-1",
    childSessionId: "child-session-1",
    generation: 2,
  });
  expect(resultText(result)).toContain("Reused sidekick child thread: Sidekick 1 (run 2)");
  expect(resultText(result)).toContain("fresh:true");
  // The new brief's scope is now the child's writer claim.
  expect(state.children[0]?.writeScopes).toEqual(["apps/desktop"]);
  expect(state.children).toHaveLength(1);
});

test("reuse is a continuation: it still works at the delegation budget", async () => {
  const previous = process.env.PI_APP_ORCHESTRATION_MAX_CHILDREN;
  process.env.PI_APP_ORCHESTRATION_MAX_CHILDREN = "1";
  try {
    const { owner, createSessionCalls } = makeHost({ children: [idleSidekick()] });
    const result = await owner.createChildThreadToolResult(leadRef, {
      prompt: brief,
      toolCallId: "call-at-budget",
    });
    expect(result.details.error).toBeUndefined();
    expect(result.details).toMatchObject({ reused: true, delegationsRemaining: 0 });
    expect(createSessionCalls).toHaveLength(0);
  } finally {
    if (previous === undefined) delete process.env.PI_APP_ORCHESTRATION_MAX_CHILDREN;
    else process.env.PI_APP_ORCHESTRATION_MAX_CHILDREN = previous;
  }
});

test("fresh:true, a later call of the same turn, scouts and solo parents spawn", async () => {
  const spawnCases: Array<[string, ReuseHostState, Record<string, unknown>]> = [
    ["fresh", { children: [idleSidekick()] }, { fresh: true }],
    ["not first in turn", { children: [idleSidekick()] }, { firstInTurn: false }],
    ["scout", { children: [idleSidekick()] }, { mode: "scout" }],
    ["solo parent", { children: [idleSidekick()], orchestrator: false }, {}],
  ];
  for (const [name, hostState, extra] of spawnCases) {
    const { owner, createSessionCalls, submitted } = makeHost(hostState);
    const result = await owner.createChildThreadToolResult(leadRef, {
      prompt: brief,
      toolCallId: `call-${name}`,
      ...extra,
    });
    expect(result.details.reused, name).toBeUndefined();
    expect(createSessionCalls, name).toHaveLength(1);
    expect(toSidekick(submitted), name).toHaveLength(0);
  }
});

test("parallel calls in one turn never collapse onto one sidekick", async () => {
  const { owner, createSessionCalls, submitted, state } = makeHost({
    children: [idleSidekick({ writeScopes: ["apps/a"] })],
  });

  const [first, second] = await Promise.all([
    owner.createChildThreadToolResult(leadRef, {
      prompt: brief,
      scope: "apps/a",
      toolCallId: "call-parallel-a",
    }),
    owner.createChildThreadToolResult(leadRef, {
      prompt: brief,
      scope: "apps/b",
      toolCallId: "call-parallel-b",
    }),
  ]);

  expect(first.details).toMatchObject({ reused: true, childThreadId: "child-1" });
  expect(second.details.reused).toBeUndefined();
  expect(second.details.error).toBeUndefined();
  expect(second.details.childThreadId).not.toBe("child-1");
  expect(toSidekick(submitted)).toHaveLength(1);
  expect(createSessionCalls).toHaveLength(1);
  expect(state.children).toHaveLength(2);
});

test("a parallel unscoped spawn sees the claimed sidekick as an active writer", async () => {
  const { owner, createSessionCalls } = makeHost({ children: [idleSidekick()] });

  const [first, second] = await Promise.all([
    owner.createChildThreadToolResult(leadRef, { prompt: brief, toolCallId: "call-claim-a" }),
    owner.createChildThreadToolResult(leadRef, { prompt: brief, toolCallId: "call-claim-b" }),
  ]);

  expect(first.details.reused).toBe(true);
  expect(second.details.error).toContain('Another worker is writing "the workspace"');
  expect(createSessionCalls).toHaveLength(0);
});

test("reuse faces the writer-scope check a fresh spawn would", async () => {
  const { owner, createSessionCalls, submitted, state } = makeHost({
    children: [
      idleSidekick(),
      child(2, { title: "Active writer", status: "running", writeScopes: ["apps/a"] }),
    ],
  });

  const blocked = await owner.createChildThreadToolResult(leadRef, {
    prompt: brief,
    scope: "apps/a/src",
    toolCallId: "call-overlap",
  });
  expect(blocked.details.error).toContain('Another worker is writing "apps/a/src"');
  expect(submitted).toHaveLength(0);
  expect(createSessionCalls).toHaveLength(0);
  // The refused claim left the idle sidekick untouched.
  expect(state.children[0]?.status).toBe("complete");
  expect(state.children[0]?.writeScopes).toBeUndefined();

  const allowed = await owner.createChildThreadToolResult(leadRef, {
    prompt: brief,
    scope: "apps/b",
    toolCallId: "call-disjoint",
  });
  expect(allowed.details).toMatchObject({ reused: true, childThreadId: "child-1" });
});

test("an over-budget sidekick is passed over with a one-line note", async () => {
  const contextCase = makeHost({
    children: [idleSidekick()],
    usage: {
      context: { tokens: 150_000, contextWindow: 200_000 },
      cache: {},
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      subscription: false,
    },
  });
  const overContext = await contextCase.owner.createChildThreadToolResult(leadRef, {
    prompt: brief,
    toolCallId: "call-over-context",
  });
  expect(contextCase.createSessionCalls).toHaveLength(1);
  expect(overContext.details.reuseNote).toBe(
    'Started a fresh sidekick: "Sidekick 1" is at 75% of its context window.',
  );
  expect(resultText(overContext)).toContain("is at 75% of its context window.");

  const compactedCase = makeHost({ children: [idleSidekick()], compactions: 2 });
  const compacted = await compactedCase.owner.createChildThreadToolResult(leadRef, {
    prompt: brief,
    toolCallId: "call-compacted",
  });
  expect(compactedCase.createSessionCalls).toHaveLength(1);
  expect(toSidekick(compactedCase.submitted)).toHaveLength(0);
  expect(compacted.details.reuseNote).toBe(
    'Started a fresh sidekick: "Sidekick 1" has compacted 2 times.',
  );
  // The released claim restored the old record.
  const old = compactedCase.state.children.find((entry) => entry.id === "child-1");
  expect(old?.status).toBe("complete");
});

test("the queued reuse claim survives a parent re-projection mid-delivery", async () => {
  const { owner, state } = makeHost({ children: [idleSidekick()] });

  const pending = owner.createChildThreadToolResult(leadRef, {
    prompt: brief,
    scope: "apps/a",
    toolCallId: "call-reproject",
  });
  // The reuse is parked on the async session-tree read: list_threads
  // re-projects the lead's children while the claim is held.
  await new Promise((resolve) => setTimeout(resolve, 1));
  owner.listThreadsToolResult(leadRef);
  expect(state.children[0]?.status).toBe("queued");
  expect(state.children[0]?.writeScopes).toEqual(["apps/a"]);

  const result = await pending;
  expect(result.details).toMatchObject({ reused: true, childThreadId: "child-1" });
  // Lead-mode reuse results never nudge toward polling.
  expect(resultText(result)).not.toMatch(/read_thread|wait_seconds/);
});

test("a reused sidekick takes the thread's reasoning effort before the brief", async () => {
  // Distinct children: generations are module-level and earlier tests reused child-1.
  const idleSidekickN = (n: number) => child(n, { updatedAt: agoIso(30_000, Date.now()) });
  const changed = makeHost({
    children: [idleSidekickN(21)],
    sidekickThinking: "high",
    childThinking: "low",
  });
  const result = await changed.owner.createChildThreadToolResult(leadRef, {
    prompt: brief,
    toolCallId: "call-thinking-change",
  });
  expect(result.details).toMatchObject({ reused: true, childThreadId: "child-21" });
  expect(changed.thinkingChanges).toEqual([{ sessionId: "child-session-21", level: "high" }]);
  expect(changed.createSessionCalls).toHaveLength(0);

  // No thread setting: the reused child takes the default sidekick reasoning,
  // the same resolution a fresh worker gets.
  for (const [n, state, level] of [
    [25, { childThinking: "low" }, "xhigh"],
    [26, { childThinking: "high", sidekickThinkingDefault: "low" }, "low"],
  ] as const) {
    const defaulted = makeHost({ children: [idleSidekickN(n)], ...state });
    await defaulted.owner.createChildThreadToolResult(leadRef, {
      prompt: brief,
      toolCallId: "call-thinking-default",
    });
    expect(defaulted.thinkingChanges).toEqual([{ sessionId: `child-session-${n}`, level }]);
    expect(defaulted.createSessionCalls).toHaveLength(0);
  }

  // Already at the resolved level: the child is left as it is.
  for (const [n, state] of [
    [22, { sidekickThinking: "high", childThinking: "high" }],
    [23, { childThinking: "xhigh" }],
  ] as const) {
    const unchanged = makeHost({ children: [idleSidekickN(n)], ...state });
    await unchanged.owner.createChildThreadToolResult(leadRef, {
      prompt: brief,
      toolCallId: "call-thinking-same",
    });
    expect(unchanged.thinkingChanges).toEqual([]);
    expect(unchanged.createSessionCalls).toHaveLength(0);
  }

  // Applying the effort fails: a fresh child spawns instead, and the idle
  // sidekick keeps its record.
  const failing = makeHost({
    children: [idleSidekickN(24)],
    sidekickThinking: "high",
    childThinking: "low",
    failThinkingChange: true,
  });
  const fallback = await failing.owner.createChildThreadToolResult(leadRef, {
    prompt: brief,
    toolCallId: "call-thinking-fails",
  });
  expect(fallback.details).not.toMatchObject({ reused: true });
  expect(failing.createSessionCalls).toHaveLength(1);
  expect(failing.submitted.map((entry) => entry.sessionId)).toEqual(["spawned-1"]);
  expect(failing.state.children.find((entry) => entry.id === "child-24")?.status).toBe("complete");
});
