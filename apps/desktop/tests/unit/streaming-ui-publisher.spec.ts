import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  STREAMING_UI_PUBLISH_INTERVAL_MS,
  StreamingUiPublisher,
  shouldDeferStreamingUiPublish,
} from "../../electron/conversation/streaming-ui-publisher";

const sessionRef: SessionRef = { workspaceId: "ws", sessionId: "sess" };

function runningUpdated(runId = "run-1"): Extract<SessionDriverEvent, { type: "sessionUpdated" }> {
  return {
    type: "sessionUpdated",
    sessionRef,
    timestamp: "2026-09-18T00:00:00.000Z",
    snapshot: {
      ref: sessionRef,
      workspace: { workspaceId: "ws", path: "/tmp", displayName: "tmp" },
      title: "Thread",
      status: "running",
      updatedAt: "2026-09-18T00:00:00.000Z",
      preview: "tok",
      runningRunId: runId,
    },
  };
}

function idleUpdated(): Extract<SessionDriverEvent, { type: "sessionUpdated" }> {
  return {
    type: "sessionUpdated",
    sessionRef,
    timestamp: "2026-09-18T00:00:01.000Z",
    snapshot: {
      ...runningUpdated().snapshot,
      status: "idle",
      runningRunId: undefined,
    },
  };
}

test("defers token deltas and redundant running sessionUpdated ticks", () => {
  expect(
    shouldDeferStreamingUiPublish(
      {
        type: "assistantDelta",
        sessionRef,
        timestamp: "2026-09-18T00:00:00.000Z",
        text: "tok",
      },
      undefined,
    ),
  ).toBe(true);
  expect(shouldDeferStreamingUiPublish(runningUpdated(), "run-1")).toBe(true);
  expect(shouldDeferStreamingUiPublish(runningUpdated(), undefined)).toBe(false);
  expect(shouldDeferStreamingUiPublish(runningUpdated("run-2"), "run-1")).toBe(false);
  expect(
    shouldDeferStreamingUiPublish(
      {
        type: "runCompleted",
        sessionRef,
        timestamp: "2026-09-18T00:00:01.000Z",
        snapshot: idleUpdated().snapshot,
      },
      "run-1",
    ),
  ).toBe(false);
});

test("Stop then Send treats the next runningRunId as a first tick", () => {
  const publisher = new StreamingUiPublisher(() => {});
  expect(publisher.shouldDefer(runningUpdated("run-1"))).toBe(false);
  publisher.observe(runningUpdated("run-1"));
  expect(publisher.shouldDefer(runningUpdated("run-1"))).toBe(true);
  expect(publisher.shouldDefer(idleUpdated())).toBe(false);
  publisher.observe(idleUpdated());
  expect(publisher.shouldDefer(runningUpdated("run-2"))).toBe(false);
});

test("coalesces every streaming session into one trailing flush", async () => {
  const flushes: string[][] = [];
  const publisher = new StreamingUiPublisher((refs) => {
    flushes.push(refs.map((ref) => ref.sessionId));
  }, 25);

  publisher.schedule(sessionRef);
  publisher.schedule(sessionRef);
  publisher.schedule({ workspaceId: "ws", sessionId: "other" });
  expect(flushes).toEqual([]);
  expect(publisher.pendingCount()).toBe(2);

  // Both sessions publish in a single flush: the rate no longer scales with
  // how many threads are streaming.
  await expect.poll(() => flushes).toHaveLength(1);
  expect(flushes[0]?.slice().sort()).toEqual(["other", "sess"]);

  publisher.schedule(sessionRef);
  await expect.poll(() => flushes).toHaveLength(2);
  expect(flushes[1]).toEqual(["sess"]);
});

test("a burst of sessions still publishes once per interval", async () => {
  let flushes = 0;
  const publisher = new StreamingUiPublisher(() => {
    flushes += 1;
  }, 25);
  for (let index = 0; index < 8; index += 1) {
    publisher.schedule({ workspaceId: "ws", sessionId: `s${index}` });
  }
  await expect.poll(() => flushes).toBe(1);
  // Give any stray per-session timers a chance to fire; there must be none.
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
  expect(flushes).toBe(1);
});

test("cancel drops a pending flush so a discrete emit can publish itself", async () => {
  const flushes: string[][] = [];
  const publisher = new StreamingUiPublisher((refs) => {
    flushes.push(refs.map((ref) => ref.sessionId));
  }, 20);
  publisher.schedule(sessionRef);
  publisher.cancel(sessionRef);
  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  expect(flushes).toEqual([]);
  expect(STREAMING_UI_PUBLISH_INTERVAL_MS).toBe(50);
});

test("cancelling one session keeps the other sessions' pending flush", async () => {
  const flushes: string[][] = [];
  const publisher = new StreamingUiPublisher((refs) => {
    flushes.push(refs.map((ref) => ref.sessionId));
  }, 25);
  publisher.schedule(sessionRef);
  publisher.schedule({ workspaceId: "ws", sessionId: "other" });
  publisher.cancel(sessionRef);
  await expect.poll(() => flushes).toHaveLength(1);
  expect(flushes[0]).toEqual(["other"]);
});

test("a closed session stops contributing to flushes", async () => {
  let flushes = 0;
  const publisher = new StreamingUiPublisher(() => {
    flushes += 1;
  }, 20);
  publisher.schedule(sessionRef);
  publisher.observe({
    type: "sessionClosed",
    sessionRef,
    timestamp: "2026-09-18T00:00:02.000Z",
    reason: "closed",
  } as unknown as SessionDriverEvent);
  expect(publisher.pendingCount()).toBe(0);
  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  expect(flushes).toBe(0);
});

test("a busy tool's progress reports coalesce instead of publishing per update", async () => {
  const sessionRefForTool: SessionRef = { workspaceId: "ws", sessionId: "busy-tool" };
  const publisher = new StreamingUiPublisher(() => {}, 50);

  // A long-running bash/code tool reports partial output repeatedly; each of
  // these used to be an immediate full state publish.
  for (let index = 0; index < 50; index += 1) {
    const event = {
      type: "toolUpdated",
      sessionRef: sessionRefForTool,
      timestamp: "2026-09-18T00:00:00.000Z",
      callId: "call-1",
      text: `chunk ${index}`,
    } as unknown as SessionDriverEvent;
    expect(publisher.shouldDefer(event)).toBe(true);
  }

  // toolStarted / toolFinished stay immediate: a row appearing or settling is
  // what the reader is waiting on.
  expect(
    publisher.shouldDefer({
      type: "toolStarted",
      sessionRef: sessionRefForTool,
      timestamp: "2026-09-18T00:00:00.000Z",
      toolName: "bash",
      callId: "call-1",
      input: {},
    } as unknown as SessionDriverEvent),
  ).toBe(false);
  expect(
    publisher.shouldDefer({
      type: "toolFinished",
      sessionRef: sessionRefForTool,
      timestamp: "2026-09-18T00:00:00.000Z",
      callId: "call-1",
      success: true,
    } as unknown as SessionDriverEvent),
  ).toBe(false);
});
