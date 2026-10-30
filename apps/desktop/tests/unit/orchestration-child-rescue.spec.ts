import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type {
  OrchestrationChildThread,
  TimelineToolCall,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import {
  createOrchestrationRuntimeTools,
  rescueFromParams,
  sendMessageToThreadAction,
  sendMessageToThreadFromToolOutput,
  sendMessageToThreadToolName,
} from "../../electron/orchestration/orchestration-runtime";
import {
  childStuckReportText,
  createOrchestrationOwner,
  describeRunningToolCall,
  formatToolElapsedMs,
  isStuckToolCall,
  resolveStuckToolThresholdMs,
  runningToolCalls,
  runningToolHint,
  stuckToolCall,
  toolLastActivityMs,
  DEFAULT_STUCK_TOOL_MS,
} from "../../electron/orchestration/app-store-orchestration";

const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
const childRef: SessionRef = { workspaceId: "ws", sessionId: "child" };
const createdAt = "2026-10-27T20:00:00.000Z";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function minutesAgo(minutes: number, base = NOW): string {
  return new Date(base - minutes * 60_000).toISOString();
}

/** Owner paths (list/read/rescue) stamp hints with the real clock. */
function liveMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function toolRow(overrides: Partial<TimelineToolCall> = {}): TimelineToolCall {
  return {
    kind: "tool",
    id: "call-1",
    callId: "call-1",
    toolName: "bash",
    status: "running",
    label: "Ran bash: sleep 120",
    createdAt: minutesAgo(14),
    input: { command: "sleep 120" },
    ...overrides,
  };
}

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

test("stuck threshold defaults to ten minutes; env overrides, junk falls back", () => {
  expect(DEFAULT_STUCK_TOOL_MS).toBe(10 * 60_000);
  expect(resolveStuckToolThresholdMs({})).toBe(DEFAULT_STUCK_TOOL_MS);
  expect(resolveStuckToolThresholdMs({ PI_APP_CHILD_STUCK_TOOL_MS: "60000" })).toBe(60_000);
  for (const junk of ["abc", "0", "-5", "1.5", ""]) {
    expect(resolveStuckToolThresholdMs({ PI_APP_CHILD_STUCK_TOOL_MS: junk })).toBe(
      DEFAULT_STUCK_TOOL_MS,
    );
  }
});

test("elapsed formatting stays short", () => {
  expect(formatToolElapsedMs(45_000)).toBe("45s");
  expect(formatToolElapsedMs(14 * 60_000)).toBe("14m");
  expect(formatToolElapsedMs(125 * 60_000)).toBe("2h5m");
});

test("running rows sort oldest first; finished rows are ignored", () => {
  const rows = runningToolCalls([
    toolRow({ callId: "new", id: "new", createdAt: minutesAgo(2) }),
    { ...toolRow({ callId: "old", id: "old", createdAt: minutesAgo(20) }) },
    { ...toolRow({ callId: "done", id: "done", status: "success" as const }) },
  ]);
  expect(rows.map((row) => row.callId)).toEqual(["old", "new"]);
});

test("a tool past the threshold with no updates is stuck; updates reset the clock", () => {
  const stuck = toolRow({ createdAt: minutesAgo(14) });
  expect(isStuckToolCall(stuck, NOW, DEFAULT_STUCK_TOOL_MS)).toBe(true);
  expect(stuckToolCall([stuck], NOW, DEFAULT_STUCK_TOOL_MS)?.callId).toBe("call-1");
  const fresh = toolRow({ createdAt: minutesAgo(2) });
  expect(isStuckToolCall(fresh, NOW, DEFAULT_STUCK_TOOL_MS)).toBe(false);
  expect(stuckToolCall([fresh], NOW, DEFAULT_STUCK_TOOL_MS)).toBeUndefined();
  // A tool that started long ago but streamed output recently is not stuck.
  const streaming = toolRow({ createdAt: minutesAgo(30), updatedAt: minutesAgo(1) });
  expect(toolLastActivityMs(streaming, NOW)).toBe(Date.parse(minutesAgo(1)));
  expect(isStuckToolCall(streaming, NOW, DEFAULT_STUCK_TOOL_MS)).toBe(false);
  expect(stuckToolCall([streaming], NOW, DEFAULT_STUCK_TOOL_MS)).toBeUndefined();
});

test("the running-tool description names the tool, its input, and its age", () => {
  expect(describeRunningToolCall(toolRow(), NOW)).toBe('bash "sleep 120" for 14m');
  expect(describeRunningToolCall(toolRow({ input: undefined }), NOW)).toBe("bash for 14m");
});

test("flags a tool that ran past any reasonable bound with no output", () => {
  // Mirrors the 23-minute hung test run: a bash tool stuck for 25 minutes
  // with no output updates is stuck, and the lead's notice names the rescue.
  const hung = toolRow({ createdAt: minutesAgo(25), updatedAt: minutesAgo(25) });
  expect(isStuckToolCall(hung, NOW, DEFAULT_STUCK_TOOL_MS)).toBe(true);
  const hint = runningToolHint([hung], NOW, DEFAULT_STUCK_TOOL_MS);
  expect(hint?.stuck).toBe(true);
  expect(hint?.idleFor).toBe("25m");
  expect(
    childStuckReportText({
      childTitle: "Hung run",
      childThreadId: "child-1",
      toolDescription: hint?.description ?? "",
      idleFor: hint?.idleFor ?? "",
      threshold: formatToolElapsedMs(DEFAULT_STUCK_TOOL_MS),
    }),
  ).toContain("rescue:true");
});

test("runningToolHint prefers the stuck tool and reports its idle time", () => {
  const hint = runningToolHint(
    [toolRow({ callId: "a", id: "a", createdAt: minutesAgo(2) }), toolRow()],
    NOW,
    DEFAULT_STUCK_TOOL_MS,
  );
  expect(hint?.description).toBe('bash "sleep 120" for 14m');
  expect(hint?.stuck).toBe(true);
  expect(hint?.idleFor).toBe("14m");
  expect(runningToolHint([], NOW)).toBeUndefined();
  expect(
    runningToolHint([toolRow({ createdAt: minutesAgo(2) })], NOW, DEFAULT_STUCK_TOOL_MS)?.stuck,
  ).toBe(false);
});

test("stuck report text names the child, the tool, and the rescue flag", () => {
  const text = childStuckReportText({
    childTitle: "Trace the plumbing",
    childThreadId: "child-thread-1",
    toolDescription: 'bash "sleep 120" for 14m',
    idleFor: "14m",
    threshold: "10m",
  });
  expect(text).toContain("Trace the plumbing");
  expect(text).toContain("child-thread-1");
  expect(text).toContain('bash "sleep 120" for 14m');
  expect(text).toContain("14m");
  expect(text).toContain("rescue:true");
  expect(text).toContain("once per tool call");
});

test("rescue param parses like interrupt: only explicit true counts", () => {
  expect(rescueFromParams({ rescue: true })).toBe(true);
  expect(rescueFromParams({})).toBeUndefined();
  expect(rescueFromParams({ rescue: false })).toBeUndefined();
  expect(rescueFromParams({ rescue: "true" })).toBeUndefined();
});

test("send_message_to_thread exposes rescue and forwards it to the bridge", async () => {
  const sent: Array<{
    threadId: string;
    message: string;
    interrupt?: boolean;
    rescue?: boolean;
  }> = [];
  const bridge = {
    createChildThread: async () => {
      throw new Error("not used");
    },
    listThreads: async () => {
      throw new Error("not used");
    },
    readThread: async () => {
      throw new Error("not used");
    },
    sendMessageToThread: async (
      _ctx: unknown,
      input: {
        readonly threadId: string;
        readonly message: string;
        readonly interrupt?: boolean;
        readonly rescue?: boolean;
      },
    ) => {
      sent.push({ ...input });
      return { content: [{ type: "text" as const, text: "ok" }], details: {} as never };
    },
  };
  const tool = createOrchestrationRuntimeTools(
    bridge as unknown as Parameters<typeof createOrchestrationRuntimeTools>[0],
  ).find((entry) => entry.name === sendMessageToThreadToolName);
  expect(tool).toBeDefined();
  const parameters = tool?.parameters as { properties?: Record<string, unknown> } | undefined;
  expect(parameters?.properties).toMatchObject({ rescue: { type: "boolean" } });
  expect((tool?.promptGuidelines ?? []).some((line) => line.includes("rescue"))).toBe(true);

  await tool?.execute(
    "call-rescue",
    { thread_id: "child", message: "retry bounded", rescue: true },
    undefined,
    undefined,
    {},
  );
  expect(sent).toEqual([{ threadId: "child", message: "retry bounded", rescue: true }]);

  await tool?.execute(
    "call-plain",
    { thread_id: "child", message: "keep going" },
    undefined,
    undefined,
    {},
  );
  expect(sent[1]).toEqual({ threadId: "child", message: "keep going" });
});

test("send_message_to_thread replay never replays rescue, like interrupt", () => {
  const request = sendMessageToThreadFromToolOutput({
    details: { action: sendMessageToThreadAction, threadId: "child-thread-1", message: "go" },
  });
  expect(request).toEqual({ threadId: "child-thread-1", message: "go" });
});

interface RescueHostState {
  childStatus: string;
  orchestrator: boolean;
  childTranscript: TranscriptMessage[];
  childRecordStatus?: OrchestrationChildThread["status"];
}

function makeRescueHost(state: RescueHostState) {
  const rescueCalls: Array<{ ref: SessionRef; options?: unknown }> = [];
  let rescueOutcome: { forced: boolean } = { forced: true };
  const cancelCalls: SessionRef[] = [];
  const sentCustom: Array<{ sessionRef: SessionRef; input: unknown; options?: unknown }> = [];
  const submitted: Array<{ sessionRef: SessionRef; text: string; options?: unknown }> = [];
  const child = childRecord(state.childRecordStatus ? { status: state.childRecordStatus } : {});
  const host = {
    driver: {
      cancelCurrentRun: async (ref: SessionRef) => {
        cancelCalls.push(ref);
      },
      rescueCurrentRun: async (ref: SessionRef, options?: unknown) => {
        rescueCalls.push({ ref, options });
        return rescueOutcome;
      },
      createSession: async () => {
        throw new Error("not used");
      },
      getSessionTree: async () => {
        throw new Error("not used");
      },
      setChildIsolation: () => {},
      setSessionThinkingLevel: async () => {},
      sendCustomMessage: async (
        sessionRef: SessionRef,
        input: { customType: string; text: string; display?: boolean },
        options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
      ) => {
        sentCustom.push({ sessionRef, input, ...(options ? { options } : {}) });
      },
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [
        {
          id: "ws",
          sessions: [
            {
              id: "parent",
              title: "Parent",
              status: "running",
              updatedAt: createdAt,
              preview: "",
            },
            {
              id: "child",
              title: child.title,
              status: state.childStatus,
              updatedAt: createdAt,
              preview: "",
            },
          ],
        },
      ],
      orchestrationChildren: [
        state.childRecordStatus ? { ...child, status: state.childRecordStatus } : child,
      ],
    }),
    replaceOrchestrationChildren: () => {},
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === "child"
        ? { status: state.childStatus, title: child.title, updatedAt: createdAt }
        : ref.sessionId === "parent"
          ? { status: "running", title: "Parent", updatedAt: createdAt }
          : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: (ref: SessionRef) =>
      ref.sessionId === parentRef.sessionId && state.orchestrator,
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultScoutThinkingLevel: () => undefined,
    sessionModelFor: () => undefined,
    sessionThinkingLevelFor: () => undefined,
    sessionUsageFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    createChildWorktree: async () => {
      throw new Error("not used");
    },
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) =>
      ref.sessionId === childRef.sessionId ? state.childTranscript : [],
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (
      sessionRef: SessionRef,
      text: string,
      _attachments: readonly unknown[],
      options?: { readonly deliverAs?: "steer" | "followUp"; readonly allowCommands?: boolean },
    ) => {
      submitted.push({ sessionRef, text, ...(options ? { options } : {}) });
      return {} as never;
    },
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return {
    owner,
    rescueCalls,
    cancelCalls,
    sentCustom,
    submitted,
    setRescueOutcome: (outcome: { forced: boolean }) => {
      rescueOutcome = outcome;
    },
  };
}

test("rescue aborts the run, force-flags the result, and starts a new turn", async () => {
  const host = makeRescueHost({
    childStatus: "running",
    orchestrator: true,
    childTranscript: [toolRow()],
  });
  const result = await host.owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child-thread-1",
    message: "retry with a bounded command",
    rescue: true,
  });
  expect(host.rescueCalls.length).toBe(1);
  expect(host.rescueCalls[0]?.ref).toEqual(childRef);
  expect(host.cancelCalls.length).toBe(0);
  expect(result.details.action).toBe(sendMessageToThreadAction);
  expect(result.details.rescued).toBe(true);
  expect(result.details.forced).toBe(true);
  expect(result.details.interrupted).toBeUndefined();
  expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
    "Rescued thread child-thread-1 (abort never settled; run force-stopped)",
  );
  expect(host.submitted.length).toBe(1);
  expect(host.submitted[0]).toMatchObject({
    sessionRef: childRef,
    text: "retry with a bounded command",
    options: { deliverAs: "followUp", allowCommands: false },
  });
});

test("rescue reports a settled abort without the forced flag", async () => {
  const host = makeRescueHost({
    childStatus: "running",
    orchestrator: true,
    childTranscript: [toolRow()],
  });
  host.setRescueOutcome({ forced: false });
  const result = await host.owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child-thread-1",
    message: "go on",
    rescue: true,
  });
  expect(result.details.rescued).toBe(true);
  expect(result.details.forced).toBeUndefined();
  expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
    "Rescued thread child-thread-1 and started a new turn.",
  );
});

test("rescuing an idle child behaves like a normal interrupt", async () => {
  const host = makeRescueHost({
    childStatus: "idle",
    orchestrator: true,
    childTranscript: [],
    childRecordStatus: "idle",
  });
  const result = await host.owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child-thread-1",
    message: "ping",
    rescue: true,
  });
  expect(host.rescueCalls.length).toBe(0);
  expect(host.cancelCalls.length).toBe(0);
  expect(result.details.rescued).toBeUndefined();
  expect(host.submitted.length).toBe(1);
});

test("interrupt without rescue still cancels instead of rescuing", async () => {
  const host = makeRescueHost({
    childStatus: "running",
    orchestrator: true,
    childTranscript: [toolRow()],
  });
  const result = await host.owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child-thread-1",
    message: "hold on",
    interrupt: true,
  });
  expect(host.cancelCalls.length).toBe(1);
  expect(host.rescueCalls.length).toBe(0);
  expect(result.details.interrupted).toBe(true);
  expect(result.details.rescued).toBeUndefined();
});

test("list_threads shows the in-flight tool and the stuck flag", async () => {
  const host = makeRescueHost({
    childStatus: "running",
    orchestrator: true,
    childTranscript: [toolRow({ createdAt: liveMinutesAgo(14) })],
  });
  const result = host.owner.listThreadsToolResult(parentRef, {});
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  expect(text).toContain('[running: bash "sleep 120" for ');
  expect(text).toContain("STUCK");
  const childEntry = (result.details.threads ?? []).find(
    (entry) => entry.childThreadId === "child-thread-1",
  );
  expect(childEntry?.runningTool).toContain('bash "sleep 120" for ');
  expect(childEntry?.stuck).toBe(true);
});

test("list_threads omits the hint when nothing is in flight", async () => {
  const host = makeRescueHost({
    childStatus: "running",
    orchestrator: true,
    childTranscript: [],
  });
  const result = host.owner.listThreadsToolResult(parentRef, {});
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  expect(text).not.toContain("[running:");
});

test("read_thread flags the stuck tool and notifies the lead once", async () => {
  process.env.PI_APP_CHILD_STUCK_TOOL_MS = "60000";
  try {
    const transcript = [toolRow({ createdAt: liveMinutesAgo(14), updatedAt: liveMinutesAgo(14) })];
    const host = makeRescueHost({
      childStatus: "running",
      orchestrator: true,
      childTranscript: transcript,
    });
    const first = await host.owner.readThreadToolResult(parentRef, "child-thread-1", {}, new Map());
    const firstText = first.content[0]?.type === "text" ? first.content[0].text : "";
    expect(firstText).toContain("in flight:");
    expect(firstText).toContain("STUCK");
    expect(firstText).toContain("rescue:true");
    expect(host.sentCustom.length).toBe(1);
    expect(host.sentCustom[0]?.input).toMatchObject({
      customType: "pi-gui.child-stuck",
      display: true,
    });
    expect(host.sentCustom[0]?.options).toMatchObject({
      triggerTurn: true,
      deliverAs: "followUp",
    });
    const second = await host.owner.readThreadToolResult(
      parentRef,
      "child-thread-1",
      {},
      new Map(),
    );
    expect(second.content[0]?.type === "text" ? second.content[0].text : "").toContain("STUCK");
    expect(host.sentCustom.length).toBe(1);
  } finally {
    delete process.env.PI_APP_CHILD_STUCK_TOOL_MS;
  }
});

test("read_thread sends no stuck notice to non-lead parents", async () => {
  process.env.PI_APP_CHILD_STUCK_TOOL_MS = "60000";
  try {
    const host = makeRescueHost({
      childStatus: "running",
      orchestrator: false,
      childTranscript: [toolRow({ createdAt: liveMinutesAgo(14), updatedAt: liveMinutesAgo(14) })],
    });
    const result = await host.owner.readThreadToolResult(
      parentRef,
      "child-thread-1",
      {},
      new Map(),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("STUCK");
    expect(host.sentCustom.length).toBe(0);
  } finally {
    delete process.env.PI_APP_CHILD_STUCK_TOOL_MS;
  }
});

test("read_thread stays quiet when the tool is still fresh", async () => {
  const host = makeRescueHost({
    childStatus: "running",
    orchestrator: true,
    childTranscript: [toolRow({ createdAt: liveMinutesAgo(2) })],
  });
  const result = await host.owner.readThreadToolResult(parentRef, "child-thread-1", {}, new Map());
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  expect(text).toContain("in flight:");
  expect(text).not.toContain("STUCK");
  expect(host.sentCustom.length).toBe(0);
});
