import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import {
  CHILD_REPORT_SUFFIX,
  SUCCESS_CRITERIA_BRIEF_WARNING,
  createChildThreadAction,
  createChildThreadToolName,
  createOrchestrationRuntimeTools,
} from "../../electron/orchestration/orchestration-runtime";
import {
  countChildrenForParent,
  createOrchestrationOwner,
  delegationBudgetExceededMessage,
  resolveDelegationBudgetLimit,
} from "../../electron/orchestration/app-store-orchestration";

const createdAt = "2026-10-28T00:00:00.000Z";
const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
const prompt = "Do the investigation.";

function seedChild(n: number): OrchestrationChildThread {
  return {
    id: `seed-child-${n}`,
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: `child-session-${n}`,
    title: `Seed child ${n}`,
    goal: `Seed goal ${n}`,
    mode: "worker",
    depth: 1,
    status: "running",
    latestTranscript: `Seed goal ${n}`,
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function userMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "user", id, text, createdAt };
}

function assistantMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "assistant", id, text, createdAt };
}

interface BudgetHostState {
  children: OrchestrationChildThread[];
  childStatus: "running" | "idle";
  childTranscript: TranscriptMessage[];
}

function makeHost(state: BudgetHostState) {
  const createSessionCalls: string[] = [];
  let counter = state.children.length;
  const sent: string[] = [];
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => {
        counter += 1;
        const sessionId = `spawned-${counter}`;
        createSessionCalls.push(sessionId);
        return {
          ref: { workspaceId: "ws", sessionId },
          title: `Spawned ${counter}`,
          preview: "",
          status: "running",
          updatedAt: createdAt,
        };
      },
      setChildIsolation: () => {},
      sendCustomMessage: async (
        _ref: SessionRef,
        input: { customType: string; text: string; display?: boolean },
      ) => {
        sent.push(input.text);
      },
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [],
      orchestrationChildren: state.children,
    }),
    replaceOrchestrationChildren: (next: readonly OrchestrationChildThread[]) => {
      state.children = [...next];
    },
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) => {
      if (ref.sessionId === parentRef.sessionId) {
        return { status: "running", title: "Parent", updatedAt: createdAt };
      }
      if (state.children.some((child) => child.childSessionId === ref.sessionId)) {
        return { status: state.childStatus, title: "Child", updatedAt: createdAt };
      }
      return undefined;
    },
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: (ref: SessionRef) => ref.sessionId === parentRef.sessionId,
    sidekickModelFor: () => undefined,
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) =>
      ref.sessionId === parentRef.sessionId ? [] : state.childTranscript,
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async () => ({}) as never,
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, createSessionCalls, sent };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

test("create_child_thread refuses with actionable text at the delegation budget", async () => {
  const children = Array.from({ length: 30 }, (_, index) => seedChild(index + 1));
  const { owner, createSessionCalls } = makeHost({
    children,
    childStatus: "running",
    childTranscript: [],
  });

  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt: "One more slice.",
    toolCallId: "call-over-budget",
  });

  expect(createSessionCalls).toHaveLength(0);
  expect(result.details.action).toBe(createChildThreadAction);
  expect(result.details.childThreadId).toBeUndefined();
  expect(result.details.error).toContain(
    "Delegation budget exhausted (30 children on this thread).",
  );
  expect(resultText(result)).toContain("continue an existing child with send_message_to_thread");
  expect(result.details.delegationsRemaining).toBe(0);
});

test("delegationsRemaining decrements with each spawn", async () => {
  const children = Array.from({ length: 28 }, (_, index) => seedChild(index + 1));
  const { owner, createSessionCalls } = makeHost({
    children,
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const first = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-a",
  });
  expect(first.details.error).toBeUndefined();
  expect(first.details.delegationsRemaining).toBe(1);
  expect(resultText(first)).toContain("delegationsRemaining: 1");

  const second = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-b",
  });
  expect(second.details.error).toBeUndefined();
  expect(second.details.delegationsRemaining).toBe(0);

  const third = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-c",
  });
  expect(third.details.error).toContain("Delegation budget exhausted");
  expect(createSessionCalls).toHaveLength(2);
});

test("PI_APP_ORCHESTRATION_MAX_CHILDREN overrides the budget; junk is ignored", async () => {
  expect(resolveDelegationBudgetLimit({})).toBe(30);
  expect(resolveDelegationBudgetLimit({ PI_APP_ORCHESTRATION_MAX_CHILDREN: "3" })).toBe(3);
  expect(resolveDelegationBudgetLimit({ PI_APP_ORCHESTRATION_MAX_CHILDREN: " 4 " })).toBe(4);
  expect(resolveDelegationBudgetLimit({ PI_APP_ORCHESTRATION_MAX_CHILDREN: "0" })).toBe(30);
  expect(resolveDelegationBudgetLimit({ PI_APP_ORCHESTRATION_MAX_CHILDREN: "-2" })).toBe(30);
  expect(resolveDelegationBudgetLimit({ PI_APP_ORCHESTRATION_MAX_CHILDREN: "junk" })).toBe(30);
  expect(resolveDelegationBudgetLimit({ PI_APP_ORCHESTRATION_MAX_CHILDREN: "2.5" })).toBe(30);
  expect(countChildrenForParent([seedChild(1), seedChild(2)], "ws", "parent")).toBe(2);
  expect(countChildrenForParent([seedChild(1)], "ws", "other")).toBe(0);
  expect(delegationBudgetExceededMessage(2)).toContain("send_message_to_thread");

  process.env.PI_APP_ORCHESTRATION_MAX_CHILDREN = "2";
  try {
    const { owner, createSessionCalls } = makeHost({
      children: [seedChild(1), seedChild(2)],
      childStatus: "running",
      childTranscript: [],
    });
    const result = await owner.createChildThreadToolResult(parentRef, {
      prompt: "One more.",
      toolCallId: "call-env",
    });
    expect(result.details.error).toContain(
      "Delegation budget exhausted (2 children on this thread).",
    );
    expect(createSessionCalls).toHaveLength(0);
  } finally {
    delete process.env.PI_APP_ORCHESTRATION_MAX_CHILDREN;
  }
});

test("brief hint appears when success_criteria is missing and never reaches the child prompt", async () => {
  const seen: Array<{ prompt: string }> = [];
  const bridge = {
    createChildThread: async (_ctx: unknown, input: { prompt: string }) => {
      seen.push({ prompt: input.prompt });
      return {
        content: [{ type: "text" as const, text: "Created child thread: Probe" }],
        details: {
          action: createChildThreadAction,
          prompt: input.prompt,
          childThreadId: "thread-1",
        },
      };
    },
    listThreads: async (): Promise<never> => {
      throw new Error("not used");
    },
    readThread: async (): Promise<never> => {
      throw new Error("not used");
    },
    sendMessageToThread: async (): Promise<never> => {
      throw new Error("not used");
    },
  };
  const tool = createOrchestrationRuntimeTools(
    bridge as unknown as Parameters<typeof createOrchestrationRuntimeTools>[0],
  ).find((entry) => entry.name === createChildThreadToolName);
  expect(tool).toBeDefined();

  const result = await tool!.execute(
    "call-1",
    { prompt: "Probe the cache.", scope: "apps/desktop" },
    undefined,
    undefined,
    {},
  );
  expect(result.details).toMatchObject({ briefWarnings: [SUCCESS_CRITERIA_BRIEF_WARNING] });
  expect(resultText(result)).toContain(
    "Brief hint: add success_criteria so the child can self-check.",
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.prompt).not.toContain("Brief hint");
  expect(seen[0]?.prompt).toContain(CHILD_REPORT_SUFFIX);

  const full = await tool!.execute(
    "call-2",
    { prompt: "Probe the cache.", scope: "apps/desktop", success_criteria: "A written summary." },
    undefined,
    undefined,
    {},
  );
  expect("briefWarnings" in (full.details as Record<string, unknown>)).toBe(false);
  expect(resultText(full)).not.toContain("Brief hint");

  const thin = await tool!.execute(
    "call-3",
    { prompt: "Probe the cache." },
    undefined,
    undefined,
    {},
  );
  const hintLines = resultText(thin)
    .split("\n")
    .filter((line) => line.includes("Brief hint"));
  expect(hintLines).toHaveLength(1);
  expect(hintLines[0]).toContain("add scope");
  expect(hintLines[0]).toContain("add success_criteria");
});

test("child report suffix carries the character budget", () => {
  expect(CHILD_REPORT_SUFFIX).toContain("~1200 characters");
});

test("injected report marks host-side truncation explicitly", async () => {
  const state: BudgetHostState = {
    children: [],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", `R${"e".repeat(5000)}`)],
  };
  const { owner, sent } = makeHost(state);

  const created = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-truncate",
  });
  const childSessionId = created.details.childSessionId;
  expect(childSessionId).toBeDefined();

  // The run ends with a final answer far beyond the host-side report cap.
  state.childStatus = "idle";
  await owner.reportChildCompletion({ workspaceId: "ws", sessionId: childSessionId! });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("…(report truncated; call read_thread for detail)");
  expect(sent[0]).not.toContain("e".repeat(5000));
});

test("generation is 1 on create and 2 after a follow-up, and appears in the report text", async () => {
  const state: BudgetHostState = {
    children: [],
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "First run done.")],
  };
  const { owner, sent } = makeHost(state);

  const created = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-gen",
  });
  expect(created.details.generation).toBe(1);
  const childThreadId = created.details.childThreadId;
  const childSessionId = created.details.childSessionId;
  expect(childThreadId).toBeDefined();
  expect(childSessionId).toBeDefined();

  const followed = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: childThreadId!,
    message: "One more pass.",
  });
  expect(followed.details.error).toBeUndefined();
  expect(followed.details.generation).toBe(2);

  state.childStatus = "idle";
  await owner.reportChildCompletion({ workspaceId: "ws", sessionId: childSessionId! });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain(`thread_id: ${childThreadId} (run 2)`);
});
