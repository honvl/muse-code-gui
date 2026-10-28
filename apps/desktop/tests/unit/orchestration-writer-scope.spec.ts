import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createChildThreadAction } from "../../electron/orchestration/orchestration-runtime";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import { parseWriteScope, scopesOverlap } from "../../electron/orchestration/writer-scope";

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
}

function makeHost(state: WriterHostState) {
  const createSessionCalls: string[] = [];
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
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) => {
      if (ref.sessionId === parentRef.sessionId) {
        return { status: "running", title: "Parent", updatedAt: createdAt };
      }
      if (state.children.some((child) => child.childSessionId === ref.sessionId)) {
        return { status: state.childStatus, title: "Child", updatedAt: createdAt };
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
    submitComposerToSession: async () => ({}) as never,
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, createSessionCalls };
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
