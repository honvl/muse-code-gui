import { expect, test } from "@playwright/test";
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import {
  readThreadAction,
  sendMessageToThreadAction,
} from "../../electron/orchestration/orchestration-runtime";

const createdAt = "2026-10-28T20:00:00.000Z";
const PARENTS = 10;
const ROWS_PER_PARENT = 2_000;
const CHILDREN = 30;

function parentId(index: number): string {
  return `parent-${index}`;
}

function childRecord(index: number): OrchestrationChildThread {
  return {
    id: `child-thread-${index}`,
    parentWorkspaceId: "ws",
    parentSessionId: parentId(index % PARENTS),
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

function message(id: string, role: "user" | "assistant", text: string): TranscriptMessage {
  return { kind: "message", id, role, text, createdAt };
}

function toolRow(
  id: string,
  toolName: string,
  status: "running" | "success",
  details: Record<string, unknown>,
): TranscriptMessage {
  return {
    kind: "tool",
    id,
    callId: id,
    toolName,
    status,
    label: toolName,
    createdAt,
    output: { content: [{ type: "text", text: `${toolName} output ${id}` }], details },
  };
}

/** A parent transcript: mostly chatter, plus one read, one follow-up and one acceptance per child. */
function parentTranscript(parentIndex: number): TranscriptMessage[] {
  const rows: TranscriptMessage[] = [];
  const ownChildren = Array.from({ length: CHILDREN }, (_unused, index) => index).filter(
    (index) => index % PARENTS === parentIndex,
  );
  for (const childIndex of ownChildren) {
    const childThreadId = `child-thread-${childIndex}`;
    rows.push(
      toolRow(`p${parentIndex}-read-${childIndex}`, "read_thread", "success", {
        action: readThreadAction,
        threadId: childThreadId,
        childThreadId,
        messages: [],
      }),
      toolRow(`p${parentIndex}-send-${childIndex}`, "send_message_to_thread", "success", {
        action: sendMessageToThreadAction,
        threadId: childThreadId,
        message: `keep going ${childIndex}`,
        status: "sent",
      }),
      message(
        `p${parentIndex}-accept-${childIndex}`,
        "assistant",
        `Looks good.\norchestrator-accepted: ${childThreadId} verified by diff`,
      ),
    );
  }
  while (rows.length < ROWS_PER_PARENT) {
    const index = rows.length;
    rows.push(
      index % 2 === 0
        ? message(`p${parentIndex}-u${index}`, "user", `line ${index}`)
        : message(`p${parentIndex}-a${index}`, "assistant", `reply ${index}\nmore text`),
    );
  }
  return rows;
}

function makeHarness() {
  const transcripts = new Map<string, readonly TranscriptMessage[]>();
  for (let index = 0; index < PARENTS; index += 1) {
    transcripts.set(
      sessionKey({ workspaceId: "ws", sessionId: parentId(index) }),
      parentTranscript(index),
    );
  }
  for (let index = 0; index < CHILDREN; index += 1) {
    transcripts.set(sessionKey({ workspaceId: "ws", sessionId: `child-${index}` }), [
      message(`c${index}-prompt`, "user", "do the work"),
      message(`c${index}-reply`, "assistant", "working on it"),
    ]);
  }
  const childrenHolder = {
    current: Array.from({ length: CHILDREN }, (_unused, index) => childRecord(index)),
  };
  const submits: SessionRef[] = [];
  let scannedRows = 0;
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
      selectedSessionId: parentId(0),
      workspaces: [],
      orchestrationChildren: childrenHolder.current,
    }),
    replaceOrchestrationChildren: (next: readonly OrchestrationChildThread[]) => {
      childrenHolder.current = [...next];
    },
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) => ({
      status: "running",
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
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) => transcripts.get(sessionKey(ref)) ?? [],
    transcriptForKey: (key: string) => transcripts.get(key) ?? [],
    replaceTranscript: (ref: SessionRef, next: readonly TranscriptMessage[]) => {
      transcripts.set(sessionKey(ref), [...next]);
    },
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (ref: SessionRef) => {
      submits.push(ref);
      return {} as never;
    },
  };
  const hostForOwner = host as unknown as Parameters<typeof createOrchestrationOwner>[0];
  const owner = createOrchestrationOwner(hostForOwner, {
    onParentEvidenceRowsScanned: (rows) => {
      scannedRows += rows;
    },
  });
  return {
    host: hostForOwner,
    owner,
    transcripts,
    children: () => childrenHolder.current,
    setChildren: (next: OrchestrationChildThread[]) => {
      childrenHolder.current = next;
    },
    takeScannedRows: () => {
      const rows = scannedRows;
      scannedRows = 0;
      return rows;
    },
    append(sessionId: string, row: TranscriptMessage) {
      const key = sessionKey({ workspaceId: "ws", sessionId });
      transcripts.set(key, [...(transcripts.get(key) ?? []), row]);
    },
    replaceRow(sessionId: string, rowId: string, row: TranscriptMessage) {
      const key = sessionKey({ workspaceId: "ws", sessionId });
      transcripts.set(
        key,
        (transcripts.get(key) ?? []).map((item) => (item.id === rowId ? row : item)),
      );
    },
  };
}

const childRef = (index: number): SessionRef => ({
  workspaceId: "ws",
  sessionId: `child-${index}`,
});

function evidenceIds(child: OrchestrationChildThread | undefined): string[] {
  return (child?.evidence ?? []).map((record) => record.id).sort();
}

test("a child event scans no parent rows once the index is warm", () => {
  const harness = makeHarness();
  // Cold start: every parent transcript is indexed once.
  harness.setChildren([...harness.owner.projectOrchestrationChildrenForSession(childRef(0))]);
  expect(harness.takeScannedRows()).toBe(PARENTS * ROWS_PER_PARENT);

  // A child toolFinished appends to the child transcript only.
  harness.append("child-0", toolRow("c0-tool", "bash", "success", {}) as TranscriptMessage);
  const projected = harness.owner.projectOrchestrationChildrenForSession(childRef(0));
  harness.setChildren([...projected]);
  expect(harness.takeScannedRows()).toBe(0);
  const child = projected.find((entry) => entry.id === "child-thread-0");
  expect(evidenceIds(child)).toEqual(
    [
      "accepted:p0-accept-0:child-thread-0",
      "command:c0-tool",
      "follow-up:p0-send-0",
      "observed-read:p0-read-0",
      "worker:c0-reply",
    ].sort(),
  );
});

test("a parent change re-extracts only the rows it appended or replaced", () => {
  const harness = makeHarness();
  harness.owner.projectOrchestrationChildren();
  harness.takeScannedRows();

  // Appended acceptance line for child 10 (parent 0).
  harness.append(
    parentId(0),
    message("p0-late-accept", "assistant", "orchestrator-accepted: child-thread-10 tests pass"),
  );
  // A read_thread row that finishes in place: running -> success.
  harness.append(parentId(0), toolRow("p0-late-read", "read_thread", "running", {}));
  harness.setChildren([...harness.owner.projectOrchestrationChildrenForSession(childRef(10))]);
  expect(harness.takeScannedRows()).toBe(2);

  harness.replaceRow(
    parentId(0),
    "p0-late-read",
    toolRow("p0-late-read", "read_thread", "success", {
      action: readThreadAction,
      threadId: "child-thread-10",
      childThreadId: "child-thread-10",
      messages: [],
    }),
  );
  const projected = harness.owner.projectOrchestrationChildrenForSession(childRef(10));
  expect(harness.takeScannedRows()).toBe(1);
  const ids = evidenceIds(projected.find((entry) => entry.id === "child-thread-10"));
  expect(ids).toContain("accepted:p0-late-accept:child-thread-10");
  expect(ids).toContain("observed-read:p0-late-read");
});

test("incremental projection matches a cold rebuild", () => {
  const warm = makeHarness();
  warm.owner.projectOrchestrationChildren();
  warm.append(
    parentId(3),
    message("p3-x", "assistant", "orchestrator-accepted: child-thread-13 ok"),
  );
  warm.append("child-13", toolRow("c13-tool", "bash", "success", {}));
  warm.setChildren([...warm.owner.projectOrchestrationChildrenForSession(childRef(13))]);
  const incremental = warm.owner.projectOrchestrationChildren();
  expect(warm.takeScannedRows()).toBeGreaterThan(0);

  const cold = createOrchestrationOwner(warm.host);
  // A fresh owner over the same host state starts with an empty index.
  const rebuilt = cold.projectOrchestrationChildren();
  expect(incremental).toEqual(rebuilt);
});

test("list_threads re-projects only the calling parent's children", () => {
  const harness = makeHarness();
  const before = harness.children();
  harness.owner.listThreadsToolResult({ workspaceId: "ws", sessionId: parentId(1) });
  const after = harness.children();
  for (let index = 0; index < CHILDREN; index += 1) {
    if (index % PARENTS === 1) {
      expect(after[index]).not.toBe(before[index]);
      expect(after[index]?.evidence.length).toBeGreaterThan(0);
    } else {
      expect(after[index]).toBe(before[index]);
    }
  }
});

test("archiving prunes the parent bucket and child generations", async () => {
  const harness = makeHarness();
  harness.owner.projectOrchestrationChildren();
  harness.takeScannedRows();

  const parentRef: SessionRef = { workspaceId: "ws", sessionId: parentId(2) };
  const first = await harness.owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child-thread-2",
    message: "next step",
  });
  expect(first.details.generation).toBe(2);

  harness.owner.forgetArchivedSession(childRef(2));
  const afterArchive = await harness.owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child-thread-2",
    message: "after archive",
  });
  expect(afterArchive.details.generation).toBe(2);

  // A pruned parent bucket rebuilds from the per-row memo: same evidence, no re-extraction.
  harness.owner.forgetArchivedSession(parentRef);
  const projected = harness.owner.projectOrchestrationChildrenForSession(childRef(2));
  expect(harness.takeScannedRows()).toBe(0);
  expect(evidenceIds(projected.find((entry) => entry.id === "child-thread-2"))).toContain(
    "observed-read:p2-read-2",
  );
});
