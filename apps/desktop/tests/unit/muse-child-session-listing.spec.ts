import { expect, test } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseCliDriver } from "@pi-gui/muse-cli-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type { SessionCatalogEntry } from "@pi-gui/catalogs";
import type { DesktopAppState, TranscriptMessage } from "../../contracts/desktop-state";
import {
  buildWorkspaceRecords,
  mergeSessionListings,
} from "../../electron/application/app-store-utils";
import {
  appendAssistantDelta,
  appendUserMessage,
  applyTimelineEvent,
} from "../../electron/conversation/app-store-timeline";
import { applySessionEventState } from "../../electron/conversation/app-store-session-state";

const createdAt = "2026-10-29T00:00:00.000Z";
const promptText = "Read sidekick-runtime.ts and report the routing rules.";
const finalText = "Routing rules for sidekick children. Result: route meta/* to Muse CLI.";
const runId = "run-muse-1";

interface Harness {
  cache: Map<string, readonly TranscriptMessage[]>;
  runtime: {
    runMetricsBySession: Map<string, never>;
    runningSinceBySession: Map<string, string>;
    activeAssistantMessageBySession: Map<string, string>;
    pendingAssistantMessageBySession: Map<string, string>;
    activeWorkingActivityBySession: Map<string, string>;
    extensionToolLabels: () => Map<string, string>;
  };
  lastViewedAt: Map<string, string>;
  state: DesktopAppState;
}

/** State the way refreshStateNow builds it, from a given session listing. */
function stateFromSessions(sessions: readonly SessionCatalogEntry[]): Harness {
  const cache = new Map<string, readonly TranscriptMessage[]>();
  const runtime = {
    runMetricsBySession: new Map<string, never>(),
    runningSinceBySession: new Map<string, string>(),
    activeAssistantMessageBySession: new Map<string, string>(),
    pendingAssistantMessageBySession: new Map<string, string>(),
    activeWorkingActivityBySession: new Map<string, string>(),
    extensionToolLabels: () => new Map<string, string>(),
  };
  const lastViewedAt = new Map<string, string>();
  const harness = {
    cache,
    runtime,
    lastViewedAt,
    state: undefined as unknown as DesktopAppState,
  };
  rebuildWorkspaces(harness, sessions);
  return harness;
}

/** What refreshStateNow does on every refresh: rebuild workspace rows over the live caches. */
function rebuildWorkspaces(harness: Harness, sessions: readonly SessionCatalogEntry[]): void {
  const workspaces = buildWorkspaceRecords(
    [
      {
        workspaceId: "ws",
        path: mkdtempSync(join(tmpdir(), "muse-listing-")),
        displayName: "ws",
        lastOpenedAt: createdAt,
        sortOrder: 0,
      },
    ],
    [],
    sessions,
    harness.cache,
    harness.runtime.runningSinceBySession,
    new Map(),
    harness.lastViewedAt,
    new Map(),
    new Map(),
  );
  harness.state = { workspaces, revision: 0 } as unknown as DesktopAppState;
}

function dispatch(harness: Harness, event: SessionDriverEvent): void {
  if (event.type === "assistantDelta" || event.type === "assistantThinkingDelta") {
    appendAssistantDelta(
      harness.cache,
      harness.runtime.activeAssistantMessageBySession,
      event.sessionRef,
      event.text,
      event.timestamp,
    );
  }
  applyTimelineEvent(harness.cache, event, harness.runtime);
  harness.state = applySessionEventState(
    harness.state,
    event,
    harness.cache,
    harness.runtime.runningSinceBySession,
    harness.lastViewedAt,
  );
}

/** The probe's fixed per-turn sequence (see packages/muse-cli-driver test). */
function driveProbeTurn(harness: Harness, childRef: SessionRef): void {
  const updated = (status: "running" | "idle", runningRunId?: string): SessionDriverEvent =>
    ({
      type: "sessionUpdated",
      sessionRef: childRef,
      timestamp: createdAt,
      snapshot: { status, ...(runningRunId ? { runningRunId } : {}) },
    }) as unknown as SessionDriverEvent;
  const push = (event: SessionDriverEvent): void => {
    dispatch(harness, event);
  };
  appendUserMessage(harness.cache, childRef, promptText);
  push(updated("running", runId));
  push({
    type: "toolStarted",
    sessionRef: childRef,
    timestamp: createdAt,
    toolName: "read_file",
    callId: "call-1",
  } as unknown as SessionDriverEvent);
  push({
    type: "toolFinished",
    sessionRef: childRef,
    timestamp: createdAt,
    callId: "call-1",
    success: true,
  } as unknown as SessionDriverEvent);
  push({
    type: "assistantMessageStarted",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
  } as unknown as SessionDriverEvent);
  push({
    type: "assistantDelta",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
    text: finalText,
  } as unknown as SessionDriverEvent);
  push({
    type: "assistantMessageEnded",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
  } as unknown as SessionDriverEvent);
}

function runCompletedEvent(childRef: SessionRef): SessionDriverEvent {
  return {
    type: "runCompleted",
    sessionRef: childRef,
    timestamp: createdAt,
    runId,
    snapshot: { status: "idle", preview: finalText },
  } as unknown as SessionDriverEvent;
}

async function waitForIdleListing(
  driver: MuseCliDriver,
  timeoutMs = 10_000,
): Promise<{ sessions: SessionCatalogEntry[] }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listed = await driver.listSessions();
    if (listed.sessions[0]?.status === "idle") {
      return listed;
    }
    if (Date.now() > deadline) {
      return listed;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sessionRow(harness: Harness, childRef: SessionRef): { status: string } | undefined {
  const workspaces = harness.state.workspaces as unknown as Array<{
    sessions: Array<{ id: string; status: string }>;
  }>;
  return workspaces[0]?.sessions.find((session) => session.id === childRef.sessionId) as
    { status: string } | undefined;
}

function transcriptText(harness: Harness, childRef: SessionRef): string {
  const key = `${childRef.workspaceId}:${childRef.sessionId}`;
  return (harness.cache.get(key) ?? [])
    .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

test("a Muse child missing from the session listing never reads running", () => {
  // Pins the failure mechanism with pi-only sourcing: the driver emits the
  // exact probe sequence, but the session row is absent, so status events
  // no-op and the streamed text never lands on a session.
  const childRef: SessionRef = { workspaceId: "ws", sessionId: "muse-child" };
  const harness = stateFromSessions([]);
  appendUserMessage(harness.cache, childRef, promptText);
  dispatch(harness, {
    type: "sessionUpdated",
    sessionRef: childRef,
    timestamp: createdAt,
    snapshot: { status: "running", runningRunId: runId },
  } as unknown as SessionDriverEvent);
  expect(sessionRow(harness, childRef)).toBeUndefined();
});

test("a Muse child survives refreshState with running status and streamed text", async () => {
  // End-to-end slice of the fixed pipeline: the real MuseCliDriver (stub
  // `muse` binary sleeping, so the turn stays running), merged over pi's
  // empty listing through the real mergeSessionListings, built into state
  // through the real buildWorkspaceRecords, then the probe's exact event
  // sequence through the real store appliers.
  const dir = mkdtempSync(join(tmpdir(), "muse-stub-"));
  const binaryPath = join(dir, "muse");
  writeFileSync(binaryPath, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  chmodSync(binaryPath, 0o755);
  const driver = new MuseCliDriver({
    binaryPath,
    sessionFileDir: mkdtempSync(join(tmpdir(), "muse-markers-")),
  });
  const workspace = {
    workspaceId: "ws",
    path: mkdtempSync(join(tmpdir(), "muse-ws-")),
    displayName: "ws",
  };
  const snapshot = await driver.createSession(workspace, { title: "Muse sidekick" });
  const childRef = snapshot.ref;
  await driver.sendUserMessage(childRef, { text: promptText });
  try {
    // The live record is authoritative: pi's listing is empty, the merged
    // listing carries the child as running.
    const listed = await driver.listSessions();
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?.status).toBe("running");
    const harness = stateFromSessions(mergeSessionListings([], listed.sessions));

    driveProbeTurn(harness, childRef);
    expect(sessionRow(harness, childRef)?.status).toBe("running");

    dispatch(harness, runCompletedEvent(childRef));
    expect(sessionRow(harness, childRef)?.status).toBe("idle");
    expect(transcriptText(harness, childRef)).toContain(finalText);

    // A second refreshState rebuild over the live caches keeps the row and
    // its transcript instead of dropping it. Ending the stub turn settles
    // the live record to idle, the way a real runCompleted would (settling
    // rides the process close event, just after cancel resolves).
    await driver.cancelCurrentRun(childRef);
    const relisted = await waitForIdleListing(driver);
    expect(relisted.sessions[0]?.status).toBe("idle");
    rebuildWorkspaces(harness, mergeSessionListings([], relisted.sessions));
    expect(sessionRow(harness, childRef)?.status).toBe("idle");
    expect(transcriptText(harness, childRef)).toContain(finalText);
  } finally {
    await driver.closeSession(childRef);
  }
});
