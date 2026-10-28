import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";
import {
  MAX_READ_THREAD_WAIT_SECONDS,
  readThreadWaitSecondsFromParams,
} from "../../electron/orchestration/orchestration-runtime";
import {
  createOrchestrationOwner,
  waitForChildSettled,
} from "../../electron/orchestration/app-store-orchestration";

test("wait_seconds parses to whole clamped seconds", () => {
  expect(readThreadWaitSecondsFromParams(undefined)).toBeUndefined();
  expect(readThreadWaitSecondsFromParams({})).toBeUndefined();
  expect(readThreadWaitSecondsFromParams({ wait_seconds: 0 })).toBeUndefined();
  expect(readThreadWaitSecondsFromParams({ wait_seconds: -5 })).toBeUndefined();
  expect(readThreadWaitSecondsFromParams({ wait_seconds: Number.NaN })).toBeUndefined();
  expect(readThreadWaitSecondsFromParams({ wait_seconds: "30" })).toBeUndefined();
  expect(readThreadWaitSecondsFromParams({ wait_seconds: 2.9 })).toBe(2);
  expect(readThreadWaitSecondsFromParams({ wait_seconds: 30 })).toBe(30);
  expect(readThreadWaitSecondsFromParams({ waitSeconds: 10 })).toBe(10);
  expect(readThreadWaitSecondsFromParams({ wait_seconds: 10_000 })).toBe(
    MAX_READ_THREAD_WAIT_SECONDS,
  );
});

const childRef: SessionRef = { workspaceId: "ws", sessionId: "child" };
const otherRef: SessionRef = { workspaceId: "ws", sessionId: "other" };

function completionEvent(sessionRef: SessionRef): SessionDriverEvent {
  return {
    type: "runCompleted",
    sessionRef,
    timestamp: new Date().toISOString(),
  } as SessionDriverEvent;
}

function makeEmitter() {
  const listeners: Array<(event: SessionDriverEvent) => void> = [];
  let unsubscribed = 0;
  const subscribe = (listener: (event: SessionDriverEvent) => void | Promise<void>) => {
    listeners.push(listener as (event: SessionDriverEvent) => void);
    return () => {
      unsubscribed += 1;
    };
  };
  return {
    subscribe,
    emit: (event: SessionDriverEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
    unsubscribed: () => unsubscribed,
    listenerCount: () => listeners.length,
  };
}

test("settle wait returns immediately when the child is already idle", async () => {
  const emitter = makeEmitter();
  const outcome = await waitForChildSettled({
    subscribe: emitter.subscribe,
    isRunning: () => false,
    sessionRef: childRef,
    timeoutMs: 5_000,
  });
  expect(outcome).toBe("settled");
  expect(emitter.listenerCount()).toBe(0);
});

test("settle wait resolves on child completion and ignores other sessions", async () => {
  const emitter = makeEmitter();
  const pending = waitForChildSettled({
    subscribe: emitter.subscribe,
    isRunning: () => true,
    sessionRef: childRef,
    timeoutMs: 5_000,
  });
  emitter.emit(completionEvent(otherRef));
  emitter.emit({
    type: "sessionUpdated",
    sessionRef: childRef,
    timestamp: new Date().toISOString(),
    snapshot: { status: "running" },
  } as unknown as SessionDriverEvent);
  emitter.emit(completionEvent(childRef));
  expect(await pending).toBe("settled");
  expect(emitter.unsubscribed()).toBe(1);
});

test("settle wait resolves when a session update reports idle", async () => {
  const emitter = makeEmitter();
  const pending = waitForChildSettled({
    subscribe: emitter.subscribe,
    isRunning: () => true,
    sessionRef: childRef,
    timeoutMs: 5_000,
  });
  emitter.emit({
    type: "sessionUpdated",
    sessionRef: childRef,
    timestamp: new Date().toISOString(),
    snapshot: { status: "idle" },
  } as unknown as SessionDriverEvent);
  expect(await pending).toBe("settled");
  expect(emitter.unsubscribed()).toBe(1);
});

test("settle wait times out and always unsubscribes", async () => {
  const emitter = makeEmitter();
  const outcome = await waitForChildSettled({
    subscribe: emitter.subscribe,
    isRunning: () => true,
    sessionRef: childRef,
    timeoutMs: 20,
  });
  expect(outcome).toBe("timeout");
  expect(emitter.unsubscribed()).toBe(1);
});

test("settle wait aborts on signal", async () => {
  const emitter = makeEmitter();
  const controller = new AbortController();
  const pending = waitForChildSettled({
    subscribe: emitter.subscribe,
    isRunning: () => true,
    sessionRef: childRef,
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  controller.abort();
  expect(await pending).toBe("aborted");
  expect(emitter.unsubscribed()).toBe(1);
});

test("read_thread does not block when the child settles during session ready", async () => {
  // Regression: the wait captured the child record before the async session
  // ready, so a stale "running" missed the already-fired runCompleted and
  // blocked for the full wait_seconds with a misleading "still running".
  const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
  let childStatus: OrchestrationChildThread["status"] = "running";
  let sessionStatus = "running";
  const child: OrchestrationChildThread = {
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
    createdAt: "2026-10-27T20:00:00.000Z",
    updatedAt: "2026-10-27T20:00:00.000Z",
  };
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => {
        throw new Error("not used");
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [],
      orchestrationChildren: [{ ...child, status: childStatus }],
    }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === "child"
        ? { status: sessionStatus, title: child.title, updatedAt: child.updatedAt }
        : undefined,
    isOrchestratorSession: () => true,
    // The child finishes while the ready round-trips are in flight.
    ensureSessionReady: async () => {
      childStatus = "complete";
      sessionStatus = "idle";
      return undefined;
    },
    subscribeToSessionEvents: () => () => {},
    transcriptFor: () => [],
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  const startedAt = Date.now();
  const result = await owner.readThreadToolResult(parentRef, "child-thread-1", {
    waitSeconds: 5,
  });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(result.details.timedOut).toBeUndefined();
  expect(result.details.status).toBe("complete");
});
