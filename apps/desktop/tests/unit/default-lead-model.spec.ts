import { expect, test } from "@playwright/test";
import type { SessionModelSelection, SessionRef } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/desktop-state";
import {
  defaultLeadModelForLeadToggle,
  preLeadModelForSoloToggle,
  resolveInitialModelForLeadThread,
} from "../../electron/application/default-lead-model";
import { isDefaultScoutModelEqual } from "../../electron/application/default-scout-model";
import { startThread } from "../../electron/workspace/app-store-worktree";
import { createConversationOwner } from "../../electron/conversation/app-store-composer";
import { expectDefaultLeadModelSelection } from "../../electron/ipc/request-validation";

test("default lead validation clears on null and trims", () => {
  expect(expectDefaultLeadModelSelection(null)).toBeNull();
  expect(expectDefaultLeadModelSelection({ provider: "  wafer ", modelId: " m " })).toEqual({
    provider: "wafer",
    modelId: "m",
  });
  expect(() => expectDefaultLeadModelSelection({ provider: "", modelId: "m" })).toThrow();
  expect(() => expectDefaultLeadModelSelection({ provider: "a" })).toThrow();
  expect(() => expectDefaultLeadModelSelection("acme")).toThrow();
});

const createdAt = "2026-10-27T20:00:00.000Z";
const defaultLead: SessionModelSelection = {
  provider: "wafer",
  modelId: "deepseek-v4-1-flash",
};
const workspaceDefault: SessionModelSelection = {
  provider: "ws-provider",
  modelId: "ws-model",
};
const explicit: SessionModelSelection = {
  provider: "explicit-provider",
  modelId: "explicit-model",
};

function userMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "user", id, text, createdAt } as TranscriptMessage;
}

function assistantMessage(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "assistant", id, text, createdAt } as TranscriptMessage;
}

function toolRow(): TranscriptMessage {
  return {
    kind: "tool",
    id: "tool-1",
    callId: "call-1",
    toolName: "read",
    status: "success",
    label: "Read file",
    createdAt,
  } as TranscriptMessage;
}

test("create-with-lead uses default", async () => {
  const resolved = resolveInitialModelForLeadThread({
    orchestratorMode: true,
    defaultLeadModel: defaultLead,
    workspaceInitialModel: workspaceDefault,
  });
  expect(resolved).toEqual(defaultLead);

  const createSessionCalls: { options: { initialModel?: SessionModelSelection } }[] = [];
  const host = {
    initialize: async () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    resolveExtensionFlags: async () => ({ applied: {}, chosen: {} }),
    buildCreateSessionOptions: async () => ({ initialModel: workspaceDefault }),
    defaultLeadModel: () => defaultLead,
    driver: {
      createSession: async (
        _workspace: unknown,
        options: { initialModel?: SessionModelSelection },
      ) => {
        createSessionCalls.push({ options });
        return {
          ref: { workspaceId: "ws", sessionId: "new" },
          title: "New thread",
          preview: "",
          status: "idle",
          updatedAt: createdAt,
        };
      },
    },
    seedSession: () => {},
    recordExtensionFlags: () => {},
    setPendingAutoTitle: () => {},
    clearPendingAutoTitle: () => {},
    setActiveSession: () => {},
    refreshState: async () => ({}) as never,
    withErrorHandling: async (fn: () => Promise<never>) => fn(),
    withError: async () => ({}) as never,
  };
  await startThread(host as never, {
    rootWorkspaceId: "ws",
    environment: "local",
    orchestratorMode: true,
  });

  expect(createSessionCalls).toHaveLength(1);
  expect(createSessionCalls[0]?.options.initialModel).toEqual(defaultLead);
});

test("explicit model wins", async () => {
  const resolved = resolveInitialModelForLeadThread({
    explicitProvider: explicit.provider,
    explicitModelId: explicit.modelId,
    orchestratorMode: true,
    defaultLeadModel: defaultLead,
    workspaceInitialModel: workspaceDefault,
  });
  expect(resolved).toEqual(explicit);

  const createSessionCalls: { options: { initialModel?: SessionModelSelection } }[] = [];
  const host = {
    initialize: async () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    resolveExtensionFlags: async () => ({ applied: {}, chosen: {} }),
    buildCreateSessionOptions: async () => ({ initialModel: workspaceDefault }),
    defaultLeadModel: () => defaultLead,
    driver: {
      createSession: async (
        _workspace: unknown,
        options: { initialModel?: SessionModelSelection },
      ) => {
        createSessionCalls.push({ options });
        return {
          ref: { workspaceId: "ws", sessionId: "new" },
          title: "New thread",
          preview: "",
          status: "idle",
          updatedAt: createdAt,
        };
      },
    },
    seedSession: () => {},
    recordExtensionFlags: () => {},
    setPendingAutoTitle: () => {},
    clearPendingAutoTitle: () => {},
    setActiveSession: () => {},
    refreshState: async () => ({}) as never,
    withErrorHandling: async (fn: () => Promise<never>) => fn(),
    withError: async () => ({}) as never,
  };
  await startThread(host as never, {
    rootWorkspaceId: "ws",
    environment: "local",
    orchestratorMode: true,
    provider: explicit.provider,
    modelId: explicit.modelId,
  });

  expect(createSessionCalls).toHaveLength(1);
  expect(createSessionCalls[0]?.options.initialModel).toEqual(explicit);
});

test("setting cleared is a no-op", async () => {
  expect(
    resolveInitialModelForLeadThread({
      orchestratorMode: true,
      defaultLeadModel: undefined,
      workspaceInitialModel: workspaceDefault,
    }),
  ).toEqual(workspaceDefault);
  expect(defaultLeadModelForLeadToggle({ defaultLeadModel: undefined })).toBeUndefined();
  expect(isDefaultScoutModelEqual(undefined, null)).toBe(true);
  expect(isDefaultScoutModelEqual(defaultLead, null)).toBe(false);
  expect(isDefaultScoutModelEqual(defaultLead, defaultLead)).toBe(true);
});

const ref: SessionRef = { workspaceId: "ws", sessionId: "sess" };
const threadModel: SessionModelSelection = { provider: "openai", modelId: "gpt-5" };
const otherModel: SessionModelSelection = { provider: "openai", modelId: "gpt-4o" };
const withHistory = [userMessage("u1", "hello"), assistantMessage("a1", "hi"), toolRow()];

type DriverCall =
  | { readonly type: "model"; readonly selection: SessionModelSelection }
  | { readonly type: "mode"; readonly enabled: boolean };

function toggleHost(options: {
  transcript: readonly TranscriptMessage[];
  current?: SessionModelSelection;
  def: SessionModelSelection | undefined;
  loaded?: boolean;
}) {
  const key = "ws:sess";
  const transcriptCache = new Map<string, readonly TranscriptMessage[]>();
  const loadedTranscriptKeys = new Set<string>();
  const sessionConfigBySession = new Map<
    string,
    { provider?: string; modelId?: string; orchestratorMode?: boolean }
  >();
  const load = () => {
    transcriptCache.set(key, options.transcript);
    loadedTranscriptKeys.add(key);
    if (options.current) {
      sessionConfigBySession.set(key, { ...options.current });
    }
  };
  if (options.loaded !== false) {
    load();
  }
  const calls: DriverCall[] = [];
  let ensureCalls = 0;
  const host = {
    initialize: async () => {},
    conversationState: {
      transcriptCache,
      loadedTranscriptKeys,
      sessionConfigBySession,
      activeAssistantMessageBySession: new Map(),
      composerAttachmentsBySession: new Map(),
      composerDraftsBySession: new Map(),
      sessionCommandsBySession: new Map(),
      sessionErrorsBySession: new Map(),
    },
    defaultLeadModel: () => options.def,
    ensureSessionReady: async () => {
      ensureCalls += 1;
      load();
    },
    driver: {
      setSessionModel: async (_ref: SessionRef, selection: SessionModelSelection) => {
        calls.push({ type: "model", selection });
      },
      setSessionOrchestratorMode: async (_ref: SessionRef, enabled: boolean) => {
        calls.push({ type: "mode", enabled });
      },
    },
    withErrorHandling: async (fn: () => Promise<never>) => fn(),
    schedulePersistUiState: () => {},
    applyLocalSessionUpdate: () => {},
    emit: () => ({}) as never,
    publishSelectedTranscriptFor: () => {},
    sessionFromState: () => ({
      updatedAt: createdAt,
      title: "thread",
      status: "idle" as const,
    }),
  };
  const owner = createConversationOwner(host as never);
  const modelCalls = () => calls.flatMap((call) => (call.type === "model" ? [call.selection] : []));
  const currentModel = () => {
    const config = sessionConfigBySession.get(key);
    return config?.provider ? { provider: config.provider, modelId: config.modelId } : undefined;
  };
  return { owner, calls, modelCalls, currentModel, ensureCalls: () => ensureCalls };
}

test("lead toggle pure helpers", () => {
  expect(defaultLeadModelForLeadToggle({ defaultLeadModel: defaultLead })).toEqual(defaultLead);
  expect(
    defaultLeadModelForLeadToggle({ defaultLeadModel: defaultLead, current: threadModel }),
  ).toEqual(defaultLead);
  expect(
    defaultLeadModelForLeadToggle({ defaultLeadModel: defaultLead, current: defaultLead }),
  ).toBeUndefined();
  expect(
    defaultLeadModelForLeadToggle({ defaultLeadModel: undefined, current: threadModel }),
  ).toBeUndefined();

  const preLead = { previous: threadModel, applied: defaultLead };
  expect(preLeadModelForSoloToggle({ preLead, current: defaultLead })).toEqual(threadModel);
  expect(preLeadModelForSoloToggle({ preLead, current: otherModel })).toBeUndefined();
  expect(preLeadModelForSoloToggle({ preLead, current: undefined })).toBeUndefined();
  expect(preLeadModelForSoloToggle({ preLead: undefined, current: defaultLead })).toBeUndefined();
});

test("toggle-on-empty-thread switches", async () => {
  const { owner, calls } = toggleHost({ transcript: [], current: threadModel, def: defaultLead });
  await owner.setSessionOrchestratorMode(ref, true);
  expect(calls).toEqual([
    { type: "model", selection: defaultLead },
    { type: "mode", enabled: true },
  ]);
});

test("toggle-on-thread-with-history switches", async () => {
  const { owner, modelCalls, currentModel } = toggleHost({
    transcript: withHistory,
    current: threadModel,
    def: defaultLead,
  });
  await owner.setSessionOrchestratorMode(ref, true);
  expect(modelCalls()).toEqual([defaultLead]);
  expect(currentModel()).toEqual(defaultLead);
});

test("toggle-on with the transcript not loaded opens the session and switches", async () => {
  const host = toggleHost({
    transcript: withHistory,
    current: threadModel,
    def: defaultLead,
    loaded: false,
  });
  await host.owner.setSessionOrchestratorMode(ref, true);
  expect(host.ensureCalls()).toBe(1);
  expect(host.modelCalls()).toEqual([defaultLead]);
  // The pre-lead model was read from the opened session, so Solo restores it.
  await host.owner.setSessionOrchestratorMode(ref, false);
  expect(host.modelCalls()).toEqual([defaultLead, threadModel]);
});

test("toggle-off restores the pre-lead model, mode first", async () => {
  const { owner, calls, currentModel } = toggleHost({
    transcript: withHistory,
    current: threadModel,
    def: defaultLead,
  });
  await owner.setSessionOrchestratorMode(ref, true);
  await owner.setSessionOrchestratorMode(ref, false);
  expect(calls).toEqual([
    { type: "model", selection: defaultLead },
    { type: "mode", enabled: true },
    { type: "mode", enabled: false },
    { type: "model", selection: threadModel },
  ]);
  expect(currentModel()).toEqual(threadModel);

  // The record is spent: another Lead -> Solo round trip starts fresh.
  await owner.setSessionOrchestratorMode(ref, false);
  expect(calls.filter((call) => call.type === "model")).toHaveLength(2);
});

test("toggle-off leaves a user-picked model alone", async () => {
  const { owner, modelCalls, currentModel } = toggleHost({
    transcript: withHistory,
    current: threadModel,
    def: defaultLead,
  });
  await owner.setSessionOrchestratorMode(ref, true);
  await owner.setSessionModel(ref, otherModel.provider, otherModel.modelId);
  await owner.setSessionOrchestratorMode(ref, false);
  expect(modelCalls()).toEqual([defaultLead, otherModel]);
  expect(currentModel()).toEqual(otherModel);
});

test("toggle-off without a pre-lead record leaves the model alone", async () => {
  // A thread already in lead (for example after a restart) has no record.
  const { owner, modelCalls } = toggleHost({
    transcript: withHistory,
    current: defaultLead,
    def: defaultLead,
  });
  await owner.setSessionOrchestratorMode(ref, false);
  expect(modelCalls()).toEqual([]);
});

test("lead toggle leaves the model alone when no default is set or already on default", async () => {
  const cleared = toggleHost({ transcript: withHistory, current: threadModel, def: undefined });
  await cleared.owner.setSessionOrchestratorMode(ref, true);
  await cleared.owner.setSessionOrchestratorMode(ref, false);
  expect(cleared.modelCalls()).toEqual([]);
  expect(cleared.currentModel()).toEqual(threadModel);

  const already = toggleHost({ transcript: withHistory, current: defaultLead, def: defaultLead });
  await already.owner.setSessionOrchestratorMode(ref, true);
  await already.owner.setSessionOrchestratorMode(ref, false);
  expect(already.modelCalls()).toEqual([]);
});
