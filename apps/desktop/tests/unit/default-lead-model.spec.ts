import { expect, test } from "@playwright/test";
import type { SessionModelSelection, SessionRef } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/desktop-state";
import {
  defaultLeadModelForLeadToggle,
  hasThreadHistory,
  isDefaultLeadModelEqual,
  resolveInitialModelForLeadThread,
} from "../../electron/application/default-lead-model";
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

function activityRow(): TranscriptMessage {
  return {
    kind: "activity",
    id: "activity-1",
    createdAt,
    label: "Lead mode on",
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
  expect(
    defaultLeadModelForLeadToggle({
      enabled: true,
      defaultLeadModel: undefined,
      transcript: [],
    }),
  ).toBeUndefined();
  expect(isDefaultLeadModelEqual(undefined, null)).toBe(true);
  expect(isDefaultLeadModelEqual(defaultLead, null)).toBe(false);
  expect(isDefaultLeadModelEqual(defaultLead, defaultLead)).toBe(true);
});

function toggleHost(options: {
  transcript: readonly TranscriptMessage[];
  current?: SessionModelSelection;
  def: SessionModelSelection | undefined;
}) {
  const key = "ws:sess";
  const transcriptCache = new Map<string, readonly TranscriptMessage[]>([
    [key, options.transcript],
  ]);
  const loadedTranscriptKeys = new Set<string>([key]);
  const sessionConfigBySession = new Map<string, { provider?: string; modelId?: string }>();
  if (options.current) {
    sessionConfigBySession.set(key, {
      provider: options.current.provider,
      modelId: options.current.modelId,
    });
  }
  const setModelCalls: SessionModelSelection[] = [];
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
    driver: {
      setSessionModel: async (_ref: SessionRef, selection: SessionModelSelection) => {
        setModelCalls.push(selection);
      },
      setSessionOrchestratorMode: async () => {},
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
  return { owner, setModelCalls };
}

test("toggle-on-empty-thread switches", async () => {
  expect(
    defaultLeadModelForLeadToggle({
      enabled: true,
      defaultLeadModel: defaultLead,
      transcript: [],
    }),
  ).toEqual(defaultLead);
  expect(
    defaultLeadModelForLeadToggle({
      enabled: true,
      defaultLeadModel: defaultLead,
      transcript: [activityRow()],
    }),
  ).toEqual(defaultLead);
  expect(hasThreadHistory([])).toBe(false);
  expect(hasThreadHistory([activityRow()])).toBe(false);

  const { owner, setModelCalls } = toggleHost({ transcript: [], def: defaultLead });
  await owner.setSessionOrchestratorMode({ workspaceId: "ws", sessionId: "sess" }, true);
  expect(setModelCalls).toEqual([defaultLead]);
});

test("toggle-on-thread-with-history does not switch", async () => {
  const withUser = [userMessage("u1", "hello")];
  const withAssistant = [userMessage("u1", "hello"), assistantMessage("a1", "hi")];
  const withTool = [toolRow()];
  expect(hasThreadHistory(withUser)).toBe(true);
  expect(hasThreadHistory(withAssistant)).toBe(true);
  expect(hasThreadHistory(withTool)).toBe(true);
  for (const transcript of [withUser, withAssistant, withTool]) {
    expect(
      defaultLeadModelForLeadToggle({
        enabled: true,
        defaultLeadModel: defaultLead,
        transcript,
      }),
    ).toBeUndefined();
  }

  const { owner, setModelCalls } = toggleHost({ transcript: withAssistant, def: defaultLead });
  await owner.setSessionOrchestratorMode({ workspaceId: "ws", sessionId: "sess" }, true);
  expect(setModelCalls).toEqual([]);
});

test("lead toggle leaves the model alone when disabled, cleared, or already on default", async () => {
  expect(
    defaultLeadModelForLeadToggle({
      enabled: false,
      defaultLeadModel: defaultLead,
      transcript: [],
    }),
  ).toBeUndefined();
  expect(
    defaultLeadModelForLeadToggle({
      enabled: true,
      defaultLeadModel: defaultLead,
      transcript: [],
      currentProvider: defaultLead.provider,
      currentModelId: defaultLead.modelId,
    }),
  ).toBeUndefined();

  const disabled = toggleHost({ transcript: [], def: defaultLead });
  await disabled.owner.setSessionOrchestratorMode({ workspaceId: "ws", sessionId: "sess" }, false);
  expect(disabled.setModelCalls).toEqual([]);

  const cleared = toggleHost({ transcript: [], def: undefined });
  await cleared.owner.setSessionOrchestratorMode({ workspaceId: "ws", sessionId: "sess" }, true);
  expect(cleared.setModelCalls).toEqual([]);

  const already = toggleHost({ transcript: [], current: defaultLead, def: defaultLead });
  await already.owner.setSessionOrchestratorMode({ workspaceId: "ws", sessionId: "sess" }, true);
  expect(already.setModelCalls).toEqual([]);
});
