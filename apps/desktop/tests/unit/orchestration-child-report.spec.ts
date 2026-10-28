import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import {
  childCompletionReportText,
  createOrchestrationOwner,
} from "../../electron/orchestration/app-store-orchestration";

const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
const childRef: SessionRef = { workspaceId: "ws", sessionId: "child" };
const createdAt = "2026-10-27T20:00:00.000Z";

function childRecord(overrides: Partial<OrchestrationChildThread> = {}): OrchestrationChildThread {
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
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function assistantMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "assistant", id, text, createdAt };
}

interface HostState {
  child: OrchestrationChildThread;
  status: string;
  orchestrator: boolean;
  transcript: TranscriptMessage[];
  error?: string;
  childStatus?: OrchestrationChildThread["status"];
}

function makeHost(state: HostState) {
  const sent: Array<{
    sessionRef: SessionRef;
    input: { customType: string; text: string; display?: boolean };
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" };
  }> = [];
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => {
        throw new Error("not used");
      },
      setChildIsolation: () => {},
      sendCustomMessage: async (
        sessionRef: SessionRef,
        input: { customType: string; text: string; display?: boolean },
        options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
      ) => {
        sent.push({ sessionRef, input, ...(options ? { options } : {}) });
      },
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [],
      orchestrationChildren: [
        state.childStatus ? { ...state.child, status: state.childStatus } : state.child,
      ],
    }),
    replaceOrchestrationChildren: () => {},
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === childRef.sessionId
        ? { status: state.status, title: state.child.title, updatedAt: createdAt }
        : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: (ref: SessionRef) =>
      ref.sessionId === parentRef.sessionId && state.orchestrator,
    sidekickModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) =>
      ref.sessionId === childRef.sessionId ? state.transcript : [],
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => state.error,
    setSessionError: () => {},
    submitComposerToSession: async () => ({}) as never,
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, sent };
}

test("a finished child reports to its orchestrator exactly once per run", async () => {
  const state: HostState = {
    child: childRecord(),
    status: "idle",
    orchestrator: true,
    transcript: [assistantMessage("m1", "Found the completion path in app-store.ts.")],
  };
  const { owner, sent } = makeHost(state);

  await owner.reportChildCompletion(childRef);
  await owner.reportChildCompletion(childRef);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.sessionRef).toEqual(parentRef);
  expect(sent[0]?.input.customType).toBe("pi-gui.child-report");
  expect(sent[0]?.input.display).toBe(true);
  expect(sent[0]?.input.text).toContain('Child thread "Trace the plumbing" finished.');
  expect(sent[0]?.input.text).toContain("thread_id: child-thread-1");
  expect(sent[0]?.input.text).toContain("Found the completion path in app-store.ts.");
  expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });

  // A follow-up re-run clears the entry, then its own finish reports again.
  state.status = "running";
  await owner.reportChildCompletion(childRef);
  state.status = "idle";
  state.transcript = [assistantMessage("m2", "Second run finished.")];
  await owner.reportChildCompletion(childRef);

  expect(sent).toHaveLength(2);
  expect(sent[1]?.input.text).toContain("Second run finished.");
});

test("a non-orchestrator parent is not woken by child reports", async () => {
  const state: HostState = {
    child: childRecord(),
    status: "idle",
    orchestrator: false,
    transcript: [assistantMessage("m1", "done")],
  };
  const { owner, sent } = makeHost(state);

  await owner.reportChildCompletion(childRef);

  expect(sent).toHaveLength(0);
});

test("a child that never started a run is not reported", async () => {
  const state: HostState = {
    child: childRecord({ status: "queued" }),
    status: "idle",
    orchestrator: true,
    transcript: [],
  };
  const { owner, sent } = makeHost(state);

  await owner.reportChildCompletion(childRef);

  expect(sent).toHaveLength(0);
});

test("a failed child reports its failure and the fallback text", async () => {
  const state: HostState = {
    child: childRecord({ status: "failed" }),
    status: "failed",
    orchestrator: true,
    transcript: [assistantMessage("m1", "partial work")],
    error: "provider rejected the request",
    childStatus: "failed",
  };
  const { owner, sent } = makeHost(state);

  await owner.reportChildCompletion(childRef);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.input.text).toContain("failed.");
  expect(sent[0]?.input.text).toContain("status: failed");
  expect(sent[0]?.input.text).toContain("error: provider rejected the request");
});

test("report text falls back when the child produced no answer", () => {
  const report = childCompletionReportText(childRecord({ status: "failed" }), "failed", "  ");

  expect(report).toContain("No final answer: the child run failed.");
});

test("report text marks a text-less success unverified and names read_thread", () => {
  const report = childCompletionReportText(childRecord(), "complete", undefined);

  expect(report).toContain('read_thread("child-thread-1")');
  expect(report).toContain("unverified");
});

test("report text carries the session error for a failed run", () => {
  const report = childCompletionReportText(childRecord(), "failed", undefined, "boom");

  expect(report).toContain("error: boom");
  expect(report).toContain("No final answer: the child run failed.");
});

test("report text carries the handoff generation when known", () => {
  const report = childCompletionReportText(childRecord(), "complete", "done", undefined, 2);

  expect(report).toContain("thread_id: child-thread-1 (run 2)");
});

test("report text omits the run marker when the generation is unknown", () => {
  const report = childCompletionReportText(childRecord(), "complete", "done");

  expect(report).toContain("thread_id: child-thread-1\n");
  expect(report).not.toContain("(run ");
});

test("report text marks host-side truncation explicitly", () => {
  const report = childCompletionReportText(childRecord(), "complete", `R${"e".repeat(5000)}`);

  expect(report).toContain("…(report truncated; call read_thread for detail)");
  expect(report).not.toContain("e".repeat(5000));
});

test("lead reports drop the goal the lead wrote itself", () => {
  const report = childCompletionReportText(childRecord(), "complete", "done", undefined, 1, true);

  expect(report).not.toContain("goal:");
  expect(report).not.toContain("Trace how completion is surfaced");
  expect(report).toContain('Child thread "Trace the plumbing" finished.');
  expect(report).toContain("thread_id: child-thread-1 (run 1)");
  expect(report).toContain("status: complete");
});

test("non-lead reports keep the goal line", () => {
  const report = childCompletionReportText(childRecord(), "complete", "done");

  expect(report).toContain("goal: Trace how completion is surfaced");
});
