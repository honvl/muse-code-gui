import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import {
  CHILD_REPORT_SUFFIX,
  DEFAULT_SUCCESS_CRITERIA,
  DEFAULT_VERIFY,
  SCOPE_BRIEF_WARNING,
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

// Budget seeds are scouts: they count toward the delegation budget but never
// hold the single-writer slot, so the budget check (phase B) is what fires,
// not the writer-scope refusal (phase A, which runs first). A worker seed
// with no writeScopes claims the whole workspace and would refuse first.
function seedChild(n: number, mode: "scout" | "worker" = "scout"): OrchestrationChildThread {
  return {
    id: `seed-child-${n}`,
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: `child-session-${n}`,
    title: `Seed child ${n}`,
    goal: `Seed goal ${n}`,
    mode,
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
    sidekickThinkingLevelFor: () => undefined,
    defaultSidekickThinkingLevel: () => "xhigh" as const,
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
    scope: "slice-over-budget",
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
  // Scout seeds hold no writer slot; each fresh worker spawn takes a disjoint
  // scope so consecutive spawns refuse on budget, not on each other.
  const children = Array.from({ length: 28 }, (_, index) => seedChild(index + 1));
  const { owner, createSessionCalls } = makeHost({
    children,
    childStatus: "running",
    childTranscript: [userMessage("u1", prompt), assistantMessage("a1", "Working.")],
  });

  const first = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-a",
    scope: "slice-a",
  });
  expect(first.details.error).toBeUndefined();
  expect(first.details.delegationsRemaining).toBe(1);
  expect(resultText(first)).toContain("delegationsRemaining: 1");

  const second = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-b",
    scope: "slice-b",
  });
  expect(second.details.error).toBeUndefined();
  expect(second.details.delegationsRemaining).toBe(0);

  const third = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    toolCallId: "call-c",
    scope: "slice-c",
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
      scope: "slice-env",
    });
    expect(result.details.error).toContain(
      "Delegation budget exhausted (2 children on this thread).",
    );
    expect(createSessionCalls).toHaveLength(0);
  } finally {
    delete process.env.PI_APP_ORCHESTRATION_MAX_CHILDREN;
  }
});

test("brief hint appears when scope is missing and never reaches the child prompt", async () => {
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

  // success_criteria and verify fall back to host defaults, so only a missing
  // scope still warns. Warnings ride the tool result; the child brief is
  // untouched by them but carries the defaults plus the report suffix.
  const result = await tool!.execute(
    "call-1",
    { prompt: "Probe the cache." },
    undefined,
    undefined,
    {},
  );
  expect(result.details).toMatchObject({ briefWarnings: [SCOPE_BRIEF_WARNING] });
  expect(resultText(result)).toContain(SCOPE_BRIEF_WARNING);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.prompt).not.toContain("Brief hint");
  expect(seen[0]?.prompt).toContain(CHILD_REPORT_SUFFIX);
  expect(seen[0]?.prompt).toContain(DEFAULT_SUCCESS_CRITERIA);
  expect(seen[0]?.prompt).toContain(DEFAULT_VERIFY);

  const full = await tool!.execute(
    "call-2",
    {
      prompt: "Probe the cache.",
      scope: "apps/desktop",
      success_criteria: "A written summary.",
      verify: "Run the cache spec.",
    },
    undefined,
    undefined,
    {},
  );
  expect("briefWarnings" in (full.details as Record<string, unknown>)).toBe(false);
  expect(resultText(full)).not.toContain("Brief hint");
  expect(seen).toHaveLength(2);
  expect(seen[1]?.prompt).toContain("Scope: apps/desktop");
  expect(seen[1]?.prompt).toContain("A written summary.");
  expect(seen[1]?.prompt).toContain("Run the cache spec.");
  expect(seen[1]?.prompt).not.toContain(DEFAULT_SUCCESS_CRITERIA);

  const scoped = await tool!.execute(
    "call-3",
    { prompt: "Probe the cache.", scope: "apps/desktop" },
    undefined,
    undefined,
    {},
  );
  expect("briefWarnings" in (scoped.details as Record<string, unknown>)).toBe(false);
  expect(resultText(scoped)).not.toContain("Brief hint");
  // A thin brief still spawns; the hint never blocks.
  expect(seen).toHaveLength(3);
});

test("child report suffix carries the character budget", () => {
  expect(CHILD_REPORT_SUFFIX).toContain("~800 characters");
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
