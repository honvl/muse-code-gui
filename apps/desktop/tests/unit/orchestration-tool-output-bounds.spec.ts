import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import { listThreadsQueryFromParams } from "../../electron/orchestration/orchestration-runtime";

const createdAt = "2026-10-27T20:00:00.000Z";
const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
const childRef: SessionRef = { workspaceId: "ws", sessionId: "child" };

function userMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "user", id, text, createdAt };
}

function assistantMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "assistant", id, text, createdAt };
}

function toolRow(id: string, toolName: string): TranscriptMessage {
  return {
    kind: "tool",
    id,
    callId: `call-${id}`,
    toolName,
    status: "success",
    label: "search results",
    createdAt,
  };
}

/**
 * A 500-row transcript: 470 parent/child messages with 2,000-char bodies and
 * 10 tool rows (480 kept rows), plus custom/card/activity/summary/pin rows
 * that read_thread must drop.
 */
function buildLargeTranscript(): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = [];
  const longBody = (id: string) => `${id} ${"x".repeat(2000)}`;
  for (let index = 0; index < 460; index += 1) {
    transcript.push(
      index % 2 === 0
        ? userMessage(`u-${index}`, longBody(`u-${index}`))
        : assistantMessage(`a-${index}`, longBody(`a-${index}`)),
    );
  }
  for (let index = 0; index < 10; index += 1) {
    transcript.push(toolRow(`tool-${index}`, index % 2 === 0 ? "rg" : "read"));
    transcript.push(assistantMessage(`tail-${index}`, longBody(`tail-${index}`)));
  }
  for (let index = 0; index < 6; index += 1) {
    transcript.push({
      kind: "custom",
      id: `custom-${index}`,
      createdAt,
      customType: "pi-gui.note",
      text: "CUSTOM-NEEDS-DROP",
    });
  }
  transcript.push({
    kind: "card",
    id: "card-1",
    createdAt,
    card: {
      title: "CARD-NEEDS-DROP",
      tone: "neutral",
      rows: [],
      actions: [],
    },
  });
  transcript.push({ kind: "activity", id: "activity-1", createdAt, label: "ACTIVITY-NEEDS-DROP" });
  transcript.push({
    kind: "summary",
    id: "summary-1",
    createdAt,
    label: "SUMMARY-NEEDS-DROP",
    presentation: "inline",
  });
  transcript.push({
    kind: "summary",
    id: "summary-2",
    createdAt,
    label: "SUMMARY-NEEDS-DROP",
    presentation: "divider",
    metadata: "extra",
  });
  transcript.push({
    kind: "custom",
    id: "custom-trailing",
    createdAt,
    customType: "pi-gui.note",
    text: "CUSTOM-NEEDS-DROP",
  });
  transcript.push({
    kind: "activity",
    id: "activity-2",
    createdAt,
    label: "ACTIVITY-NEEDS-DROP",
    detail: "extra",
  });
  transcript.push({
    kind: "card",
    id: "card-2",
    createdAt,
    card: {
      title: "CARD-NEEDS-DROP",
      subtitle: "extra",
      tone: "neutral",
      rows: [],
      actions: [],
    },
  });
  for (let index = 0; index < 5; index += 1) {
    transcript.push({ kind: "pin", id: `pin:${index}`, createdAt, card: null });
  }
  for (let index = 0; index < 2; index += 1) {
    transcript.push({
      kind: "message",
      role: "compactionSummary",
      id: `compact-${index}`,
      text: "COMPACTION-NEEDS-DROP",
      createdAt,
    });
  }
  expect(transcript).toHaveLength(500);
  return transcript;
}

function childRecord(suffix: number, childSessionId: string): OrchestrationChildThread {
  return {
    id: `child-thread-${suffix}`,
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId,
    title: `Trace the plumbing ${suffix}`,
    goal: "Trace how completion is surfaced",
    mode: "scout",
    depth: 1,
    status: "complete",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
  };
}

interface BoundsHostState {
  childTranscript: TranscriptMessage[];
  children: OrchestrationChildThread[];
  lead?: boolean;
  sessions: Array<{
    id: string;
    title: string;
    updatedAt: string;
    preview: string;
  }>;
}

function makeHost(state: BoundsHostState) {
  const children = state.children;
  const lead = state.lead ?? true;
  // Prompt deliveries that started a run: submitComposerToSession records the
  // delivered prompt so initialPromptDeliveryStatus sees a running child.
  const runningChildren = new Map<string, string>();
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async (workspace: { workspaceId: string }, options?: { title?: string }) => ({
        ref: { workspaceId: workspace.workspaceId, sessionId: `spawned-${children.length}` },
        title: options?.title ?? "Spawned child",
        preview: "",
        status: "running",
        updatedAt: createdAt,
      }),
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [
        {
          id: "ws",
          sessions: state.sessions.map((session) => ({
            id: session.id,
            title: session.title,
            status: "idle",
            updatedAt: session.updatedAt,
            preview: session.preview,
          })),
        },
      ],
      orchestrationChildren: children,
    }),
    replaceOrchestrationChildren: () => {},
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) => {
      if (runningChildren.has(ref.sessionId)) {
        return { status: "running", title: "Spawned child", updatedAt: createdAt };
      }
      const session = state.sessions.find((entry) => entry.id === ref.sessionId);
      return session
        ? { status: "idle", title: session.title, updatedAt: session.updatedAt }
        : undefined;
    },
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultSidekickThinkingLevel: () => "xhigh" as const,
    defaultScoutThinkingLevel: () => undefined,
    seedSession: () => {},
    isOrchestratorSession: () => lead,
    sidekickModelFor: () => undefined,
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    transcriptFor: (ref: SessionRef) => {
      if (ref.sessionId === childRef.sessionId) {
        return state.childTranscript;
      }
      const prompt = runningChildren.get(ref.sessionId);
      return prompt ? [userMessage("u-spawn", prompt)] : [];
    },
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (ref: SessionRef, text: string) => {
      runningChildren.set(ref.sessionId, text);
      return {} as never;
    },
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function sessionEntries(count: number, childSessionIds: string[]): BoundsHostState["sessions"] {
  const sessions: BoundsHostState["sessions"] = [
    {
      id: "parent",
      title: "Parent orchestrator thread",
      updatedAt: "2026-10-28T00:00:00.000Z",
      preview: "parent preview",
    },
  ];
  for (const childSessionId of childSessionIds) {
    sessions.push({
      id: childSessionId,
      title: `Child session ${childSessionId}`,
      updatedAt: "2026-10-27T12:00:00.000Z",
      preview: `child preview ${childSessionId}`,
    });
  }
  for (let index = 0; index < count; index += 1) {
    sessions.push({
      id: `other-${index}`,
      title: index === 3 ? "needle-in-haystack-1987" : `Workspace thread ${index}`,
      updatedAt: `2026-10-27T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      preview: `preview-${index} ${"p".repeat(300)}`,
    });
  }
  return sessions;
}

test("read_thread default window stays capped on a 500-message transcript", async () => {
  const { owner } = makeHost({
    childTranscript: buildLargeTranscript(),
    children: [childRecord(1, "child")],
    sessions: [],
  });

  const result = await owner.readThreadToolResult(parentRef, "child-thread-1");

  // 480 kept rows (470 messages + 10 tool rows); the default window shows 8.
  expect(result.details.totalMessages).toBe(480);
  expect(result.details.messages).toHaveLength(8);
  expect(result.details.omittedEarlier).toBe(472);
  for (const message of result.details.messages ?? []) {
    expect(message.text.length).toBeLessThanOrEqual(1500);
  }
  const total = (result.details.messages ?? []).reduce(
    (sum, message) => sum + message.text.length,
    0,
  );
  expect(total).toBeLessThanOrEqual(8000);
  expect(result.details.truncated).toBe(true);

  const text = resultText(result);
  expect(text).toContain("472 earlier omitted");
  expect(text).toContain("rg: search results [success]");
  for (const dropped of [
    "CUSTOM-NEEDS-DROP",
    "CARD-NEEDS-DROP",
    "ACTIVITY-NEEDS-DROP",
    "SUMMARY-NEEDS-DROP",
    "COMPACTION-NEEDS-DROP",
  ]) {
    expect(text).not.toContain(dropped);
  }
});

test("read_thread full:true raises the window but keeps a hard cap", async () => {
  const { owner } = makeHost({
    childTranscript: buildLargeTranscript(),
    children: [childRecord(1, "child")],
    sessions: [],
  });

  const result = await owner.readThreadToolResult(parentRef, "child-thread-1", { full: true });

  expect(result.details.totalMessages).toBe(480);
  expect(result.details.messages).toHaveLength(32);
  expect(result.details.omittedEarlier).toBe(448);
  for (const message of result.details.messages ?? []) {
    expect(message.text.length).toBeLessThanOrEqual(1500);
  }
  const total = (result.details.messages ?? []).reduce(
    (sum, message) => sum + message.text.length,
    0,
  );
  expect(total).toBeLessThanOrEqual(24000);
  expect(resultText(result)).toContain("448 earlier omitted");
});

test("read_thread incremental reads return only unseen messages", async () => {
  const { owner } = makeHost({
    childTranscript: buildLargeTranscript(),
    children: [childRecord(1, "child")],
    sessions: [],
  });

  await owner.readThreadToolResult(parentRef, "child-thread-1");
  const second = await owner.readThreadToolResult(parentRef, "child-thread-1");

  expect(second.details.messages).toHaveLength(0);
  expect(second.details.totalMessages).toBe(480);
  expect(second.details.omittedEarlier).toBe(480);
  expect(resultText(second)).toContain("0 message(s), 480 earlier omitted");
});

test("list_threads caps other threads and truncates previews", async () => {
  const childSessionIds = ["child-a", "child-b", "child-c"];
  const { owner } = makeHost({
    childTranscript: [],
    children: childSessionIds.map((sessionId, index) => childRecord(index + 1, sessionId)),
    sessions: sessionEntries(200, childSessionIds),
  });

  const result = await owner.listThreadsToolResult(parentRef);

  // Current thread first, then children, then at most 10 other workspace threads.
  const threads = result.details.threads ?? [];
  expect(threads).toHaveLength(14);
  expect(threads[0]?.relationship).toBe("current");
  expect(threads[0]?.threadId).toBe("parent");
  expect(threads.slice(1, 4).map((thread) => thread.relationship)).toEqual([
    "child",
    "child",
    "child",
  ]);
  expect(threads.slice(4).every((thread) => thread.relationship === "workspace")).toBe(true);
  for (const thread of threads) {
    expect(thread.preview.length).toBeLessThanOrEqual(161);
  }
  expect(result.details.omitted).toBe(190);
  expect(resultText(result)).toContain("+190 more");
});

test("list_threads query finds an older thread by title substring", async () => {
  const childSessionIds = ["child-a", "child-b", "child-c"];
  const { owner } = makeHost({
    childTranscript: [],
    children: childSessionIds.map((sessionId, index) => childRecord(index + 1, sessionId)),
    sessions: sessionEntries(200, childSessionIds),
  });

  const result = await owner.listThreadsToolResult(parentRef, { query: "NEEDLE" });

  const threads = result.details.threads ?? [];
  expect(threads.map((thread) => thread.threadId)).toEqual(["other-3"]);
  expect(result.details.query).toBe("NEEDLE");
  expect(result.details.omitted).toBeUndefined();
  expect(resultText(result)).toContain("needle-in-haystack-1987");
});

test("create result tells the lead the child reports back; non-lead keeps the wait hint", async () => {
  const sessions = [
    {
      id: "parent",
      title: "Parent orchestrator thread",
      updatedAt: createdAt,
      preview: "parent preview",
    },
  ];
  const lead = makeHost({ childTranscript: [], children: [], sessions });
  const leadResult = await lead.owner.createChildThreadToolResult(parentRef, {
    prompt: "Investigate the auth flow.",
    toolCallId: "create-lead",
  });
  const leadText = resultText(leadResult);
  expect(leadText).toContain("reports back automatically");
  expect(leadText).not.toContain("read_thread");
  expect(leadText).not.toContain("wait_seconds");

  const solo = makeHost({ childTranscript: [], children: [], sessions, lead: false });
  const soloResult = await solo.owner.createChildThreadToolResult(parentRef, {
    prompt: "Investigate the auth flow.",
    toolCallId: "create-solo",
  });
  const soloText = resultText(soloResult);
  expect(soloText).toContain("wait_seconds");
  expect(soloText).not.toContain("reports back automatically");
});

test("read running notice tells the lead about the report; non-lead keeps the wait hint", async () => {
  const running = { ...childRecord(1, "child"), status: "running" as const };
  const sessions = [
    {
      id: "parent",
      title: "Parent orchestrator thread",
      updatedAt: createdAt,
      preview: "parent preview",
    },
  ];
  const lead = makeHost({
    childTranscript: [],
    children: [running],
    sessions,
  });
  const leadResult = await lead.owner.readThreadToolResult(parentRef, "child-thread-1");
  expect(leadResult.details.status).toBe("running");
  const leadText = resultText(leadResult);
  expect(leadText).toContain("reports back automatically");
  expect(leadText).not.toContain("read_thread");
  expect(leadText).not.toContain("wait_seconds");

  const solo = makeHost({ childTranscript: [], children: [running], sessions, lead: false });
  const soloResult = await solo.owner.readThreadToolResult(parentRef, "child-thread-1");
  expect(resultText(soloResult)).toContain("wait_seconds");
});

test("listThreadsQueryFromParams trims blanks to undefined", () => {
  expect(listThreadsQueryFromParams(undefined)).toBeUndefined();
  expect(listThreadsQueryFromParams({})).toBeUndefined();
  expect(listThreadsQueryFromParams({ query: "   " })).toBeUndefined();
  expect(listThreadsQueryFromParams({ query: " needle " })).toEqual({ query: "needle" });
});
