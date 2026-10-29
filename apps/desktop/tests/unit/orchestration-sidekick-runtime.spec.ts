import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type {
  CreateSessionOptions,
  SessionModelSelection,
  SessionRef,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { MuseCliDriver } from "@pi-gui/muse-cli-driver";
import { SessionDriverRouter } from "../../electron/application/session-driver-router";
import {
  SIDEKICK_RUNTIME_ENV_VAR,
  childRuntimeOf,
  decideChildRuntime,
  readMetaCredentialType,
  resolveSidekickRuntimeOverride,
} from "../../electron/orchestration/sidekick-runtime";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import {
  readPersistedUiState,
  writePersistedUiState,
} from "../../electron/persistence/app-store-persistence";
import {
  DEFAULT_SIDEKICK_THINKING_LEVEL,
  type OrchestrationChildRuntime,
  type OrchestrationChildThread,
  type TranscriptMessage,
} from "../../contracts/desktop-state";

const createdAt = "2026-10-29T00:00:00.000Z";
const prompt = "Explore the auth flow and report back.";
const spawnedSessionId = "spawned-child";
const metaSidekick: SessionModelSelection = {
  provider: "meta",
  modelId: "muse-spark-1.3-contributor",
};
const otherSidekick: SessionModelSelection = {
  provider: "other",
  modelId: "other-model",
};

test("runtime override parses pi, muse-cli and auto; junk means auto", () => {
  expect(resolveSidekickRuntimeOverride({ [SIDEKICK_RUNTIME_ENV_VAR]: "pi" })).toBe("pi");
  expect(resolveSidekickRuntimeOverride({ [SIDEKICK_RUNTIME_ENV_VAR]: "muse-cli" })).toBe(
    "muse-cli",
  );
  expect(resolveSidekickRuntimeOverride({ [SIDEKICK_RUNTIME_ENV_VAR]: "auto" })).toBe("auto");
  expect(resolveSidekickRuntimeOverride({ [SIDEKICK_RUNTIME_ENV_VAR]: "MUSE-CLI" })).toBe(
    "muse-cli",
  );
  expect(resolveSidekickRuntimeOverride({})).toBe("pi");
  expect(resolveSidekickRuntimeOverride({ [SIDEKICK_RUNTIME_ENV_VAR]: "sometimes" })).toBe("pi");
});

test("auto routes meta models on OAuth subscriptions to the Muse CLI", () => {
  const oauth = { model: metaSidekick, metaOAuth: true, museAvailable: true };
  expect(decideChildRuntime("auto", oauth)).toBe("muse-cli");
  expect(decideChildRuntime("auto", { ...oauth, model: otherSidekick })).toBe("pi");
  expect(decideChildRuntime("auto", { ...oauth, model: undefined })).toBe("pi");
  expect(decideChildRuntime("auto", { ...oauth, metaOAuth: false })).toBe("pi");
  expect(decideChildRuntime("auto", { ...oauth, museAvailable: false })).toBe("pi");
});

test("an explicit override beats the model and auth state", () => {
  const oauth = { model: metaSidekick, metaOAuth: true, museAvailable: true };
  const plain = { model: otherSidekick, metaOAuth: false, museAvailable: false };
  expect(decideChildRuntime("muse-cli", plain)).toBe("muse-cli");
  expect(decideChildRuntime("pi", oauth)).toBe("pi");
});

test("records without a runtime tag stay on pi", () => {
  expect(childRuntimeOf({})).toBe("pi");
  expect(childRuntimeOf({ runtime: "pi" })).toBe("pi");
  expect(childRuntimeOf({ runtime: "muse-cli" })).toBe("muse-cli");
});

test("meta credential type reads pi's auth file and nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-auth-"));
  expect(readMetaCredentialType(dir)).toBeUndefined();
  await writeFile(join(dir, "auth.json"), "not json");
  expect(readMetaCredentialType(dir)).toBeUndefined();
  await writeFile(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key" } }));
  expect(readMetaCredentialType(dir)).toBeUndefined();
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ meta: { type: "oauth", refresh: "secret", access: "secret" } }),
  );
  expect(readMetaCredentialType(dir)).toBe("oauth");
});

function makeRouter(host: {
  museKeys: Set<string>;
  piCalls: string[];
  museCalls: string[];
}): SessionDriverRouter {
  const pi = {
    openSession: async (ref: SessionRef) => {
      host.piCalls.push(`open:${ref.sessionId}`);
      return { ref } as never;
    },
    sendUserMessage: async () => {},
    subscribe: () => () => {},
    getSessionSchemaInfo: async () => ({
      fileSchemaVersion: 1,
      runtimeSchemaVersion: 99,
      writtenByNewerRuntime: false,
    }),
  };
  const muse = {
    openSession: async (ref: SessionRef) => {
      host.museCalls.push(`open:${ref.sessionId}`);
      return { ref } as never;
    },
    sendUserMessage: async () => {},
    subscribe: () => () => {},
  };
  return new SessionDriverRouter(
    pi as unknown as PiSdkDriver,
    muse as unknown as MuseCliDriver,
    (ref) => host.museKeys.has(`${ref.workspaceId}:${ref.sessionId}`),
    99,
  );
}

test("the router sends tagged sessions to the Muse driver and the rest to pi", async () => {
  const host = {
    museKeys: new Set(["ws:muse-child"]),
    piCalls: [] as string[],
    museCalls: [] as string[],
  };
  const router = makeRouter(host);
  const museRef = { workspaceId: "ws", sessionId: "muse-child" };
  const piRef = { workspaceId: "ws", sessionId: "lead" };

  await router.openSession(museRef);
  await router.openSession(piRef);
  expect(host.museCalls).toEqual(["open:muse-child"]);
  expect(host.piCalls).toEqual(["open:lead"]);

  const schema = await router.getSessionSchemaInfo(museRef);
  expect(schema.writtenByNewerRuntime).toBe(false);
  expect(schema.fileSchemaVersion).toBeUndefined();
});

test("noted sessions route to the Muse driver before their record exists", async () => {
  const host = { museKeys: new Set<string>(), piCalls: [] as string[], museCalls: [] as string[] };
  const router = makeRouter(host);
  const ref = { workspaceId: "ws", sessionId: "fresh-child" };
  router.noteMuseSession(ref);
  await router.openSession(ref);
  expect(host.museCalls).toEqual(["open:fresh-child"]);
  expect(host.piCalls).toEqual([]);
});

interface CreateChildSessionCall {
  workspace: WorkspaceRef;
  options: CreateSessionOptions | undefined;
  runtime: OrchestrationChildRuntime;
}

function makeOwnerHost(options: {
  sidekick: SessionModelSelection | undefined;
  childRuntime: OrchestrationChildRuntime;
}) {
  const createSessionCalls: { workspace: WorkspaceRef; options: CreateSessionOptions }[] = [];
  const createChildSessionCalls: CreateChildSessionCall[] = [];
  let children: readonly OrchestrationChildThread[] = [];
  const childTranscript: TranscriptMessage[] = [
    { kind: "message", role: "user", id: "u1", text: prompt, createdAt },
    { kind: "message", role: "assistant", id: "a1", text: "On it.", createdAt },
  ];
  const sessionSnapshot = {
    ref: { workspaceId: "ws", sessionId: spawnedSessionId },
    workspace: { workspaceId: "ws", path: "/tmp/ws" },
    title: prompt,
    preview: "On it.",
    status: "running",
    updatedAt: createdAt,
  };
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async (workspace: WorkspaceRef, sessionOptions: CreateSessionOptions) => {
        createSessionCalls.push({ workspace, options: sessionOptions });
        return sessionSnapshot;
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    driverForSession: () => host.driver,
    createChildSession: async (
      workspace: WorkspaceRef,
      sessionOptions: CreateSessionOptions | undefined,
      runtime: OrchestrationChildRuntime,
    ) => {
      createChildSessionCalls.push({ workspace, options: sessionOptions, runtime });
      return sessionSnapshot;
    },
    resolveChildRuntime: () => options.childRuntime,
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
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
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === "parent" || ref.sessionId === spawnedSessionId
        ? { status: "running", title: "thread", updatedAt: createdAt }
        : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => false,
    sidekickModelFor: () => options.sidekick,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultScoutThinkingLevel: () => undefined,
    defaultSidekickThinkingLevel: () => DEFAULT_SIDEKICK_THINKING_LEVEL,
    sessionModelFor: () => undefined,
    sessionThinkingLevelFor: () => undefined,
    sessionUsageFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    createChildWorktree: async () => {
      throw new Error("no worktree in this spec");
    },
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
  return { host, owner, children: () => children, createSessionCalls, createChildSessionCalls };
}

test("a meta sidekick child is created on its resolved runtime and tagged", async () => {
  const { owner, children, createSessionCalls, createChildSessionCalls } = makeOwnerHost({
    sidekick: metaSidekick,
    childRuntime: "muse-cli",
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-muse" },
  );

  expect(createSessionCalls).toHaveLength(0);
  expect(createChildSessionCalls).toHaveLength(1);
  expect(createChildSessionCalls[0]?.runtime).toBe("muse-cli");
  expect(createChildSessionCalls[0]?.options.initialModel).toEqual(metaSidekick);
  expect(children()).toHaveLength(1);
  expect(children()[0]?.runtime).toBe("muse-cli");
});

test("a non-meta sidekick child stays an untagged pi thread", async () => {
  const { owner, children, createSessionCalls, createChildSessionCalls } = makeOwnerHost({
    sidekick: otherSidekick,
    childRuntime: "pi",
  });

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-pi" },
  );

  expect(createChildSessionCalls).toHaveLength(1);
  expect(createChildSessionCalls[0]?.runtime).toBe("pi");
  expect(createSessionCalls).toHaveLength(0);
  expect(children()).toHaveLength(1);
  expect(children()[0]?.runtime).toBeUndefined();
});

function makeWorkspaceDefaultHost(workspaceDefaultModel: SessionModelSelection | undefined) {
  const createChildSessionCalls: CreateChildSessionCall[] = [];
  let children: readonly OrchestrationChildThread[] = [];
  let seenModel: SessionModelSelection | undefined;
  const childTranscript: TranscriptMessage[] = [
    { kind: "message", role: "user", id: "u1", text: prompt, createdAt },
    { kind: "message", role: "assistant", id: "a1", text: "On it.", createdAt },
  ];
  const sessionSnapshot = {
    ref: { workspaceId: "ws", sessionId: spawnedSessionId },
    workspace: { workspaceId: "ws", path: "/tmp/ws" },
    title: prompt,
    preview: "On it.",
    status: "running",
    updatedAt: createdAt,
  };
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => sessionSnapshot,
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    driverForSession: () => host.driver,
    createChildSession: async (
      workspace: WorkspaceRef,
      sessionOptions: CreateSessionOptions | undefined,
      runtime: OrchestrationChildRuntime,
    ) => {
      createChildSessionCalls.push({ workspace, options: sessionOptions, runtime });
      return sessionSnapshot;
    },
    resolveChildRuntime: (input: { model: SessionModelSelection | undefined }) => {
      seenModel = input.model;
      return decideChildRuntime("auto", {
        model: input.model,
        metaOAuth: true,
        museAvailable: true,
      });
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
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
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === "parent" || ref.sessionId === spawnedSessionId
        ? { status: "running", title: "thread", updatedAt: createdAt }
        : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => false,
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultScoutThinkingLevel: () => undefined,
    defaultSidekickThinkingLevel: () => DEFAULT_SIDEKICK_THINKING_LEVEL,
    sessionModelFor: () => undefined,
    sessionThinkingLevelFor: () => undefined,
    sessionUsageFor: () => undefined,
    buildCreateSessionOptions: async () =>
      workspaceDefaultModel ? { initialModel: workspaceDefaultModel } : undefined,
    effectiveChildModel: async (
      _workspaceId: string,
      explicit: SessionModelSelection | undefined,
    ) => explicit ?? workspaceDefaultModel,
    createChildWorktree: async () => {
      throw new Error("no worktree in this spec");
    },
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
  return {
    owner,
    children: () => children,
    createChildSessionCalls,
    seenModel: () => seenModel,
  };
}

function makeAppGlobalHost(globalDefaultModel: SessionModelSelection | undefined) {
  // App-global mode: buildCreateSessionOptions is undefined (per-repo only),
  // so the child runs on pi's live global default via effectiveChildModel.
  const createChildSessionCalls: CreateChildSessionCall[] = [];
  let children: readonly OrchestrationChildThread[] = [];
  let seenModel: SessionModelSelection | undefined;
  const childTranscript: TranscriptMessage[] = [
    { kind: "message", role: "user", id: "u1", text: prompt, createdAt },
    { kind: "message", role: "assistant", id: "a1", text: "On it.", createdAt },
  ];
  const sessionSnapshot = {
    ref: { workspaceId: "ws", sessionId: spawnedSessionId },
    workspace: { workspaceId: "ws", path: "/tmp/ws" },
    title: prompt,
    preview: "On it.",
    status: "running",
    updatedAt: createdAt,
  };
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => sessionSnapshot,
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    driverForSession: () => host.driver,
    createChildSession: async (
      workspace: WorkspaceRef,
      sessionOptions: CreateSessionOptions | undefined,
      runtime: OrchestrationChildRuntime,
    ) => {
      createChildSessionCalls.push({ workspace, options: sessionOptions, runtime });
      return sessionSnapshot;
    },
    resolveChildRuntime: (input: { model: SessionModelSelection | undefined }) => {
      seenModel = input.model;
      return decideChildRuntime("auto", {
        model: input.model,
        metaOAuth: true,
        museAvailable: true,
      });
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
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
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === "parent" || ref.sessionId === spawnedSessionId
        ? { status: "running", title: "thread", updatedAt: createdAt }
        : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => false,
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultScoutThinkingLevel: () => undefined,
    defaultSidekickThinkingLevel: () => DEFAULT_SIDEKICK_THINKING_LEVEL,
    sessionModelFor: () => undefined,
    sessionThinkingLevelFor: () => undefined,
    sessionUsageFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    effectiveChildModel: async (
      _workspaceId: string,
      explicit: SessionModelSelection | undefined,
    ) => explicit ?? globalDefaultModel,
    createChildWorktree: async () => {
      throw new Error("no worktree in this spec");
    },
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
  return {
    owner,
    children: () => children,
    createChildSessionCalls,
    seenModel: () => seenModel,
  };
}

test("a workspace-default meta model with no sidekick routes to muse-cli", async () => {
  const { owner, children, createChildSessionCalls, seenModel } =
    makeWorkspaceDefaultHost(metaSidekick);

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-workspace-meta-default" },
  );

  expect(seenModel()).toEqual(metaSidekick);
  expect(createChildSessionCalls).toHaveLength(1);
  expect(createChildSessionCalls[0]?.runtime).toBe("muse-cli");
  expect(createChildSessionCalls[0]?.options?.initialModel).toEqual(metaSidekick);
  expect(children()).toHaveLength(1);
  expect(children()[0]?.runtime).toBe("muse-cli");
});

test("a workspace-default non-meta model with no sidekick stays on pi", async () => {
  const { owner, children, createChildSessionCalls, seenModel } =
    makeWorkspaceDefaultHost(otherSidekick);

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-workspace-other-default" },
  );

  expect(seenModel()).toEqual(otherSidekick);
  expect(createChildSessionCalls).toHaveLength(1);
  expect(createChildSessionCalls[0]?.runtime).toBe("pi");
  expect(createChildSessionCalls[0]?.options?.initialModel).toEqual(otherSidekick);
  expect(children()).toHaveLength(1);
  expect(children()[0]?.runtime).toBeUndefined();
});

test("an app-global pi default meta model with no sidekick routes to muse-cli", async () => {
  const { owner, children, createChildSessionCalls, seenModel } =
    makeAppGlobalHost(metaSidekick);

  await owner.createChildThreadToolResult(
    { workspaceId: "ws", sessionId: "parent" },
    { prompt, toolCallId: "call-app-global-meta-default" },
  );

  expect(seenModel()).toEqual(metaSidekick);
  expect(createChildSessionCalls).toHaveLength(1);
  expect(createChildSessionCalls[0]?.runtime).toBe("muse-cli");
  expect(createChildSessionCalls[0]?.options?.initialModel).toEqual(metaSidekick);
  expect(children()).toHaveLength(1);
  expect(children()[0]?.runtime).toBe("muse-cli");
});

function childThread(overrides: Partial<OrchestrationChildThread> = {}): OrchestrationChildThread {
  return {
    id: "child-1",
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: "child",
    title: "Scout the repo",
    goal: "Find the thing",
    mode: "worker",
    depth: 1,
    status: "running",
    latestTranscript: "working",
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

test("a v21 child without a runtime loads as pi and rewrites as v22", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-runtime-v21-")), "ui-state.json");
  await writeFile(
    path,
    JSON.stringify({ version: 21, orchestrationChildren: [childThread({ mode: "worker" })] }),
  );
  const decoded = await readPersistedUiState(path);
  expect(decoded.version).toBe(21);
  expect(decoded.orchestrationChildren?.[0]?.runtime).toBeUndefined();
  expect(childRuntimeOf(decoded.orchestrationChildren?.[0] ?? {})).toBe("pi");

  await writePersistedUiState(path, { orchestrationChildren: decoded.orchestrationChildren });
  expect((await readPersistedUiState(path)).version).toBe(22);
  const copies = (await readdir(join(path, ".."))).filter((name) =>
    /^ui-state\.pre-workbench-v21\..+\.json$/.test(name),
  );
  expect(copies).toHaveLength(1);
});

test("a muse-cli runtime round-trips through ui-state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-runtime-v22-")), "ui-state.json");
  await writePersistedUiState(path, {
    orchestrationChildren: [childThread({ runtime: "muse-cli" })],
  });
  const decoded = await readPersistedUiState(path);
  expect(decoded.orchestrationChildren?.[0]?.runtime).toBe("muse-cli");
  const written = JSON.parse(await readFile(path, "utf8")) as {
    orchestrationChildren: { runtime?: string }[];
  };
  expect(written.orchestrationChildren[0]?.runtime).toBe("muse-cli");
});

test("a runtime tag in a pre-v22 file is rejected", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-runtime-bad-")), "ui-state.json");
  await writeFile(
    path,
    JSON.stringify({ version: 21, orchestrationChildren: [childThread({ runtime: "muse-cli" })] }),
  );
  await expect(readPersistedUiState(path)).rejects.toThrow();
});
