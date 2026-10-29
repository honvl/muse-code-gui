import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import type {
  OrchestrationChildThread,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import {
  activeProviderFailureNote,
  clearAllProviderFailures,
  clearProviderFailure,
  classifyProviderFailure,
  isFailFastFailureClass,
  providerFailureNote,
  providerFailureNotesSnapshot,
  recordProviderFailure,
  resolveProviderFailureMemoryMs,
} from "../../contracts/provider-failures";
import {
  childCompletionReportText,
  createOrchestrationOwner,
} from "../../electron/orchestration/app-store-orchestration";
import { createChildThreadAction } from "../../electron/orchestration/orchestration-runtime";
import { applyTimelineEvent } from "../../electron/conversation/app-store-timeline";
import { sidekickFailureWarning } from "../../src/features/conversation/model-selector";

const ATTENTATION_ERROR =
  'meta API error (403): {"code":"client_attestation_denied","message":"This API key is billed to a Muse Code subscription, and this request does not carry Muse Code\'s builtin tool declarations…"}';
const AUTH_ERROR = "Provider request failed with 401: invalid_api_key: expired key";
const RATE_LIMIT_ERROR = "Provider request failed with 429: rate_limit_exceeded, retry later";
const OVERLOADED_ERROR = "meta API error (503): service_overloaded, try again";
const QUOTA_ERROR = "Subscription allowance exhausted for this period";
const OTHER_ERROR = "Provider rejected bearer abc123";

test.beforeEach(() => {
  clearAllProviderFailures();
});

test("classifies provider errors from the runFailed error text", () => {
  expect(classifyProviderFailure(ATTENTATION_ERROR)).toBe("attestation-denied");
  expect(classifyProviderFailure(AUTH_ERROR)).toBe("auth");
  expect(classifyProviderFailure(RATE_LIMIT_ERROR)).toBe("rate-limited");
  expect(classifyProviderFailure(OVERLOADED_ERROR)).toBe("overloaded");
  expect(classifyProviderFailure(QUOTA_ERROR)).toBe("quota");
  expect(classifyProviderFailure(OTHER_ERROR)).toBe("other");
  expect(classifyProviderFailure(undefined)).toBe("other");
  expect(classifyProviderFailure("  ")).toBe("other");
});

test("classifies from the last assistant message errorMessage when joined", () => {
  expect(classifyProviderFailure(["boom", OVERLOADED_ERROR].join("\n"))).toBe("overloaded");
});

test("every actionable class has a short note; other has none", () => {
  for (const failureClass of [
    "attestation-denied",
    "auth",
    "rate-limited",
    "overloaded",
    "quota",
  ] as const) {
    const note = providerFailureNote(failureClass);
    expect(note, failureClass).toBeTruthy();
    expect(note!.length, failureClass).toBeLessThanOrEqual(300);
  }
  expect(providerFailureNote("other")).toBeUndefined();
});

test("attestation note names the remedy from the task", () => {
  expect(providerFailureNote("attestation-denied")).toContain("PI_APP_SIDEKICK_RUNTIME=auto");
});

test("transient notes say re-sending is safe", () => {
  expect(providerFailureNote("rate-limited")).toContain("send_message_to_thread");
  expect(providerFailureNote("overloaded")).toContain("send_message_to_thread");
});

test("only attestation and auth failures are fail-fast", () => {
  expect(isFailFastFailureClass("attestation-denied")).toBe(true);
  expect(isFailFastFailureClass("auth")).toBe(true);
  expect(isFailFastFailureClass("rate-limited")).toBe(false);
  expect(isFailFastFailureClass("overloaded")).toBe(false);
  expect(isFailFastFailureClass("quota")).toBe(false);
  expect(isFailFastFailureClass("other")).toBe(false);
});

test("fail-fast memory records per provider+model and expires", () => {
  const meta = { provider: "meta", modelId: "muse-spark" };
  const other = { provider: "openai", modelId: "gpt-4o" };
  recordProviderFailure(meta, "attestation-denied", 1_000);
  expect(activeProviderFailureNote(meta, { nowMs: 2_000 })?.length).toBeGreaterThan(0);
  expect(activeProviderFailureNote(other, { nowMs: 2_000 })).toBeUndefined();
  // Past the 10-minute default the model spawns again.
  expect(activeProviderFailureNote(meta, { nowMs: 1_000 + 10 * 60 * 1_000 + 1 })).toBeUndefined();
  // A custom window via env.
  recordProviderFailure(meta, "auth", 0);
  expect(
    activeProviderFailureNote(meta, { nowMs: 60_000, env: { PI_APP_PROVIDER_FAILURE_MEMORY_MS: "1000" } }),
  ).toBeUndefined();
  expect(resolveProviderFailureMemoryMs({ PI_APP_PROVIDER_FAILURE_MEMORY_MS: "junk" })).toBe(
    10 * 60 * 1_000,
  );
});

test("transient failures never enter fail-fast memory", () => {
  const meta = { provider: "meta", modelId: "muse-spark" };
  recordProviderFailure(meta, "overloaded");
  recordProviderFailure(meta, "rate-limited");
  recordProviderFailure(meta, "quota");
  recordProviderFailure(meta, "other");
  expect(activeProviderFailureNote(meta)).toBeUndefined();
  expect(providerFailureNotesSnapshot()).toEqual({});
});

test("a success on the model clears the memory", () => {
  const meta = { provider: "meta", modelId: "muse-spark" };
  recordProviderFailure(meta, "attestation-denied");
  clearProviderFailure(meta);
  expect(activeProviderFailureNote(meta)).toBeUndefined();
});

test("report text carries the actionable note for a failed child", () => {
  const child = {
    id: "child-thread-1",
    title: "Trace the plumbing",
    goal: "trace",
    status: "failed",
  } as OrchestrationChildThread;
  const report = childCompletionReportText(
    child,
    "failed",
    undefined,
    ATTENTATION_ERROR,
    1,
    true,
    undefined,
    providerFailureNote("attestation-denied"),
  );
  expect(report).toContain("note: ");
  expect(report).toContain("PI_APP_SIDEKICK_RUNTIME=auto");
  expect(report).toContain("error: ");
});

test("report text omits the note line without one", () => {
  const child = {
    id: "child-thread-1",
    title: "Trace the plumbing",
    goal: "trace",
    status: "failed",
  } as OrchestrationChildThread;
  expect(childCompletionReportText(child, "failed", undefined, OTHER_ERROR)).not.toContain("note: ");
});

test("the child thread failure row names the remedy", () => {
  const cache = new Map<string, readonly TranscriptMessage[]>();
  const ref: SessionRef = { workspaceId: "ws", sessionId: "child" };
  const event: Extract<SessionDriverEvent, { type: "runFailed" }> = {
    type: "runFailed",
    sessionRef: ref,
    timestamp: new Date().toISOString(),
    error: { message: ATTENTATION_ERROR, code: "403" },
  };
  applyTimelineEvent(cache, event, {
    runMetricsBySession: new Map(),
    runningSinceBySession: new Map(),
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    extensionToolLabels: new Map(),
  });
  const rows = cache.get("ws:child") ?? [];
  const failure = rows.find((row) => row.kind === "activity" && row.tone === "error");
  expect(failure?.kind === "activity" && failure.label).toContain("PI_APP_SIDEKICK_RUNTIME=auto");
});

test("an unclassified failure row keeps its plain label", () => {
  const cache = new Map<string, readonly TranscriptMessage[]>();
  const ref: SessionRef = { workspaceId: "ws", sessionId: "child" };
  const event: Extract<SessionDriverEvent, { type: "runFailed" }> = {
    type: "runFailed",
    sessionRef: ref,
    timestamp: new Date().toISOString(),
    error: { message: OTHER_ERROR },
  };
  applyTimelineEvent(cache, event, {
    runMetricsBySession: new Map(),
    runningSinceBySession: new Map(),
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    extensionToolLabels: new Map(),
  });
  const rows = cache.get("ws:child") ?? [];
  const failure = rows.find((row) => row.kind === "activity" && row.tone === "error");
  expect(failure?.kind === "activity" && failure.label).toBe(OTHER_ERROR);
});

const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
const childRef: SessionRef = { workspaceId: "ws", sessionId: "child" };
const createdAt = "2026-10-29T20:00:00.000Z";

function assistantMessage(id: string, text: string, errorMessage?: string): TranscriptMessage {
  return {
    kind: "message",
    role: "assistant",
    id,
    text,
    createdAt,
    ...(errorMessage ? { errorMessage } : {}),
  } as TranscriptMessage;
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
    status: "failed",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeHost(options: {
  readonly transcript: TranscriptMessage[];
  readonly error?: string;
  readonly terminal: "failed" | "idle";
}) {
  const sent: Array<{ text: string }> = [];
  const state = { child: childRecord() };
  const notes: Array<Readonly<Record<string, string>>> = [];
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async () => {
        throw new Error("must not spawn while the sidekick model is failed");
      },
      setChildIsolation: () => {},
      sendCustomMessage: async (_ref: SessionRef, input: { text: string }) => {
        sent.push({ text: input.text });
      },
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [],
      orchestrationChildren: [state.child],
    }),
    replaceOrchestrationChildren: () => {},
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    schedulePersistUiState: () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === childRef.sessionId
        ? { status: options.terminal, title: state.child.title, updatedAt: createdAt }
        : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: (ref: SessionRef) => ref.sessionId === parentRef.sessionId,
    sidekickModelFor: () => ({ provider: "meta", modelId: "muse-spark" }),
    defaultScoutModel: () => undefined,
    sessionModelFor: (ref: SessionRef) =>
      ref.sessionId === childRef.sessionId
        ? { provider: "meta", modelId: "muse-spark" }
        : undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) =>
      ref.sessionId === childRef.sessionId ? options.transcript : [],
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => options.error,
    setSessionError: () => {},
    setProviderFailureNotes: (next: Readonly<Record<string, string>>) => {
      notes.push(next);
    },
    submitComposerToSession: async () => ({}) as never,
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, sent, notes };
}

test("a failed attestation child reports the note and arms fail-fast", async () => {
  const { owner, sent, notes } = makeHost({
    transcript: [assistantMessage("m1", "partial", ATTENTATION_ERROR)],
    error: ATTENTATION_ERROR,
    terminal: "failed",
  });

  await owner.reportChildCompletion(childRef);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toContain("PI_APP_SIDEKICK_RUNTIME=auto");
  expect(activeProviderFailureNote({ provider: "meta", modelId: "muse-spark" })).toBeTruthy();
  expect(notes.at(-1)).toEqual({
    "meta:muse-spark": activeProviderFailureNote({ provider: "meta", modelId: "muse-spark" }),
  });
});

test("create_child_thread refuses fast while the sidekick model is failed", async () => {
  const { owner } = makeHost({ transcript: [], terminal: "idle" });
  recordProviderFailure({ provider: "meta", modelId: "muse-spark" }, "attestation-denied");

  for (const extra of [{}, { fresh: true }] as const) {
    const result = await owner.createChildThreadToolResult(parentRef, {
      prompt: "do the thing",
      toolCallId: `call-${extra.fresh === true ? "fresh" : "plain"}`,
      mode: "worker",
      ...extra,
    });
    const text = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    expect(text).toContain("PI_APP_SIDEKICK_RUNTIME=auto");
    expect(result.details).toMatchObject({ action: createChildThreadAction });
    expect("childThreadId" in (result.details ?? {})).toBe(false);
  }
});

test("a success on the model clears the memory so spawns resume", async () => {
  const { owner } = makeHost({ transcript: [assistantMessage("m1", "done")], terminal: "idle" });
  recordProviderFailure({ provider: "meta", modelId: "muse-spark" }, "attestation-denied");
  await owner.reportChildCompletion(childRef);
  expect(activeProviderFailureNote({ provider: "meta", modelId: "muse-spark" })).toBeUndefined();
});

test("sidekickFailureWarning resolves the effective sidekick model", () => {
  const notes = { "meta:muse-spark": "refused" };
  expect(
    sidekickFailureWarning({
      sidekickProvider: "meta",
      sidekickModelId: "muse-spark",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      failureNotes: notes,
    }),
  ).toBe("refused");
  // No explicit sidekick: the workspace default is what children run.
  expect(
    sidekickFailureWarning({
      sidekickProvider: undefined,
      sidekickModelId: undefined,
      defaultProvider: "meta",
      defaultModelId: "muse-spark",
      failureNotes: notes,
    }),
  ).toBe("refused");
  expect(
    sidekickFailureWarning({
      sidekickProvider: "openai",
      sidekickModelId: "gpt-4o",
      defaultProvider: "meta",
      defaultModelId: "muse-spark",
      failureNotes: notes,
    }),
  ).toBeUndefined();
  expect(
    sidekickFailureWarning({
      sidekickProvider: "meta",
      sidekickModelId: "muse-spark",
      defaultProvider: undefined,
      defaultModelId: undefined,
      failureNotes: undefined,
    }),
  ).toBeUndefined();
});
