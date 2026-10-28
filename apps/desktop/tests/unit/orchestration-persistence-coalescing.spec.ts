import { expect, test } from "@playwright/test";
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import {
  createOrchestrationOwner,
  toPersistedOrchestrationChildren,
} from "../../electron/orchestration/app-store-orchestration";
import {
  UI_STATE_PERSIST_DELAY_MS,
  createDebouncedPersist,
  sessionEventPersistence,
} from "../../electron/persistence/ui-state-persist-scheduler";

const createdAt = "2026-10-28T20:00:00.000Z";
const parentRef: SessionRef = { workspaceId: "ws", sessionId: "lead" };
const CHILDREN = 5;

function childRecord(index: number): OrchestrationChildThread {
  return {
    id: `child-thread-${index}`,
    parentWorkspaceId: "ws",
    parentSessionId: parentRef.sessionId,
    childWorkspaceId: "ws",
    childSessionId: `child-${index}`,
    title: `Child ${index}`,
    goal: `Goal ${index}`,
    mode: "worker",
    depth: 1,
    status: "running",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
  };
}

const childRef = (index: number): SessionRef => ({
  workspaceId: "ws",
  sessionId: `child-${index}`,
});

/**
 * The real orchestration owner and the real UI-state debounce, wired the way
 * DesktopAppStore wires them: each write snapshots the persisted child records.
 */
function makeHarness() {
  let children = Array.from({ length: CHILDREN }, (_unused, index) => childRecord(index));
  const statusBySession = new Map<string, string>(
    children.map((child) => [child.childSessionId, "running"]),
  );
  const transcripts = new Map<string, readonly TranscriptMessage[]>();
  const writes: string[][] = [];
  let immediateHostWrites = 0;
  let scheduledHostWrites = 0;
  const persist = async () => {
    writes.push(
      (toPersistedOrchestrationChildren(children) ?? []).map(
        (child) => `${child.id}:${child.status}`,
      ),
    );
  };
  const scheduler = createDebouncedPersist(persist, (error) => {
    throw error;
  });
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => {
        throw new Error("not used");
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: parentRef.sessionId,
      workspaces: [],
      orchestrationChildren: children,
    }),
    replaceOrchestrationChildren: (next: readonly OrchestrationChildThread[]) => {
      children = [...next];
    },
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {
      immediateHostWrites += 1;
    },
    schedulePersistUiState: () => {
      scheduledHostWrites += 1;
    },
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) => ({
      status: statusBySession.get(ref.sessionId) ?? "idle",
      title: ref.sessionId,
      updatedAt: createdAt,
    }),
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => true,
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultScoutThinkingLevel: () => undefined,
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) => transcripts.get(sessionKey(ref)) ?? [],
    transcriptForKey: (key: string) => transcripts.get(key) ?? [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async () => ({}) as never,
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );

  /** The tail of DesktopAppStore's session-event handler for a finished child run. */
  async function finishChildRun(index: number): Promise<void> {
    const ref = childRef(index);
    statusBySession.set(ref.sessionId, "idle");
    transcripts.set(sessionKey(ref), [
      { kind: "message", id: `c${index}-u`, role: "user", text: "work", createdAt },
      { kind: "message", id: `c${index}-a`, role: "assistant", text: "done", createdAt },
    ]);
    children = [...owner.projectOrchestrationChildrenForSession(ref)];
    await owner.reportChildCompletion(ref);
    const persistence = sessionEventPersistence(
      "runCompleted",
      owner.hasOrchestrationChildSession(ref),
    );
    if (persistence === "immediate") {
      scheduler.cancel();
      await persist();
    } else if (persistence === "debounced") {
      scheduler.schedule();
    }
  }

  /** DesktopAppStore.flushPersistence: drop the pending timer and write now. */
  async function quit(): Promise<void> {
    scheduler.cancel();
    await persist();
  }

  return {
    owner,
    scheduler,
    writes,
    finishChildRun,
    quit,
    hostWrites: () => ({ immediate: immediateHostWrites, scheduled: scheduledHostWrites }),
  };
}

const allComplete = Array.from(
  { length: CHILDREN },
  (_unused, index) => `child-thread-${index}:complete`,
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("five children finishing within 100 ms produce one UI-state write", async () => {
  const harness = makeHarness();
  for (let index = 0; index < CHILDREN; index += 1) {
    await harness.finishChildRun(index);
    await sleep(20);
  }
  expect(harness.writes).toHaveLength(0);

  await expect.poll(() => harness.writes.length).toBe(1);
  await sleep(UI_STATE_PERSIST_DELAY_MS + 100);
  expect(harness.writes).toHaveLength(1);
  expect(harness.writes[0]).toEqual(allComplete);
});

test("a quit right after the burst persists every terminal status once", async () => {
  const harness = makeHarness();
  for (let index = 0; index < CHILDREN; index += 1) {
    await harness.finishChildRun(index);
  }
  expect(harness.scheduler.pending).toBe(true);

  await harness.quit();
  expect(harness.scheduler.pending).toBe(false);
  expect(harness.writes).toEqual([allComplete]);

  await sleep(UI_STATE_PERSIST_DELAY_MS + 100);
  expect(harness.writes).toHaveLength(1);
});

test("child message sends schedule a write instead of writing each time", async () => {
  const harness = makeHarness();
  for (let index = 0; index < CHILDREN; index += 1) {
    const result = await harness.owner.sendMessageToThreadToolResult(parentRef, {
      threadId: `child-thread-${index}`,
      message: "next step",
    });
    expect(result.details.error).toBeUndefined();
  }
  expect(harness.hostWrites()).toEqual({ immediate: 0, scheduled: CHILDREN });
});

test("only child run endings are coalesced; closes and top-level runs write at once", () => {
  expect(sessionEventPersistence("runCompleted", true)).toBe("debounced");
  expect(sessionEventPersistence("runFailed", true)).toBe("debounced");
  expect(sessionEventPersistence("runCompleted", false)).toBe("immediate");
  expect(sessionEventPersistence("runFailed", false)).toBe("immediate");
  expect(sessionEventPersistence("sessionClosed", true)).toBe("immediate");
  expect(sessionEventPersistence("sessionClosed", false)).toBe("immediate");
  expect(sessionEventPersistence("toolFinished", true)).toBe("debounced");
  expect(sessionEventPersistence("hostUiRequest", false)).toBe("none");
});
