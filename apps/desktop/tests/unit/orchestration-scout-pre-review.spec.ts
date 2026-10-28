import { expect, test } from "@playwright/test";
import type { SessionRef, SessionSnapshot } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import {
  CHILD_REPORT_SUFFIX,
  WORKER_SELF_CHECK,
  composeChildBrief,
} from "../../electron/orchestration/orchestration-runtime";
import {
  DEFAULT_SCOUT_PRE_REVIEW_TIMEOUT_MS,
  SCOUT_PRE_REVIEW_BRIEF_OPENING,
  SCOUT_PRE_REVIEW_CALL_PREFIX,
  SCOUT_VERDICT_LIMIT,
  changedFilesFromLatestRun,
  combinedPreReviewReportText,
  isScoutPreReviewEnabled,
  resolveScoutPreReviewTimeoutMs,
  scoutPreReviewBrief,
  shouldPreReviewWorkerRun,
  workerBriefFromTranscript,
} from "../../electron/orchestration/scout-pre-review";

const createdAt = "2026-10-28T20:00:00.000Z";

function user(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "user", id, text, createdAt };
}
function assistant(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "assistant", id, text, createdAt };
}
function tool(
  callId: string,
  toolName: string,
  input: unknown,
  status: "running" | "success" | "error" = "success",
): TranscriptMessage {
  return { kind: "tool", id: callId, callId, toolName, status, label: toolName, input, createdAt };
}

test.describe("pure decision and composition", () => {
  test("the flag defaults on; 0/false/off disable it", () => {
    expect(isScoutPreReviewEnabled({})).toBe(true);
    expect(isScoutPreReviewEnabled({ PI_APP_SCOUT_PRE_REVIEW: "1" })).toBe(true);
    for (const off of ["0", "false", "OFF", " 0 "]) {
      expect(isScoutPreReviewEnabled({ PI_APP_SCOUT_PRE_REVIEW: off })).toBe(false);
    }
    expect(resolveScoutPreReviewTimeoutMs({})).toBe(DEFAULT_SCOUT_PRE_REVIEW_TIMEOUT_MS);
    expect(resolveScoutPreReviewTimeoutMs({ PI_APP_SCOUT_PRE_REVIEW_TIMEOUT_MS: "250" })).toBe(250);
    expect(resolveScoutPreReviewTimeoutMs({ PI_APP_SCOUT_PRE_REVIEW_TIMEOUT_MS: "-5" })).toBe(
      DEFAULT_SCOUT_PRE_REVIEW_TIMEOUT_MS,
    );
  });

  test("changed files come from successful edit/write/apply_patch rows of the latest run", () => {
    const transcript = [
      user("u1", "first brief"),
      tool("t0", "write", { path: "old-run.ts" }),
      assistant("a1", "done"),
      user("u2", "follow-up"),
      tool("t1", "edit", { path: "/ws/src/a.ts" }),
      tool("t2", "edit", { path: "./src/a.ts" }),
      tool("t3", "write", { file_path: "src/b.ts" }),
      tool("t4", "write", { path: "src/failed.ts" }, "error"),
      tool("t5", "read", { path: "src/read-only.ts" }),
      tool("t6", "bash", { command: "sed -i s/a/b/ src/c.ts" }),
      tool("t7", "apply_patch", {
        input: "*** Begin Patch\n*** Update File: src/d.ts\n*** Add File: src/e.ts\n*** End Patch",
      }),
    ];
    expect(changedFilesFromLatestRun(transcript, "/ws/")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/d.ts",
      "src/e.ts",
    ]);
    expect(changedFilesFromLatestRun([tool("t1", "edit", { path: "a.ts" })])).toEqual(["a.ts"]);
  });

  test("only a Lead's cleanly completed multi-file worker run is pre-reviewed", () => {
    const base = {
      enabled: true,
      parentIsLead: true,
      mode: "worker" as const,
      status: "complete" as const,
      depth: 1,
      changedFiles: ["a.ts", "b.ts"],
    };
    expect(shouldPreReviewWorkerRun(base)).toBe(true);
    expect(shouldPreReviewWorkerRun({ ...base, mode: undefined })).toBe(true);
    expect(shouldPreReviewWorkerRun({ ...base, enabled: false })).toBe(false);
    expect(shouldPreReviewWorkerRun({ ...base, parentIsLead: false })).toBe(false);
    // Scouts, including the review scout itself, are never reviewed.
    expect(shouldPreReviewWorkerRun({ ...base, mode: "scout" })).toBe(false);
    expect(shouldPreReviewWorkerRun({ ...base, status: "failed" })).toBe(false);
    expect(shouldPreReviewWorkerRun({ ...base, error: "boom" })).toBe(false);
    expect(shouldPreReviewWorkerRun({ ...base, changedFiles: ["a.ts"] })).toBe(false);
    // The review scout must fit under the depth limit as the worker's child.
    expect(shouldPreReviewWorkerRun({ ...base, depth: 3 })).toBe(false);
  });

  test("the review brief quotes the worker brief without the host contract", () => {
    const composed = composeChildBrief({ prompt: "Rename the helper.", scope: "src" });
    const brief = workerBriefFromTranscript([user("u1", composed)], "goal");
    expect(brief.startsWith("Rename the helper.")).toBe(true);
    expect(brief).toContain("Scope: src");
    expect(brief).not.toContain(WORKER_SELF_CHECK);
    expect(brief).not.toContain(CHILD_REPORT_SUFFIX);
    expect(workerBriefFromTranscript([], "  the goal ")).toBe("the goal");

    const prompt = scoutPreReviewBrief({
      workerTitle: "Rename",
      brief,
      changedFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(prompt.startsWith(SCOUT_PRE_REVIEW_BRIEF_OPENING)).toBe(true);
    expect(prompt).toContain("src/a.ts, src/b.ts");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain("~400 characters");
    expect(prompt).toContain(brief);
  });

  test("the combined report keeps the worker report and adds a capped verdict", () => {
    const combined = combinedPreReviewReportText("WORKER REPORT", {
      kind: "verdict",
      scoutThreadId: "scout-1",
      verdict: "Verdict: needs attention\nHunks: src/a.ts:12 - missing null check",
    });
    expect(combined.startsWith("WORKER REPORT\n\n")).toBe(true);
    expect(combined).toContain("Scout pre-review (thread_id: scout-1):");
    expect(combined).toContain("src/a.ts:12 - missing null check");
    expect(combined).toContain("Read only the hunks it flags.");

    const long = combinedPreReviewReportText("W", {
      kind: "verdict",
      scoutThreadId: "s",
      verdict: "x".repeat(SCOUT_VERDICT_LIMIT + 50),
    });
    expect(long).toContain(`${"x".repeat(SCOUT_VERDICT_LIMIT)}…(verdict truncated)`);
    expect(long).not.toContain("x".repeat(SCOUT_VERDICT_LIMIT + 1));

    expect(combinedPreReviewReportText("W", { kind: "unavailable", reason: "timeout" })).toBe(
      "W\n\nScout pre-review timed out; review the diff yourself.",
    );
    expect(combinedPreReviewReportText("W", { kind: "unavailable", reason: "failed" })).toContain(
      "pre-review failed",
    );
  });
});

const leadRef: SessionRef = { workspaceId: "ws", sessionId: "lead" };
const workerRef: SessionRef = { workspaceId: "ws", sessionId: "worker" };
const scoutRef: SessionRef = { workspaceId: "ws", sessionId: "scout" };
const workerBrief = composeChildBrief({ prompt: "Rename the helper." });
const VERDICT = "Verdict: needs attention\nHunks: src/b.ts:3 - stale import";

interface FlowState {
  children: OrchestrationChildThread[];
  transcripts: Map<string, TranscriptMessage[]>;
  sent: Array<{ sessionRef: SessionRef; text: string; triggerTurn?: boolean }>;
  scoutPrompts: string[];
  cancelled: string[];
  spawnFails: boolean;
  scoutAnswers: boolean;
}

function workerRecord(): OrchestrationChildThread {
  return {
    id: "worker-thread",
    parentWorkspaceId: "ws",
    parentSessionId: "lead",
    childWorkspaceId: "ws",
    childSessionId: "worker",
    title: "Rename the helper",
    goal: "Rename the helper.",
    mode: "worker",
    depth: 1,
    status: "complete",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function makeFlowHost(state: FlowState) {
  const host = {
    driver: {
      cancelCurrentRun: async (ref: SessionRef) => {
        state.cancelled.push(ref.sessionId);
      },
      createSession: async (): Promise<SessionSnapshot> => {
        if (state.spawnFails) throw new Error("no session");
        return {
          ref: scoutRef,
          title: "Review",
          status: "idle",
          updatedAt: createdAt,
        } as unknown as SessionSnapshot;
      },
      setChildIsolation: () => {},
      sendCustomMessage: async (
        sessionRef: SessionRef,
        input: { text: string },
        options?: { triggerTurn?: boolean },
      ) => {
        state.sent.push({ sessionRef, text: input.text, triggerTurn: options?.triggerTurn });
      },
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "lead",
      workspaces: [],
      orchestrationChildren: state.children,
    }),
    replaceOrchestrationChildren: (children: readonly OrchestrationChildThread[]) => {
      state.children = [...children];
    },
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/nonexistent/pi-gui-ws" }),
    sessionFromState: (ref: SessionRef) => ({
      status: "idle",
      title: ref.sessionId,
      updatedAt: createdAt,
    }),
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: (ref: SessionRef) => ref.sessionId === "lead",
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultSidekickThinkingLevel: () => "xhigh" as const,
    defaultScoutThinkingLevel: () => undefined,
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) => state.transcripts.get(ref.sessionId) ?? [],
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (ref: SessionRef, text: string) => {
      state.scoutPrompts.push(text);
      state.transcripts.set(ref.sessionId, [
        user("su", text),
        ...(state.scoutAnswers ? [assistant("sa", VERDICT)] : [tool("st", "bash", {}, "running")]),
      ]);
      return {} as never;
    },
  };
  return createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
}

function flowState(overrides: Partial<FlowState> = {}): FlowState {
  return {
    children: [workerRecord()],
    transcripts: new Map([
      [
        "worker",
        [
          user("u1", workerBrief),
          tool("t1", "edit", { path: "src/a.ts" }),
          tool("t2", "write", { path: "src/b.ts" }),
          assistant("a1", "WORKER-DONE renamed in two files"),
        ],
      ],
    ]),
    sent: [],
    scoutPrompts: [],
    cancelled: [],
    spawnFails: false,
    scoutAnswers: true,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.describe("owner flow", () => {
  test("a multi-file worker run holds its report until the scout verdict, then wakes the lead once", async () => {
    const state = flowState();
    const owner = makeFlowHost(state);

    await owner.reportChildCompletion(workerRef);
    expect(state.sent).toHaveLength(0);
    await waitFor(() => state.children.length === 2);

    const scout = state.children.find((child) => child.id !== "worker-thread");
    expect(scout?.mode).toBe("scout");
    // Parented under the worker: off the lead's delegation budget and report path.
    expect(scout?.parentSessionId).toBe("worker");
    expect(scout?.sourceToolCallId?.startsWith(SCOUT_PRE_REVIEW_CALL_PREFIX)).toBe(true);
    expect(state.scoutPrompts[0]).toContain(SCOUT_PRE_REVIEW_BRIEF_OPENING);
    expect(state.scoutPrompts[0]).toContain("src/a.ts, src/b.ts");

    await owner.reportChildCompletion(scoutRef);
    await owner.reportChildCompletion(scoutRef);
    await owner.reportChildCompletion(workerRef);

    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.sessionRef).toEqual(leadRef);
    expect(state.sent[0]?.triggerTurn).toBe(true);
    expect(state.sent[0]?.text).toContain("WORKER-DONE renamed in two files");
    expect(state.sent[0]?.text).toContain(`Scout pre-review (thread_id: ${scout?.id}):`);
    expect(state.sent[0]?.text).toContain("src/b.ts:3 - stale import");
  });

  test("a failed scout spawn delivers the worker report alone", async () => {
    const state = flowState({ spawnFails: true });
    const owner = makeFlowHost(state);

    await owner.reportChildCompletion(workerRef);
    await waitFor(() => state.sent.length === 1);
    expect(state.sent[0]?.text).toContain("WORKER-DONE");
    expect(state.sent[0]?.text).toContain("Scout pre-review failed; review the diff yourself.");
  });

  test("a scout that misses the timeout is cancelled and the worker report goes alone", async () => {
    process.env.PI_APP_SCOUT_PRE_REVIEW_TIMEOUT_MS = "200";
    try {
      const state = flowState({ scoutAnswers: false });
      const owner = makeFlowHost(state);

      await owner.reportChildCompletion(workerRef);
      await waitFor(() => state.sent.length === 1);
      expect(state.sent[0]?.text).toContain("Scout pre-review timed out");
      expect(state.cancelled).toContain("scout");

      // A late scout finish never wakes the lead a second time.
      state.transcripts.set("scout", [user("su", "x"), assistant("sa", VERDICT)]);
      await owner.reportChildCompletion(scoutRef);
      expect(state.sent).toHaveLength(1);
    } finally {
      delete process.env.PI_APP_SCOUT_PRE_REVIEW_TIMEOUT_MS;
    }
  });

  test("stopping the lead records the held report without waking it", async () => {
    const state = flowState({ scoutAnswers: false });
    const owner = makeFlowHost(state);

    await owner.reportChildCompletion(workerRef);
    await waitFor(() => state.children.length === 2);
    await owner.cancelChildRunsForParent(leadRef);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.triggerTurn).toBe(false);
    expect(state.sent[0]?.text).toContain("Scout pre-review cancelled");
  });

  test("a new worker run releases the older held report before its own", async () => {
    const state = flowState({ scoutAnswers: false });
    const owner = makeFlowHost(state);

    await owner.reportChildCompletion(workerRef);
    await waitFor(() => state.children.length === 2);
    state.transcripts.set("worker", [
      user("u2", "Follow-up: also fix the docs."),
      tool("t3", "edit", { path: "README.md" }),
      assistant("a2", "WORKER-RUN-2 docs fixed"),
    ]);
    await owner.reportChildCompletion(workerRef);

    expect(state.sent).toHaveLength(2);
    expect(state.sent[0]?.text).toContain("WORKER-DONE");
    expect(state.sent[0]?.text).toContain("Scout pre-review superseded");
    expect(state.sent[1]?.text).toContain("WORKER-RUN-2 docs fixed");
    expect(state.cancelled).toContain("scout");
  });

  test("single-file runs and PI_APP_SCOUT_PRE_REVIEW=0 report immediately", async () => {
    const single = flowState();
    single.transcripts.set("worker", [
      user("u1", workerBrief),
      tool("t1", "edit", { path: "src/a.ts" }),
      assistant("a1", "WORKER-DONE one file"),
    ]);
    const singleOwner = makeFlowHost(single);
    await singleOwner.reportChildCompletion(workerRef);
    expect(single.sent).toHaveLength(1);
    expect(single.sent[0]?.text).not.toContain("Scout pre-review");
    expect(single.children).toHaveLength(1);

    process.env.PI_APP_SCOUT_PRE_REVIEW = "0";
    try {
      const disabled = flowState();
      const owner = makeFlowHost(disabled);
      await owner.reportChildCompletion(workerRef);
      expect(disabled.sent).toHaveLength(1);
      expect(disabled.sent[0]?.text).not.toContain("Scout pre-review");
      expect(disabled.children).toHaveLength(1);
    } finally {
      delete process.env.PI_APP_SCOUT_PRE_REVIEW;
    }
  });
});
