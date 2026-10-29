import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type { DesktopAppState, TranscriptMessage } from "../../contracts/desktop-state";
import {
  appendAssistantDelta,
  appendUserMessage,
  applyTimelineEvent,
} from "../../electron/conversation/app-store-timeline";
import { applySessionEventState } from "../../electron/conversation/app-store-session-state";
import {
  childCompletionReportText,
  childThreadFinalDetail,
} from "../../electron/orchestration/app-store-orchestration";

const createdAt = "2026-10-29T00:00:00.000Z";
const childRef: SessionRef = { workspaceId: "ws", sessionId: "child" };
const runId = "run-muse-1";
const finalText = "Routing rules for sidekick children. Result: route meta/* to Muse CLI.";

/**
 * A stub Muse driver replays the fixed per-turn sequence through the real
 * store appliers: user prompt, running sessionUpdated, tool rows, one
 * assistant bubble with the final text, then exactly one runCompleted.
 * Mirrors the driver event-sequence test in
 * packages/muse-cli-driver/test/muse-child-turn.test.mts.
 */
function driveMuseTurn(): {
  state: DesktopAppState;
  transcript: readonly TranscriptMessage[];
} {
  const cache = new Map<string, readonly TranscriptMessage[]>();
  const active = new Map<string, string>();
  const runtime = {
    runMetricsBySession: new Map(),
    runningSinceBySession: new Map(),
    activeAssistantMessageBySession: active,
    pendingAssistantMessageBySession: new Map<string, string>(),
    activeWorkingActivityBySession: new Map<string, string>(),
    extensionToolLabels: () => new Map<string, string>(),
  };
  let state = {
    workspaces: [{ id: "ws", sessions: [{ id: "child", status: "idle" }] }],
    revision: 0,
  } as unknown as DesktopAppState;

  const apply = (event: SessionDriverEvent): void => {
    // The store appends token-level deltas before the timeline applier, which
    // intentionally no-ops them (see handleSessionEvent in app-store.ts).
    if (event.type === "assistantDelta" || event.type === "assistantThinkingDelta") {
      appendAssistantDelta(
        cache,
        runtime.activeAssistantMessageBySession,
        event.sessionRef,
        event.text,
        event.timestamp,
      );
      return;
    }
    applyTimelineEvent(cache, event, runtime);
    state = applySessionEventState(state, event, cache, runtime.runningSinceBySession, new Map());
  };

  appendUserMessage(cache, childRef, "Read sidekick-runtime.ts and report the routing rules.");
  const updated = (status: "running" | "idle", runningRunId?: string): SessionDriverEvent =>
    ({
      type: "sessionUpdated",
      sessionRef: childRef,
      timestamp: createdAt,
      snapshot: { status, ...(runningRunId ? { runningRunId } : {}) },
    }) as unknown as SessionDriverEvent;
  apply(updated("running", runId));
  const midTurnStatus = (state.workspaces[0]?.sessions[0] as { status: string } | undefined)
    ?.status;
  apply({
    type: "toolStarted",
    sessionRef: childRef,
    timestamp: createdAt,
    toolName: "read_file",
    callId: "call-1",
  } as unknown as SessionDriverEvent);
  apply({
    type: "toolFinished",
    sessionRef: childRef,
    timestamp: createdAt,
    callId: "call-1",
    success: true,
  } as unknown as SessionDriverEvent);
  apply({
    type: "assistantMessageStarted",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
  } as unknown as SessionDriverEvent);
  apply({
    type: "assistantDelta",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
    text: finalText,
  } as unknown as SessionDriverEvent);
  apply({
    type: "assistantMessageEnded",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
  } as unknown as SessionDriverEvent);
  apply({
    type: "runCompleted",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
    snapshot: { status: "idle", preview: finalText },
  } as unknown as SessionDriverEvent);

  return { state, transcript: cache.get("ws:child") ?? [] };
}

function lastAssistantText(transcript: readonly TranscriptMessage[]): string | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === "message" && item.role === "assistant" && item.text.trim()) {
      return item.text;
    }
  }
  return undefined;
}

test("a Muse child turn reads running mid-turn and keeps its final text", () => {
  const { transcript } = driveMuseTurn();
  // Tool rows stream; the single assistant bubble carries the final text.
  expect(transcript.some((item) => item.kind === "tool")).toBe(true);
  expect(lastAssistantText(transcript)).toBe(finalText);
});

test("a Muse child session is running until runCompleted, then idle", () => {
  const cache = new Map<string, readonly TranscriptMessage[]>();
  const runtime = {
    runMetricsBySession: new Map(),
    runningSinceBySession: new Map(),
    activeAssistantMessageBySession: new Map<string, string>(),
    pendingAssistantMessageBySession: new Map<string, string>(),
    activeWorkingActivityBySession: new Map<string, string>(),
    extensionToolLabels: () => new Map<string, string>(),
  };
  let state = {
    workspaces: [{ id: "ws", sessions: [{ id: "child", status: "idle" }] }],
    revision: 0,
  } as unknown as DesktopAppState;
  const status = (): string =>
    (state.workspaces[0]?.sessions[0] as { status: string } | undefined)?.status ?? "";
  const running = {
    type: "sessionUpdated",
    sessionRef: childRef,
    timestamp: createdAt,
    snapshot: { status: "running", runningRunId: runId },
  } as unknown as SessionDriverEvent;
  applyTimelineEvent(cache, running, runtime);
  state = applySessionEventState(state, running, cache, runtime.runningSinceBySession, new Map());
  // The child reads `running` (never `complete`) while the run is in flight.
  expect(status()).toBe("running");
  const done = {
    type: "runCompleted",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
    snapshot: { status: "idle", preview: finalText },
  } as unknown as SessionDriverEvent;
  applyTimelineEvent(cache, done, runtime);
  state = applySessionEventState(state, done, cache, runtime.runningSinceBySession, new Map());
  expect(status()).toBe("idle");
});

test("the lead report for a Muse child carries the final text", () => {
  const { transcript } = driveMuseTurn();
  const body = lastAssistantText(transcript);
  const report = childCompletionReportText(
    { id: "child-1", title: "Sidekick worker", goal: "Report the routing rules", status: "complete" },
    "complete",
    body,
    undefined,
    1,
    true,
  );
  expect(report).toContain(finalText);
  expect(
    childThreadFinalDetail({ title: "Sidekick worker", status: "complete" }),
  ).toBe('Child thread "Sidekick worker" completed.');
});
