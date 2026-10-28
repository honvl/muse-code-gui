import { expect, test } from "@playwright/test";
import type {
  CreateSessionOptions,
  SessionModelSelection,
  SessionRef,
} from "@pi-gui/session-driver";
import {
  DEFAULT_SIDEKICK_THINKING_LEVEL,
  type OrchestrationChildThread,
  type ThinkingLevel,
  type TranscriptMessage,
} from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import { sidekickMatchesLead } from "../../src/features/conversation/model-selector";

const createdAt = "2026-10-27T20:00:00.000Z";
const prompt = "Investigate the auth flow.";
const spawnedSessionId = "spawned-child";
const workspaceDefault: SessionModelSelection = {
  provider: "ws-provider",
  modelId: "ws-model",
};
const sidekick: SessionModelSelection = {
  provider: "sidekick-provider",
  modelId: "sidekick-model",
};

interface CreateSessionCall {
  workspace: { workspaceId: string; path: string };
  options: CreateSessionOptions;
}

function makeHost(options: {
  sidekickMap: Record<string, SessionModelSelection>;
  sessionModelMap?: Record<string, SessionModelSelection>;
  createOptions: CreateSessionOptions | undefined;
  parentSessionId?: string;
  parentIsChild?: boolean;
  scoutModel?: SessionModelSelection;
  sidekickThinkingMap?: Record<string, ThinkingLevel>;
  scoutThinkingLevel?: ThinkingLevel;
  sidekickThinkingDefault?: ThinkingLevel;
}) {
  const parentSessionId = options.parentSessionId ?? "parent";
  const createSessionCalls: CreateSessionCall[] = [];
  let children: readonly OrchestrationChildThread[] = options.parentIsChild
    ? [
        {
          id: "child-record-1",
          parentWorkspaceId: "ws",
          parentSessionId: "grandparent",
          childWorkspaceId: "ws",
          childSessionId: parentSessionId,
          title: "child thread",
          goal: prompt,
          mode: "worker",
          depth: 1,
          status: "running",
          latestTranscript: prompt,
          transcript: [],
          evidence: [],
          createdAt,
          updatedAt: createdAt,
        },
      ]
    : [];
  const childTranscript: TranscriptMessage[] = [
    { kind: "message", role: "user", id: "u1", text: prompt, createdAt },
    { kind: "message", role: "assistant", id: "a1", text: "On it.", createdAt },
  ];
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async (
        workspace: { workspaceId: string; path: string },
        sessionOptions: CreateSessionOptions,
      ) => {
        createSessionCalls.push({ workspace, options: sessionOptions });
        return {
          ref: { workspaceId: "ws", sessionId: spawnedSessionId },
          title: prompt,
          preview: "On it.",
          status: "running",
          updatedAt: createdAt,
        };
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: parentSessionId,
      workspaces: [],
      orchestrationChildren: children,
    }),
    replaceOrchestrationChildren: (next: readonly OrchestrationChildThread[]) => {
      children = [...next];
    },
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === parentSessionId || ref.sessionId === spawnedSessionId
        ? { status: "running", title: "thread", updatedAt: createdAt }
        : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => false,
    sidekickModelFor: (ref: SessionRef) => options.sidekickMap[ref.sessionId],
    defaultScoutModel: () => options.scoutModel,
    sidekickThinkingLevelFor: (ref: SessionRef) => options.sidekickThinkingMap?.[ref.sessionId],
    defaultSidekickThinkingLevel: () =>
      options.sidekickThinkingDefault ?? DEFAULT_SIDEKICK_THINKING_LEVEL,
    defaultScoutThinkingLevel: () => options.scoutThinkingLevel,
    sessionModelFor: (ref: SessionRef) => options.sessionModelMap?.[ref.sessionId],
    buildCreateSessionOptions: async () => options.createOptions,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) => (ref.sessionId === spawnedSessionId ? childTranscript : []),
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
  return { owner, createSessionCalls };
}

test("a configured sidekick becomes the child's initial model", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: { parent: sidekick },
    createOptions: { initialModel: workspaceDefault },
  });

  const result = await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-sidekick" },
  );

  expect(createSessionCalls).toHaveLength(1);
  expect(createSessionCalls[0]?.options.initialModel).toEqual(sidekick);
  expect(result.details.childSessionId).toBe(spawnedSessionId);
});

const scoutModel: SessionModelSelection = { provider: "scout-provider", modelId: "scout-model" };

test("a scout child uses the scout model instead of the thread sidekick", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: { parent: sidekick },
    scoutModel,
    createOptions: { initialModel: workspaceDefault },
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-scout", mode: "scout" },
  );

  expect(createSessionCalls[0]?.options.initialModel).toEqual(scoutModel);
});

test("a worker child ignores the scout model and keeps the thread sidekick", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: { parent: sidekick },
    scoutModel,
    createOptions: { initialModel: workspaceDefault },
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-worker", mode: "worker" },
  );

  expect(createSessionCalls[0]?.options.initialModel).toEqual(sidekick);
});

test("a scout child falls back to the sidekick when no scout model is set", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: { parent: sidekick },
    createOptions: { initialModel: workspaceDefault },
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-scout-fallback", mode: "scout" },
  );

  expect(createSessionCalls[0]?.options.initialModel).toEqual(sidekick);
});

test("no sidekick leaves the workspace default untouched", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: {},
    createOptions: { initialModel: workspaceDefault },
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-default" },
  );

  expect(createSessionCalls).toHaveLength(1);
  expect(createSessionCalls[0]?.options.initialModel).toEqual(workspaceDefault);
  expect(createSessionCalls[0]?.options.initialModel).not.toEqual(sidekick);
});

test("a grandchild inherits the spawning child's model", async () => {
  const childModel: SessionModelSelection = {
    provider: "child-provider",
    modelId: "child-model",
  };
  const { owner, createSessionCalls } = makeHost({
    // The spawning child session has no sidekick config of its own, so the
    // subtree stays on the child's model instead of the workspace default.
    sidekickMap: {},
    sessionModelMap: { "child-1": childModel },
    createOptions: { initialModel: workspaceDefault },
    parentSessionId: "child-1",
    parentIsChild: true,
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "child-1" },
    { prompt, toolCallId: "call-grandchild" },
  );

  expect(createSessionCalls).toHaveLength(1);
  expect(createSessionCalls[0]?.options.initialModel).toEqual(childModel);
});

test("a non-child spawner does not pass its own model down", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: {},
    sessionModelMap: { parent: { provider: "own-provider", modelId: "own-model" } },
    createOptions: { initialModel: workspaceDefault },
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-no-inherit" },
  );

  expect(createSessionCalls).toHaveLength(1);
  expect(createSessionCalls[0]?.options.initialModel).toEqual(workspaceDefault);
});

test("a sidekick reasoning effort becomes the child's initial thinking level", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: { parent: sidekick },
    sidekickThinkingMap: { parent: "low" },
    createOptions: { initialModel: workspaceDefault, initialThinkingLevel: "high" },
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-sidekick-thinking", mode: "worker" },
  );

  expect(createSessionCalls[0]?.options.initialModel).toEqual(sidekick);
  expect(createSessionCalls[0]?.options.initialThinkingLevel).toBe("low");
});

test("a scout uses the scout reasoning effort and a worker ignores it", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: { parent: sidekick },
    scoutModel,
    sidekickThinkingMap: { parent: "medium" },
    scoutThinkingLevel: "minimal",
    createOptions: { initialModel: workspaceDefault },
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-scout-thinking", mode: "scout" },
  );
  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-worker-thinking", mode: "worker" },
  );

  expect(createSessionCalls[0]?.options.initialThinkingLevel).toBe("minimal");
  expect(createSessionCalls[1]?.options.initialThinkingLevel).toBe("medium");
});

test("a scout falls back to the sidekick reasoning effort when no scout effort is set", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: {},
    sidekickThinkingMap: { parent: "xhigh" },
    createOptions: undefined,
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-scout-thinking-fallback", mode: "scout" },
  );

  expect(createSessionCalls[0]?.options.initialThinkingLevel).toBe("xhigh");
});

test("no thread override starts children at the default sidekick reasoning, not the workspace's", async () => {
  const { owner, createSessionCalls } = makeHost({
    sidekickMap: { parent: sidekick },
    createOptions: { initialModel: workspaceDefault, initialThinkingLevel: "medium" },
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-thinking-default-worker", mode: "worker" },
  );
  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-thinking-default-scout", mode: "scout" },
  );

  expect(DEFAULT_SIDEKICK_THINKING_LEVEL).toBe("xhigh");
  expect(createSessionCalls[0]?.options.initialThinkingLevel).toBe("xhigh");
  expect(createSessionCalls[1]?.options.initialThinkingLevel).toBe("xhigh");
});

test("a chosen default sidekick reasoning applies, and the thread badge still wins", async () => {
  const chosen = makeHost({
    sidekickMap: {},
    sidekickThinkingDefault: "low",
    createOptions: { initialThinkingLevel: "high" },
  });
  await chosen.owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-thinking-chosen", mode: "scout" },
  );
  expect(chosen.createSessionCalls[0]?.options.initialThinkingLevel).toBe("low");

  const badge = makeHost({
    sidekickMap: {},
    sidekickThinkingMap: { parent: "medium" },
    sidekickThinkingDefault: "low",
    createOptions: undefined,
  });
  await badge.owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-thinking-badge", mode: "worker" },
  );
  expect(badge.createSessionCalls[0]?.options.initialThinkingLevel).toBe("medium");
});

test("the Lead badge warns only when the effective sidekick is the lead model", () => {
  const lead = { provider: "openai", modelId: "gpt-5" };
  const base = {
    ...lead,
    sidekickProvider: undefined,
    sidekickModelId: undefined,
    defaultProvider: "openai",
    defaultModelId: "gpt-5",
  };
  // No sidekick: children fall back to the workspace default, which is the lead.
  expect(sidekickMatchesLead(base)).toBe(true);
  expect(sidekickMatchesLead({ ...base, defaultModelId: "gpt-4o" })).toBe(false);
  // An explicit sidekick wins over the workspace default either way.
  expect(
    sidekickMatchesLead({ ...base, sidekickProvider: "openai", sidekickModelId: "gpt-4o" }),
  ).toBe(false);
  expect(
    sidekickMatchesLead({
      ...base,
      defaultModelId: "gpt-4o",
      sidekickProvider: "openai",
      sidekickModelId: "gpt-5",
    }),
  ).toBe(true);
  // An unknown lead model never warns.
  expect(sidekickMatchesLead({ ...base, provider: undefined, modelId: undefined })).toBe(false);
});
