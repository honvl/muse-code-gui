import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type { DesktopAppState, OrchestrationChildThread } from "../../contracts/desktop-state";
import { shouldDeferStreamingUiPublish } from "../../electron/conversation/streaming-ui-publisher";
import { stateForRenderer } from "../../electron/windows/renderer-state-projection";

const createdAt = "2026-10-27T20:00:00.000Z";

function child(overrides: Partial<OrchestrationChildThread> = {}): OrchestrationChildThread {
  return {
    id: "child-thread-1",
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: "child",
    title: "Trace the plumbing",
    goal: "Trace how completion is surfaced",
    mode: "scout",
    depth: 1,
    status: "running",
    latestTranscript: "worker output",
    transcript: [],
    evidence: [
      {
        id: "e1",
        childThreadId: "child-thread-1",
        kind: "worker_report",
        source: "worker-reported",
        status: "reported",
        title: "Worker reported output",
        detail: "a long evidence detail that the renderer never reads",
        parentSessionId: "parent",
        childSessionId: "child",
        createdAt,
      },
    ],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function stateWith(children: readonly OrchestrationChildThread[]): DesktopAppState {
  return { orchestrationChildren: children } as unknown as DesktopAppState;
}

/**
 * The projection is skipped for exactly the events the streaming publisher
 * defers: token-level text and the redundant running sessionUpdated that rides
 * with it. Anything that can change a child record must still project.
 */
test("only token-level ticks are exempt from orchestration projection", () => {
  const sessionRef: SessionRef = { workspaceId: "ws", sessionId: "child" };
  const runningTick = (runId: string, status = "running"): SessionDriverEvent =>
    ({
      type: "sessionUpdated",
      sessionRef,
      timestamp: createdAt,
      snapshot: { status, runningRunId: runId },
    }) as unknown as SessionDriverEvent;

  const isTokenLevel = (event: SessionDriverEvent, trackedRunId?: string) =>
    shouldDeferStreamingUiPublish(event, trackedRunId);

  // Token-level: deferred, so the orchestration projection is skipped.
  expect(
    isTokenLevel({ type: "assistantDelta", sessionRef, timestamp: createdAt, text: "hi" } as never),
  ).toBe(true);
  expect(
    isTokenLevel({
      type: "assistantThinkingDelta",
      sessionRef,
      timestamp: createdAt,
      text: "hi",
    } as never),
  ).toBe(true);
  expect(isTokenLevel(runningTick("run-1"), "run-1")).toBe(true);

  // A busy tool reporting partial output is token-level: coalesced, and it cannot
  // change a child record either. This was the burst behind the CPU spikes —
  // every tool progress report used to publish full state immediately.
  expect(isTokenLevel({ type: "toolUpdated", sessionRef, timestamp: createdAt } as never)).toBe(
    true,
  );

  // Structural: must still project.
  expect(isTokenLevel({ type: "toolFinished", sessionRef, timestamp: createdAt } as never)).toBe(
    false,
  );
  expect(isTokenLevel({ type: "toolStarted", sessionRef, timestamp: createdAt } as never)).toBe(
    false,
  );
  expect(isTokenLevel({ type: "runCompleted", sessionRef, timestamp: createdAt } as never)).toBe(
    false,
  );
  expect(isTokenLevel({ type: "runFailed", sessionRef, timestamp: createdAt } as never)).toBe(
    false,
  );
  // A new run id (Send after Stop) is structural, not a redundant tick.
  expect(isTokenLevel(runningTick("run-2"), "run-1")).toBe(false);
  // Any non-running status update settles the child and must project.
  expect(isTokenLevel(runningTick("run-1", "idle"), "run-1")).toBe(false);
  expect(isTokenLevel(runningTick("run-1", "failed"), "run-1")).toBe(false);
});

test("the renderer payload keeps identity fields and drops main-process data", () => {
  const cache = new WeakMap<
    readonly OrchestrationChildThread[],
    readonly OrchestrationChildThread[]
  >();
  const full = child();
  const projected = stateForRenderer(stateWith([full]), cache).orchestrationChildren[0];

  // Everything the sidebar reads survives.
  expect(projected?.id).toBe(full.id);
  expect(projected?.status).toBe(full.status);
  expect(projected?.mode).toBe(full.mode);
  expect(projected?.parentWorkspaceId).toBe(full.parentWorkspaceId);
  expect(projected?.parentSessionId).toBe(full.parentSessionId);
  expect(projected?.childWorkspaceId).toBe(full.childWorkspaceId);
  expect(projected?.childSessionId).toBe(full.childSessionId);
  expect(projected?.title).toBe(full.title);

  // The heavy fields never cross the IPC boundary.
  expect(projected?.evidence).toEqual([]);
  expect(projected?.transcript).toEqual([]);
  expect(projected?.goal).toBe("");
  // The short preview DOES cross it: the thread rail shows it as the running
  // child's live output. Only the transcript and evidence log are too heavy.
  expect(projected?.latestTranscript).toBe(full.latestTranscript);
  expect(projected?.latestTranscript.length).toBeLessThanOrEqual(240);

  // A long preview is clipped to the renderer budget, not forwarded whole.
  const longPreview = stateForRenderer(
    stateWith([{ ...full, latestTranscript: "x".repeat(1_000) }]),
    cache,
  ).orchestrationChildren[0];
  expect(longPreview?.latestTranscript).toHaveLength(240);

  // Main-process state is untouched: the caller still holds the full record.
  expect(full.evidence).toHaveLength(1);
  expect(full.latestTranscript).toBe("worker output");
});

test("an unchanged child list reuses one slim array so React memos stay valid", () => {
  const cache = new WeakMap<
    readonly OrchestrationChildThread[],
    readonly OrchestrationChildThread[]
  >();
  const children = [child(), child({ id: "child-thread-2", childSessionId: "child2" })];
  const first = stateForRenderer(stateWith(children), cache);
  const second = stateForRenderer(stateWith(children), cache);
  expect(second.orchestrationChildren).toBe(first.orchestrationChildren);
  // A new array identity (a real re-projection) produces a fresh slim array.
  const third = stateForRenderer(stateWith([...children]), cache);
  expect(third.orchestrationChildren).not.toBe(first.orchestrationChildren);
});

test("an empty child list is returned unchanged", () => {
  const cache = new WeakMap<
    readonly OrchestrationChildThread[],
    readonly OrchestrationChildThread[]
  >();
  const state = stateWith([]);
  expect(stateForRenderer(state, cache)).toBe(state);
});

test("the slim payload is orders of magnitude smaller than the full records", () => {
  const cache = new WeakMap<
    readonly OrchestrationChildThread[],
    readonly OrchestrationChildThread[]
  >();
  const heavy = child({
    goal: "x".repeat(4_000),
    latestTranscript: "y".repeat(4_000),
    evidence: Array.from({ length: 60 }, (_unused, index) => ({
      id: `e${index}`,
      childThreadId: "child-thread-1",
      kind: "worker_report" as const,
      source: "worker-reported" as const,
      status: "reported",
      title: "Worker reported output",
      detail: "z".repeat(1_000),
      parentSessionId: "parent",
      childSessionId: "child",
      createdAt,
    })),
  });
  const full = JSON.stringify(stateWith([heavy])).length;
  const slim = JSON.stringify(stateForRenderer(stateWith([heavy]), cache)).length;
  // ~64KB of evidence collapses to the handful of fields the renderer reads.
  expect(full).toBeGreaterThan(60_000);
  expect(slim).toBeLessThan(1_000);
});
