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
    parentSessionId: "other-parent",
    childWorkspaceId: "ws",
    childSessionId: "child",
    title: "Background work",
    goal: "Do background work",
    mode: "worker",
    depth: 1,
    status: "queued",
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

interface HostHarness {
  owner: ReturnType<typeof createOrchestrationOwner>;
  children: () => readonly OrchestrationChildThread[];
  hydrateCalls: SessionRef[];
  persistCalls: number;
}

function makeHost(options: {
  children: OrchestrationChildThread[];
  sessions: Record<string, { status: string; title: string; updatedAt: string }>;
  /** transcripts available on "disk"; served only once the session is loaded */
  diskTranscripts?: Record<string, TranscriptMessage[]>;
  initiallyLoaded?: readonly string[];
  queued?: Record<string, QueuedComposerMessage[]>;
  /** workspaces the app can resolve; hydration can only open resolvable ones */
  resolvableWorkspaces?: readonly string[];
  selected?: { workspaceId: string; sessionId: string };
}): HostHarness {
  const childrenHolder = { current: [...options.children] };
  const loaded = new Set<string>(options.initiallyLoaded ?? []);
  const disk = options.diskTranscripts ?? {};
  const resolvable = new Set(options.resolvableWorkspaces ?? ["ws"]);
  const hydrateCalls: SessionRef[] = [];
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
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {
      persistCalls += 1;
    },
    workspaceRefFromState: (workspaceId: string) =>
      resolvable.has(workspaceId)
        ? { workspaceId, path: `/tmp/${workspaceId}` }
        : undefined,
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
    get persistCalls() {
      return persistCalls;
    },
  };
}

function queuedMessage(id: string): QueuedComposerMessage {
  return { id, text: "follow-up", createdAt } as QueuedComposerMessage;
}

/**
 * A finished child whose session is missing from the catalog (never selected,
 * so never seeded into session state) must still heal: its workspace
 * resolves, so hydration opens it, and the loaded transcript alone derives
 * `complete` instead of keeping the stale `queued`.
 */
test("a queued child missing from the session catalog hydrates and heals to complete", async () => {
  const harness = makeHost({
    children: [childRecord({ status: "queued" })],
    // No session snapshot for "child": absent from the catalog.
    sessions: {},
    diskTranscripts: { child: [assistantMessage("m1", "background done")] },
  });

  await harness.owner.hydrateOrchestrationChildren();
  await expect.poll(() => harness.persistCalls, { timeout: 10_000 }).toBeGreaterThan(0);

  expect(harness.hydrateCalls.some((ref) => ref.sessionId === "child")).toBe(true);
  expect(harness.children()[0]?.status).toBe("complete");
});

/**
 * A child whose workspace cannot be resolved cannot be opened, so hydration
 * skips it without throwing and its stored status is preserved.
 */
test("a child with an unresolvable workspace is skipped, not hydrated", async () => {
  const harness = makeHost({
    children: [childRecord({ status: "queued" })],
    sessions: {},
    diskTranscripts: { child: [assistantMessage("m1", "background done")] },
    resolvableWorkspaces: [],
  });

  await harness.owner.hydrateOrchestrationChildren();
  // Give the detached background pass a chance to (incorrectly) hydrate.
  await new Promise((resolve) => setTimeout(resolve, 250));

  expect(harness.hydrateCalls).toHaveLength(0);
  expect(harness.persistCalls).toBe(0);
  expect(harness.children()[0]?.status).toBe("queued");
});

/**
 * An already-loaded transcript needs no hydration: ensureSessionReady is not
 * called again, and the projection still derives from the transcript even
 * without a session snapshot.
 */
test("a child with a loaded transcript is not re-hydrated and projects complete", async () => {
  const harness = makeHost({
    children: [childRecord({ status: "queued" })],
    sessions: {},
    diskTranscripts: { child: [assistantMessage("m1", "background done")] },
    initiallyLoaded: ["child"],
  });

  expect(harness.owner.projectOrchestrationChildren()[0]?.status).toBe("complete");

  await harness.owner.hydrateOrchestrationChildren();
  // Give the detached background pass a chance to (incorrectly) hydrate.
  await new Promise((resolve) => setTimeout(resolve, 250));

  expect(harness.hydrateCalls).toHaveLength(0);
});

/**
 * Live signals still win when the transcript is loaded but the session
 * snapshot is missing: queued follow-ups read `waiting`, not `complete`.
 */
test("live waiting overrides a loaded transcript without a session snapshot", () => {
  const harness = makeHost({
    children: [childRecord({ status: "queued" })],
    sessions: {},
    diskTranscripts: { child: [assistantMessage("m1", "background done")] },
    initiallyLoaded: ["child"],
    queued: { child: [queuedMessage("q1")] },
  });

  expect(harness.owner.projectOrchestrationChildren()[0]?.status).toBe("waiting");
});
