import { expect, test } from "@playwright/test";
import type { SessionModelSelection, SessionRef } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";

const createdAt = "2026-10-29T00:00:00.000Z";
const promptText = "Read sidekick-runtime.ts and report the routing rules.";

const effectiveModel: SessionModelSelection = {
  provider: "meta",
  modelId: "muse-spark-1.3-contributor",
};

function makeMuseModelHost() {
  const createSessionCalls: Array<{
    options: { initialModel?: SessionModelSelection };
    runtime: string;
  }> = [];
  const childTranscript: TranscriptMessage[] = [
    { kind: "message", role: "user", id: "u1", text: "worker brief", createdAt },
    { kind: "message", role: "assistant", id: "a1", text: "On it.", createdAt },
  ];
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => {
        throw new Error("must use createChildSession for muse-cli children");
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    createChildSession: async (
      _workspace: unknown,
      options: { initialModel?: SessionModelSelection },
      runtime: string,
    ) => {
      createSessionCalls.push({ options, runtime });
      return {
        ref: { workspaceId: "ws", sessionId: "muse-child" },
        title: "Muse sidekick",
        preview: "worker brief",
        status: "idle",
        updatedAt: createdAt,
      };
    },
    resolveChildRuntime: () => "muse-cli" as const,
    effectiveChildModel: async () => effectiveModel,
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [],
      orchestrationChildren: [],
    }),
    replaceOrchestrationChildren: () => {},
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: () => ({ status: "running", title: "thread", updatedAt: createdAt }),
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => false,
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultScoutThinkingLevel: () => undefined,
    defaultSidekickThinkingLevel: () => "xhigh",
    sessionModelFor: () => undefined,
    sessionThinkingLevelFor: () => undefined,
    sessionUsageFor: () => undefined,
    buildCreateSessionOptions: async () => ({}),
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) => (ref.sessionId === "muse-child" ? childTranscript : []),
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => false,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async () => ({}) as never,
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, createSessionCalls };
}

test("muse-cli children pass the effective model as initialModel", async () => {
  // No explicit sidekick or scout model: routing already resolved the
  // effective (workspace/app-default) model, so the child must carry it as
  // initialModel — otherwise `muse exec` gets no --model and uses its own
  // default instead of the routed one.
  const { owner, createSessionCalls } = makeMuseModelHost();
  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt: promptText, toolCallId: "call-muse-model" },
  );
  expect(createSessionCalls).toHaveLength(1);
  expect(createSessionCalls[0]?.runtime).toBe("muse-cli");
  expect(createSessionCalls[0]?.options.initialModel).toEqual(effectiveModel);
});
