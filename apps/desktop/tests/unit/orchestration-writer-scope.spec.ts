import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createChildThreadAction } from "../../electron/orchestration/orchestration-runtime";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import {
  analyzeWriteScope,
  parseWriteScope,
  scopesOverlap,
} from "../../electron/orchestration/writer-scope";

test("parseWriteScope trims, dedupes, and normalizes path tokens", () => {
  expect(parseWriteScope(undefined)).toEqual([]);
  expect(parseWriteScope("")).toEqual([]);
  expect(parseWriteScope("   ")).toEqual([]);
  expect(parseWriteScope("apps/desktop")).toEqual(["apps/desktop"]);
  expect(parseWriteScope("  apps/desktop  ")).toEqual(["apps/desktop"]);
  expect(parseWriteScope("./apps/desktop/")).toEqual(["apps/desktop"]);
  expect(parseWriteScope("Apps/Desktop")).toEqual(["apps/desktop"]);
  expect(parseWriteScope("apps/desktop, apps/desktop")).toEqual(["apps/desktop"]);
  expect(parseWriteScope("apps/desktop, packages/foo")).toEqual(["apps/desktop", "packages/foo"]);
  expect(parseWriteScope("apps/desktop packages/foo")).toEqual(["apps/desktop", "packages/foo"]);
});

// Observed live: the first scope claimed the whole workspace and the second
// was refused, shown as "users/honvl/pi-gui/.worktrees/lead-toggle-model".
const LIVE_WORKSPACE = "/Users/honvl/pi-gui";
const LIVE_WIDE_SCOPE =
  "/Users/honvl/pi-gui/.worktrees/subagent-lane (whole worktree; mainly apps/desktop renderer thread rail/sidebar, ...)";
const LIVE_NARROW_SCOPE = "/Users/honvl/pi-gui/.worktrees/lead-toggle-model";

test("absolute scopes inside the workspace become relative; asides do not widen them", () => {
  expect(analyzeWriteScope(LIVE_WIDE_SCOPE, LIVE_WORKSPACE)).toEqual({
    tokens: [".worktrees/subagent-lane"],
    outsideWorkspace: [],
  });
  expect(analyzeWriteScope(LIVE_NARROW_SCOPE, LIVE_WORKSPACE)).toEqual({
    tokens: [".worktrees/lead-toggle-model"],
    outsideWorkspace: [],
  });
  expect(
    scopesOverlap(
      parseWriteScope(LIVE_WIDE_SCOPE, LIVE_WORKSPACE),
      parseWriteScope(LIVE_NARROW_SCOPE, LIVE_WORKSPACE),
    ),
  ).toBe(false);
  expect(parseWriteScope(`${LIVE_WORKSPACE}/apps/desktop/src/`, LIVE_WORKSPACE)).toEqual([
    "apps/desktop/src",
  ]);
  // Without a workspace an absolute path keeps its slash instead of turning relative.
  expect(parseWriteScope(LIVE_NARROW_SCOPE)).toEqual([
    "/users/honvl/pi-gui/.worktrees/lead-toggle-model",
  ]);
});

test("absolute scopes outside the workspace are reported, never claimed", () => {
  const worktree = "/Users/honvl/pi-gui/.worktrees/subagent-lane";
  expect(analyzeWriteScope(LIVE_NARROW_SCOPE, worktree)).toEqual({
    tokens: [],
    outsideWorkspace: [LIVE_NARROW_SCOPE],
  });
  expect(analyzeWriteScope("apps/a, ../elsewhere", worktree)).toEqual({
    tokens: ["apps/a"],
    outsideWorkspace: ["../elsewhere"],
  });
  // Naming the workspace root itself adds no narrower claim: whole workspace.
  expect(analyzeWriteScope(LIVE_WIDE_SCOPE, worktree)).toEqual({
    tokens: [],
    outsideWorkspace: [],
  });
});

test("prose-only scopes claim the whole workspace; one real path narrows them", () => {
  expect(parseWriteScope("mainly the renderer thread rail")).toEqual([]);
  expect(parseWriteScope("(whole worktree; mainly apps/desktop)")).toEqual([]);
  expect(parseWriteScope("mainly apps/desktop renderer, and tests.")).toEqual(["apps/desktop"]);
  expect(parseWriteScope("docs, scripts")).toEqual(["docs", "scripts"]);
  expect(parseWriteScope("`apps/desktop/**` [not packages/]")).toEqual(["apps/desktop"]);
  expect(parseWriteScope("edit README.md and package.json only")).toEqual([
    "readme.md",
    "package.json",
  ]);
});

test("scopesOverlap treats empty as the whole workspace", () => {
  expect(scopesOverlap([], [])).toBe(true);
  expect(scopesOverlap([], ["apps/desktop"])).toBe(true);
  expect(scopesOverlap(["apps/desktop"], [])).toBe(true);
});

test("scopesOverlap matches identical and parent/child paths both directions", () => {
  expect(scopesOverlap(["apps/desktop"], ["apps/desktop"])).toBe(true);
  expect(scopesOverlap(["apps/desktop"], ["apps/desktop/src/x.ts"])).toBe(true);
  expect(scopesOverlap(["apps/desktop/src/x.ts"], ["apps/desktop"])).toBe(true);
  expect(scopesOverlap(["apps/desktop/src"], ["apps/desktop"])).toBe(true);
  expect(scopesOverlap(["apps/desktop"], ["apps/desktop/src"])).toBe(true);
});

test("scopesOverlap rejects disjoint siblings and segment-prefix lookalikes", () => {
  expect(scopesOverlap(["apps/desktop/src"], ["apps/server/src"])).toBe(false);
  expect(scopesOverlap(["apps/desktop/src"], ["apps/desktop/electron"])).toBe(false);
  // Segment-aware: "apps/desktop" must not cover "apps/desktop2".
  expect(scopesOverlap(["apps/desktop"], ["apps/desktop2"])).toBe(false);
  expect(scopesOverlap(["apps/desktop"], ["apps/desktop2/src/x.ts"])).toBe(false);
});

test("scopesOverlap normalizes case and ./ and trailing slashes", () => {
  expect(scopesOverlap(parseWriteScope("Apps/Desktop"), parseWriteScope("apps/desktop"))).toBe(
    true,
  );
  expect(
    scopesOverlap(parseWriteScope("./apps/desktop/"), parseWriteScope("apps/desktop/src/x.ts")),
  ).toBe(true);
  expect(scopesOverlap(parseWriteScope("APPS/DESKTOP/SRC"), parseWriteScope("apps/desktop"))).toBe(
    true,
  );
});

test("scopesOverlap fires when any token pair overlaps", () => {
  expect(scopesOverlap(["apps/server/src", "apps/desktop"], ["apps/desktop/src/x.ts"])).toBe(true);
  expect(
    scopesOverlap(["apps/server/src", "packages/foo"], ["apps/desktop", "packages/foo/src"]),
  ).toBe(true);
  expect(scopesOverlap(["apps/server/src", "packages/foo"], ["apps/desktop", "packages/bar"])).toBe(
    false,
  );
});

const createdAt = "2026-10-28T00:00:00.000Z";
const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
const prompt = "Do the scoped work.";

function seedChild(
  n: number,
  overrides?: Partial<OrchestrationChildThread>,
): OrchestrationChildThread {
  return {
    id: `seed-child-${n}`,
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: `child-session-${n}`,
    title: `Seed child ${n}`,
    goal: `Seed goal ${n}`,
    mode: "worker",
    depth: 1,
    status: "running",
    latestTranscript: `Seed goal ${n}`,
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function userMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "user", id, text, createdAt };
}

function assistantMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "assistant", id, text, createdAt };
}

interface WriterHostState {
  children: OrchestrationChildThread[];
  childStatus: "running" | "idle";
  childTranscript: TranscriptMessage[];
  /** Per-child session status override, by child session id. */
  sessionStatusById?: Record<string, "running" | "idle">;
  workspacePath?: string;
}

function makeHost(state: WriterHostState) {
  const createSessionCalls: string[] = [];
  const submitted: Array<{ sessionId: string; text: string }> = [];
  let counter = state.children.length;
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => {
        counter += 1;
        const sessionId = `spawned-${counter}`;
        createSessionCalls.push(sessionId);
        return {
          ref: { workspaceId: "ws", sessionId },
          title: `Spawned ${counter}`,
          preview: "",
          status: "running",
          updatedAt: createdAt,
        };
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
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
    workspaceRefFromState: () => ({ workspaceId: "ws", path: state.workspacePath ?? "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) => {
      if (ref.sessionId === parentRef.sessionId) {
        return { status: "running", title: "Parent", updatedAt: createdAt };
      }
      if (state.children.some((child) => child.childSessionId === ref.sessionId)) {
        const status = state.sessionStatusById?.[ref.sessionId] ?? state.childStatus;
        return { status, title: "Child", updatedAt: createdAt };
      }
      return undefined;
    },
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => false,
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultScoutThinkingLevel: () => undefined,
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) =>
      ref.sessionId === parentRef.sessionId ? [] : state.childTranscript,
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (ref: SessionRef, text: string) => {
      submitted.push({ sessionId: ref.sessionId, text });
      return {} as never;
    },
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, createSessionCalls, submitted, state };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

test("a second worker refuses while one is running, naming the blocker", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { title: "First writer", status: "running", mode: "worker" })],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/desktop",
    toolCallId: "call-second-writer",
  });

  expect(createSessionCalls).toHaveLength(0);
  expect(result.details.action).toBe(createChildThreadAction);
  expect(result.details.childThreadId).toBeUndefined();
  expect(result.details.error).toContain('Another worker is writing "apps/desktop"');
  expect(result.details.error).toContain('child "First writer"');
  expect(result.details.error).toContain("narrow your scope");
  expect(result.details.error).toContain("send it a follow-up");
  expect(resultText(result)).toContain('Another worker is writing "apps/desktop"');
});

test("a scout is allowed while a worker runs", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { status: "running", mode: "worker" })],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/desktop",
    toolCallId: "call-scout",
    mode: "scout",
  });

  expect(result.details.error).toBeUndefined();
  expect(result.details.childThreadId).toBeDefined();
  expect(createSessionCalls).toHaveLength(1);
});

test("a worker is allowed while only a scout runs", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { status: "running", mode: "scout" })],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Reading.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/desktop",
    toolCallId: "call-worker-past-scout",
    mode: "worker",
  });

  expect(result.details.error).toBeUndefined();
  expect(result.details.childThreadId).toBeDefined();
  expect(createSessionCalls).toHaveLength(1);
});

test("a worker is allowed once the running child is complete", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { status: "complete", mode: "worker" })],
    childStatus: "idle",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Done.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/desktop",
    toolCallId: "call-after-complete",
  });

  expect(result.details.error).toBeUndefined();
  expect(result.details.childThreadId).toBeDefined();
  expect(createSessionCalls).toHaveLength(1);
});

test("a worker is allowed once the running child has failed", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { status: "failed", mode: "worker" })],
    childStatus: "idle",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Broke.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/desktop",
    toolCallId: "call-after-failed",
  });

  expect(result.details.error).toBeUndefined();
  expect(result.details.childThreadId).toBeDefined();
  expect(createSessionCalls).toHaveLength(1);
});

test("a worker with no scope is blocked by an active worker too", async () => {
  // "No scope" means the whole workspace, so it must be the strictest case:
  // two unscoped writers are exactly the collision the rule exists to stop.
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { id: "w1", title: "First writer" })],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt)],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-unscoped",
  });
  // The refusal is a tool result, not a throw, so the lead reads it and adapts.
  expect(String(result.details.error)).toMatch(/Another worker is writing "the workspace"/);
  expect(createSessionCalls).toHaveLength(0);
});

test("a worker with no scope blocks a second scoped worker", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { title: "Whole-workspace writer", status: "running" })],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/desktop",
    toolCallId: "call-scoped-second",
  });

  expect(createSessionCalls).toHaveLength(0);
  expect(result.details.childThreadId).toBeUndefined();
  expect(result.details.error).toContain('Another worker is writing "apps/desktop"');
  expect(result.details.error).toContain('child "Whole-workspace writer"');
});

test("workers scoped to disjoint folders run concurrently", async () => {
  const { owner, createSessionCalls, state } = makeHost({
    children: [seedChild(1, { title: "Writer A", writeScopes: ["apps/a"] })],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "./Apps/B/",
    toolCallId: "call-disjoint-writer",
  });

  expect(result.details.error).toBeUndefined();
  expect(createSessionCalls).toHaveLength(1);
  // The new worker's claim is persisted on its record, normalized.
  const spawned = state.children.find((child) => child.id === result.details.childThreadId);
  expect(spawned?.writeScopes).toEqual(["apps/b"]);
});

test("a nested scope conflicts with its parent folder", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { title: "Writer A", writeScopes: ["apps/a"] })],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/a/src",
    toolCallId: "call-nested-writer",
  });

  expect(createSessionCalls).toHaveLength(0);
  expect(result.details.error).toContain('Another worker is writing "apps/a/src"');
  expect(result.details.error).toContain('child "Writer A"');
});

test("an unscoped worker conflicts with a scoped active worker", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [seedChild(1, { title: "Writer A", writeScopes: ["apps/a"] })],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-unscoped-vs-scoped",
  });

  expect(createSessionCalls).toHaveLength(0);
  expect(result.details.error).toContain('Another worker is writing "the workspace"');
});

test("an unscoped spawn records an empty claim, which blocks every later worker", async () => {
  const { owner, state } = makeHost({
    children: [],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const first = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-unscoped-first",
  });
  expect(first.details.error).toBeUndefined();
  expect(state.children[0]?.writeScopes).toEqual([]);
  // The stub session never reports running; mark the spawned worker active.
  state.children = state.children.map((child) => ({ ...child, status: "running" as const }));

  const second = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/b",
    toolCallId: "call-scoped-after-unscoped",
  });
  expect(second.details.error).toContain('Another worker is writing "apps/b"');
});

test("waking an idle worker whose scope overlaps an active worker is refused", async () => {
  const { owner, submitted } = makeHost({
    children: [
      seedChild(1, { title: "Active writer", status: "running", writeScopes: ["apps/a"] }),
      seedChild(2, { title: "Idle writer", status: "complete", writeScopes: ["apps/a/src"] }),
    ],
    childStatus: "idle",
    sessionStatusById: { "child-session-1": "running" },
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Done.")],
  });

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "seed-child-2",
    message: "Continue with the next step.",
  });

  expect(submitted).toHaveLength(0);
  expect(result.details.error).toContain('Another worker is writing "apps/a/src"');
  expect(result.details.error).toContain('child "Active writer"');
});

test("waking an idle worker with a disjoint scope delivers the message", async () => {
  const { owner, submitted } = makeHost({
    children: [
      seedChild(1, { title: "Active writer", status: "running", writeScopes: ["apps/a"] }),
      seedChild(2, { title: "Idle writer", status: "complete", writeScopes: ["apps/b"] }),
    ],
    childStatus: "idle",
    sessionStatusById: { "child-session-1": "running" },
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Done.")],
  });

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "seed-child-2",
    message: "Continue with the next step.",
  });

  expect(result.details.error).toBeUndefined();
  expect(submitted).toEqual([
    { sessionId: "child-session-2", text: "Continue with the next step." },
  ]);
});

test("waking an unscoped idle worker conflicts with any active worker", async () => {
  const { owner, submitted } = makeHost({
    children: [
      seedChild(1, { title: "Active writer", status: "running", writeScopes: ["apps/a"] }),
      // Saved before v20: no writeScopes, so it claims the whole workspace.
      seedChild(2, { title: "Legacy writer", status: "complete" }),
    ],
    childStatus: "idle",
    sessionStatusById: { "child-session-1": "running" },
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Done.")],
  });

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "seed-child-2",
    message: "Continue.",
  });

  expect(submitted).toHaveLength(0);
  expect(result.details.error).toContain('Another worker is writing "the workspace"');
});

test("steering a running worker skips the scope check: it already holds its slot", async () => {
  const { owner, submitted } = makeHost({
    children: [
      seedChild(1, { title: "Writer one", status: "running" }),
      seedChild(2, { title: "Writer two", status: "running" }),
    ],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "seed-child-2",
    message: "Also cover the edge case.",
  });

  expect(result.details.error).toBeUndefined();
  expect(submitted).toHaveLength(1);
});

test("the observed live scopes run as two concurrent workers", async () => {
  const { owner, createSessionCalls, state } = makeHost({
    children: [],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
    workspacePath: LIVE_WORKSPACE,
  });

  const wide = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: LIVE_WIDE_SCOPE,
    toolCallId: "call-live-wide",
  });
  expect(wide.details.error).toBeUndefined();
  expect(state.children[0]?.writeScopes).toEqual([".worktrees/subagent-lane"]);
  state.children = state.children.map((child) => ({ ...child, status: "running" as const }));

  const narrow = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: LIVE_NARROW_SCOPE,
    toolCallId: "call-live-narrow",
  });
  expect(narrow.details.error).toBeUndefined();
  expect(createSessionCalls).toHaveLength(2);
  const spawned = state.children.find((child) => child.id === narrow.details.childThreadId);
  expect(spawned?.writeScopes).toEqual([".worktrees/lead-toggle-model"]);
});

test("a worker scoped outside the workspace is refused with the path", async () => {
  const { owner, createSessionCalls } = makeHost({
    children: [],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt)],
    workspacePath: "/Users/honvl/pi-gui/.worktrees/subagent-lane",
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: LIVE_NARROW_SCOPE,
    toolCallId: "call-live-outside",
  });
  expect(createSessionCalls).toHaveLength(0);
  expect(result.details.error).toContain(
    `Scope path "${LIVE_NARROW_SCOPE}" is outside this workspace`,
  );
});
