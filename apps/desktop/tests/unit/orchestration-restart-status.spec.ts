import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  OrchestrationChildThread,
  QueuedComposerMessage,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";

const createdAt = "2026-10-28T20:00:00.000Z";

function childRecord(overrides: Partial<OrchestrationChildThread> = {}): OrchestrationChildThread {
  return {
    id: "child-thread-1",
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: "child",
    title: "Trace the plumbing",
    goal: "Trace how completion is surfaced",
    mode: "worker",
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

interface FakeSession {
  status: string;
  title: string;
  updatedAt: string;
}

interface HostHarness {
  owner: ReturnType<typeof createOrchestrationOwner>;
  children: () => readonly OrchestrationChildThread[];
  hydrateCalls: SessionRef[];
  emitCalls: number;
  persistCalls: number;
  setTranscriptLoaded(sessionId: string, transcript: TranscriptMessage[]): void;
}

function makeHost(options: {
  children: OrchestrationChildThread[];
  sessions: Record<string, FakeSession>;
  /** transcripts available on "disk"; served only once the session is loaded */
  diskTranscripts?: Record<string, TranscriptMessage[]>;
  initiallyLoaded?: readonly string[];
  queued?: Record<string, QueuedComposerMessage[]>;
  selected?: { workspaceId: string; sessionId: string };
}): HostHarness {
  const childrenHolder = { current: [...options.children] };
  const loaded = new Set<string>(options.initiallyLoaded ?? []);
  const disk = options.diskTranscripts ?? {};
  const hydrateCalls: SessionRef[] = [];
  let emitCalls = 0;
  let persistCalls = 0;
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
      selectedWorkspaceId: options.selected?.workspaceId ?? "ws",
      selectedSessionId: options.selected?.sessionId ?? "parent",
      workspaces: [],
      orchestrationChildren: childrenHolder.current,
    }),
    replaceOrchestrationChildren: (next: readonly OrchestrationChildThread[]) => {
      childrenHolder.current = [...next];
    },
    refreshState: async () => ({}) as never,
    emit: () => {
      emitCalls += 1;
      return ({}) as never;
    },
    withError: async () => ({}) as never,
    persistUiState: async () => {
      persistCalls += 1;
    },
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) => {
      const session = options.sessions[ref.sessionId];
      return session
        ? { status: session.status, title: session.title, updatedAt: session.updatedAt }
        : undefined;
    },
    ensureSessionReady: async (ref: SessionRef) => {
      hydrateCalls.push(ref);
      loaded.add(ref.sessionId);
      return undefined;
    },
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => false,
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: (ref: SessionRef) => options.queued?.[ref.sessionId] ?? [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) =>
      loaded.has(ref.sessionId) ? (disk[ref.sessionId] ?? []) : [],
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: (ref: SessionRef) => loaded.has(ref.sessionId),
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async () => ({}) as never,
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return {
    owner,
    children: () => childrenHolder.current,
    hydrateCalls,
    get emitCalls() {
      return emitCalls;
    },
    get persistCalls() {
      return persistCalls;
    },
    setTranscriptLoaded(sessionId: string, transcript: TranscriptMessage[]) {
      disk[sessionId] = transcript;
      loaded.add(sessionId);
    },
  };
}

function queuedMessage(id: string): QueuedComposerMessage {
  return { id, text: "follow-up", createdAt } as QueuedComposerMessage;
}

test("an unloaded transcript never flips a stored complete status to queued", () => {
  const harness = makeHost({
    children: [childRecord({ status: "complete" })],
    sessions: { child: { status: "idle", title: "Trace the plumbing", updatedAt: createdAt } },
    // No transcript on disk and never loaded: the pre-fix projection read the
    // empty cache as \"never started\" and returned queued (counted as running).
  });
  const [projected] = harness.owner.projectOrchestrationChildren();
  expect(projected?.status).toBe("complete");
});

test("a stale queued status heals to complete once the transcript is cached", () => {
  const harness = makeHost({
    children: [childRecord({ status: "queued" })],
    sessions: { child: { status: "idle", title: "Trace the plumbing", updatedAt: createdAt } },
    diskTranscripts: { child: [assistantMessage("m1", "done")] },
    initiallyLoaded: ["child"],
  });
  const [projected] = harness.owner.projectOrchestrationChildren();
  expect(projected?.status).toBe("complete");
});

test("a never-started child still reads queued when its transcript is loaded and empty", () => {
  const harness = makeHost({
    children: [childRecord({ status: "queued" })],
    sessions: { child: { status: "idle", title: "Trace the plumbing", updatedAt: createdAt } },
    diskTranscripts: { child: [] },
    initiallyLoaded: ["child"],
  });
  const [projected] = harness.owner.projectOrchestrationChildren();
  expect(projected?.status).toBe("queued");
});

test("live signals win without a loaded transcript: running, failed, waiting", () => {
  const running = makeHost({
    children: [childRecord({ status: "complete" })],
    sessions: { child: { status: "running", title: "Trace the plumbing", updatedAt: createdAt } },
  });
  expect(running.owner.projectOrchestrationChildren()[0]?.status).toBe("running");

  const failed = makeHost({
    children: [childRecord({ status: "complete" })],
    sessions: { child: { status: "failed", title: "Trace the plumbing", updatedAt: createdAt } },
  });
  expect(failed.owner.projectOrchestrationChildren()[0]?.status).toBe("failed");

  const waiting = makeHost({
    children: [childRecord({ status: "complete" })],
    sessions: { child: { status: "idle", title: "Trace the plumbing", updatedAt: createdAt } },
    queued: { child: [queuedMessage("q1")] },
  });
  expect(waiting.owner.projectOrchestrationChildren()[0]?.status).toBe("waiting");
});

test("startup hydration loads background children and re-projects them to complete", async () => {
  const background = childRecord({
    id: "child-thread-2",
    parentSessionId: "other-parent",
    childSessionId: "background-child",
    status: "queued",
    title: "Background work",
  });
  const harness = makeHost({
    children: [childRecord({ status: "complete" }), background],
    sessions: {
      child: { status: "idle", title: "Trace the plumbing", updatedAt: createdAt },
      "background-child": { status: "idle", title: "Background work", updatedAt: createdAt },
    },
    diskTranscripts: {
      child: [assistantMessage("m1", "done")],
      "background-child": [assistantMessage("m2", "background done")],
    },
    selected: { workspaceId: "ws", sessionId: "parent" },
  });

  // The visible child hydrates synchronously; the background child heals
  // asynchronously and then re-projects, emits, and persists.
  await harness.owner.hydrateOrchestrationChildren();
  const visibleHydrated = harness.hydrateCalls.some((ref) => ref.sessionId === "child");
  expect(visibleHydrated).toBe(true);

  await expect
    .poll(() => harness.persistCalls, { timeout: 10_000 })
    .toBeGreaterThan(0);
  expect(
    harness.hydrateCalls.some((ref) => ref.sessionId === "background-child"),
  ).toBe(true);
  const byId = new Map(harness.children().map((child) => [child.id, child]));
  expect(byId.get("child-thread-2")?.status).toBe("complete");
  expect(harness.emitCalls).toBeGreaterThan(0);
});
