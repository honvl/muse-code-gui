import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { sessionKey } from "@pi-gui/session-driver";
import type {
  CreateSessionOptions,
  SessionConfig,
  SessionDriverEvent,
  SessionModelSelection,
  SessionRef,
  SessionSnapshot,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import { parseWriteScope, scopesOverlap } from "./writer-scope";
import type {
  DesktopAppState,
  OrchestrationEvidenceRecord,
  OrchestrationChildThread,
  OrchestrationChildThreadStatus,
  OrchestrationChildTranscriptMessage,
  SendChildThreadFollowUpInput,
  TimelineToolCall,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import { latestSessionActivityAt, previewFromTranscript } from "../application/app-store-utils";
import type { RefreshStateOptions } from "../application/refresh-state-options";
import {
  CHILD_REPORT_SUFFIX,
  ORCHESTRATION_MAX_CHILD_DEPTH,
  composeChildBrief,
  createChildThreadAction,
  createChildThreadModeFromToolOutput,
  createChildThreadPromptFromToolOutput,
  createChildThreadToolName,
  listThreadsAction,
  listThreadsRequestedFromToolOutput,
  listThreadsToolName,
  readThreadAction,
  readThreadIdFromToolOutput,
  readThreadToolName,
  sendMessageToThreadAction,
  sendMessageToThreadFromToolOutput,
  sendMessageToThreadToolName,
} from "./orchestration-runtime";
import type {
  CreateChildThreadToolDetails,
  ListThreadsToolDetails,
  OrchestrationChildMode,
  OrchestrationThreadListEntry,
  ReadThreadToolDetails,
  SendMessageToThreadToolDetails,
} from "./orchestration-runtime";

const CHILD_TITLE_LIMIT = 56;
const MAX_CHILD_TRANSCRIPT_MESSAGES = 40;
const READ_THREAD_GOAL_LIMIT = 400;
/** Latest kept messages returned by a default read_thread call. */
const READ_THREAD_DEFAULT_WINDOW = 8;
/** Latest kept messages returned by read_thread with full:true. */
const READ_THREAD_FULL_WINDOW = 32;
/** Per-message cap for read_thread output. */
const READ_THREAD_MESSAGE_LIMIT = 1500;
/** Total message-text budget for a default read_thread result. */
const READ_THREAD_DEFAULT_TOTAL_LIMIT = 8_000;
/** Total message-text budget for a read_thread result with full:true. */
const READ_THREAD_FULL_TOTAL_LIMIT = 24_000;
/** Other workspace threads shown by list_threads past the current thread and children. */
const LIST_THREADS_OTHER_LIMIT = 10;
/** Preview cap for list_threads entries. */
const LIST_THREADS_PREVIEW_LIMIT = 160;
const MAX_EVIDENCE_RECORDS_PER_CHILD = 80;
const CHILD_REPORT_CUSTOM_TYPE = "pi-gui.child-report";
const CHILD_REPORT_MESSAGE_LIMIT = 2_000;
/** Trailing marker on a host-truncated child report so the lead knows content is missing. */
const REPORT_TRUNCATED_NOTE = "…(report truncated; call read_thread for detail)";
/** Default cap on child records per parent session (unbounded-spawn protection). */
export const DEFAULT_DELEGATION_BUDGET = 12;
export const DELEGATION_BUDGET_ENV_VAR = "PI_APP_ORCHESTRATION_MAX_CHILDREN";

/**
 * Cap on child records per parent session. Overridable with
 * PI_APP_ORCHESTRATION_MAX_CHILDREN (positive integer; junk falls back to
 * the default). Read at call time so tests and restarts can reconfigure.
 */
export function resolveDelegationBudgetLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELEGATION_BUDGET_ENV_VAR]?.trim();
  if (raw !== undefined && raw !== "" && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return DEFAULT_DELEGATION_BUDGET;
}

export function delegationBudgetExceededMessage(limit: number): string {
  return (
    `Delegation budget exhausted (${limit} children on this thread). ` +
    `Summarize what you have and finish, or continue an existing child with send_message_to_thread.`
  );
}

export function countChildrenForParent(
  children: readonly OrchestrationChildThread[],
  parentWorkspaceId: string,
  parentSessionId: string,
): number {
  return children.filter(
    (child) =>
      child.parentWorkspaceId === parentWorkspaceId && child.parentSessionId === parentSessionId,
  ).length;
}

class DelegationBudgetError extends Error {}

/**
 * Handoff generation per child thread id: 1 on creation, +1 each time the
 * child is continued via send_message_to_thread, so a lead reading several
 * reports can tell runs apart. In-memory only; never persisted on the record.
 */
const childGenerationByThreadId = new Map<string, number>();

function generationForChildThread(childThreadId: string): number {
  return childGenerationByThreadId.get(childThreadId) ?? 1;
}
const CHILD_START_TIMEOUT_MS = 10_000;
const CHILD_RUNNING_FAILURE_GRACE_MS = 1_000;
const pendingCreateChildThreadToolCalls = new Set<string>();
const execFileAsync = promisify(execFile);

interface OrchestrationStateView {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly workspaces: DesktopAppState["workspaces"];
  readonly orchestrationChildren: readonly OrchestrationChildThread[];
}

type OrchestrationDriver = Pick<
  PiSdkDriver,
  "cancelCurrentRun" | "createSession" | "sendCustomMessage" | "setChildIsolation"
>;

interface OrchestrationOwnerHost {
  readonly driver: OrchestrationDriver;
  initialize(): Promise<void>;
  orchestrationState(): OrchestrationStateView;
  replaceOrchestrationChildren(children: readonly OrchestrationChildThread[]): void;
  refreshState(options?: RefreshStateOptions): Promise<DesktopAppState>;
  emit(): DesktopAppState;
  withError(error: unknown): Promise<DesktopAppState>;
  persistUiState(): Promise<void>;
  workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined;
  sessionFromState(
    sessionRef: SessionRef,
  ):
    | { archivedAt?: string; updatedAt: string; title: string; status: string; preview?: string }
    | undefined;
  ensureSessionReady(sessionRef: SessionRef): Promise<SessionSnapshot | undefined>;
  ensureSessionSubscription(sessionRef: SessionRef): Promise<void>;
  subscribeToSessionEvents(
    listener: (event: SessionDriverEvent, state: DesktopAppState) => void | Promise<void>,
  ): () => void;
  updateSessionConfig(sessionRef: SessionRef, config: SessionConfig | undefined): void;
  isOrchestratorSession(sessionRef: SessionRef): boolean;
  sidekickModelFor(sessionRef: SessionRef): SessionModelSelection | undefined;
  defaultScoutModel(): SessionModelSelection | undefined;
  sessionModelFor(sessionRef: SessionRef): SessionModelSelection | undefined;
  buildCreateSessionOptions(workspaceId: string): Promise<CreateSessionOptions | undefined>;
  getQueuedComposerMessages(
    sessionRef: SessionRef,
  ): readonly import("../../contracts/desktop-state").QueuedComposerMessage[];
  seedSession(snapshot: SessionSnapshot): void;
  transcriptFor(sessionRef: SessionRef): readonly TranscriptMessage[];
  transcriptForKey(key: string): readonly TranscriptMessage[];
  replaceTranscript(sessionRef: SessionRef, transcript: readonly TranscriptMessage[]): void;
  isTranscriptLoaded(sessionRef: SessionRef): boolean;
  getSessionError(sessionRef: SessionRef): string | undefined;
  setSessionError(sessionRef: SessionRef, message: string): void;
  submitComposerToSession(
    sessionRef: SessionRef,
    text: string,
    attachments: readonly import("../../contracts/desktop-state").ComposerAttachment[],
    options?: { readonly deliverAs?: "steer" | "followUp"; readonly allowCommands?: boolean },
  ): Promise<DesktopAppState>;
}

export interface OrchestrationOwner {
  reportChildCompletion(sessionRef: SessionRef): Promise<void>;
  cancelChildRunsForParent(parentRef: SessionRef): Promise<void>;
  sendChildThreadFollowUp(input: SendChildThreadFollowUpInput): Promise<DesktopAppState>;
  hydrateOrchestrationChildren(): Promise<void>;
  hydrateVisibleOrchestrationChildren(): Promise<void>;
  projectOrchestrationChildren(
    children?: readonly OrchestrationChildThread[],
  ): readonly OrchestrationChildThread[];
  projectOrchestrationChildrenForSession(
    sessionRef: SessionRef,
  ): readonly OrchestrationChildThread[];
  handleOrchestrationThreadToolResult(
    event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
  ): Promise<boolean>;
  hasOrchestrationChildSession(sessionRef: SessionRef): boolean;
  hasOrchestrationParentSession(sessionRef: SessionRef): boolean;
  createChildThreadToolResult(
    parentRef: SessionRef,
    input: {
      readonly prompt: string;
      readonly sourcePrompt?: string;
      readonly toolCallId: string;
      readonly mode?: OrchestrationChildMode;
      readonly scope?: string;
    },
  ): Promise<AgentToolResult<CreateChildThreadToolDetails>>;
  listThreadsToolResult(
    parentRef: SessionRef,
    options?: { readonly query?: string },
  ): AgentToolResult<ListThreadsToolDetails>;
  readThreadToolResult(
    parentRef: SessionRef,
    threadId: string,
    options?: {
      readonly waitSeconds?: number;
      readonly signal?: AbortSignal;
      readonly full?: boolean;
    },
  ): Promise<AgentToolResult<ReadThreadToolDetails>>;
  sendMessageToThreadToolResult(
    parentRef: SessionRef,
    input: { readonly threadId: string; readonly message: string; readonly interrupt?: boolean },
  ): Promise<AgentToolResult<SendMessageToThreadToolDetails>>;
}

export function createOrchestrationOwner(store: OrchestrationOwnerHost): OrchestrationOwner {
  // Delta-read cursors: how many child messages have already been returned to
  // each parent, keyed by `${parentSessionId}:${childSessionId}`. Private to
  // this owner so incremental reads never leak across parents.
  const readThreadCursors = new Map<string, number>();
  // Completed runs already reported to a parent, keyed by child thread id.
  // Cleared when the child starts running again so a follow-up run reports too.
  const reportedChildRuns = new Map<string, string>();
  return {
    reportChildCompletion: (sessionRef) =>
      reportChildCompletion(store, sessionRef, reportedChildRuns),
    cancelChildRunsForParent: (parentRef) => cancelChildRunsForParent(store, parentRef),
    sendChildThreadFollowUp: (input) => sendChildThreadFollowUp(store, input),
    hydrateOrchestrationChildren: () => hydrateOrchestrationChildren(store),
    hydrateVisibleOrchestrationChildren: () => hydrateVisibleOrchestrationChildren(store),
    projectOrchestrationChildren: (children) => projectOrchestrationChildren(store, children),
    projectOrchestrationChildrenForSession: (sessionRef) =>
      projectOrchestrationChildrenForSession(store, sessionRef),
    handleOrchestrationThreadToolResult: (event) =>
      handleOrchestrationThreadToolResult(store, event, readThreadCursors),
    hasOrchestrationChildSession: (sessionRef) =>
      hasOrchestrationChildSession(store.orchestrationState().orchestrationChildren, sessionRef),
    hasOrchestrationParentSession: (sessionRef) =>
      hasOrchestrationParentSession(store.orchestrationState().orchestrationChildren, sessionRef),
    createChildThreadToolResult: (parentRef, input) =>
      createChildThreadToolResult(store, parentRef, input),
    listThreadsToolResult: (parentRef, options) => listThreadsToolResult(store, parentRef, options),
    readThreadToolResult: (parentRef, threadId, options) =>
      readThreadToolResult(store, parentRef, threadId, options, readThreadCursors),
    sendMessageToThreadToolResult: (parentRef, input) =>
      sendMessageToThreadToolResult(store, parentRef, input),
  };
}

interface SpawnChildThreadInput {
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly sourcePrompt?: string;
  readonly mode?: OrchestrationChildMode;
  readonly scope?: string;
  readonly sourceToolCallId?: string;
}

class WriterScopeConflictError extends Error {}

function writerScopeConflictMessage(blockerTitle: string, scopeDisplay: string): string {
  return (
    `Another worker is writing "${scopeDisplay}" (child "${blockerTitle}"). ` +
    `Wait for it, narrow your scope so they do not overlap, or send it a follow-up instead of starting a second writer.`
  );
}

/** Statuses that hold the single-writer slot. Terminal children release it. */
function isActiveWriterStatus(status: OrchestrationChildThreadStatus): boolean {
  return status === "running" || status === "queued" || status === "waiting";
}

/**
 * Phase A seam for worktree isolation (phase B).
 *
 * Existing children carry no persisted scope (no contract change), so today
 * every known worker counts as the whole workspace (`[]` overlaps
 * everything). Phase B will return each blocker's real scope here — e.g.
 * from its worktree record or persisted brief — at which point disjoint
 * scopes stop conflicting and route to separate worktrees instead. The
 * `scopesOverlap` call below already honors that; only this function changes.
 */
function existingChildWriteScopes(_child: OrchestrationChildThread): readonly string[] {
  return [];
}

function findConflictingWorker(
  children: readonly OrchestrationChildThread[],
  parentWorkspaceId: string,
  parentSessionId: string,
  newScopes: readonly string[],
): OrchestrationChildThread | undefined {
  return children.find(
    (child) =>
      child.parentWorkspaceId === parentWorkspaceId &&
      child.parentSessionId === parentSessionId &&
      child.mode !== "scout" &&
      isActiveWriterStatus(child.status) &&
      scopesOverlap(newScopes, existingChildWriteScopes(child)),
  );
}

interface CreatedChildThreadResult {
  readonly child: OrchestrationChildThread;
  readonly deliveryStatus: NonNullable<CreateChildThreadToolDetails["deliveryStatus"]>;
}

async function createChildThreadRecord(
  store: OrchestrationOwnerHost,
  input: SpawnChildThreadInput,
): Promise<CreatedChildThreadResult> {
  await store.initialize();
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Child thread prompt cannot be empty.");
  }
  // Display text shown to the lead: the caller's raw prompt. Delivery and
  // transcript matching always use the composed brief (`prompt`).
  const displayPrompt = (input.sourcePrompt ?? prompt).trim() || prompt;

  const parent = store.sessionFromState({
    workspaceId: input.parentWorkspaceId,
    sessionId: input.parentSessionId,
  });
  if (!parent) {
    throw new Error("Select a parent thread before spawning a child.");
  }

  const workspace = store.workspaceRefFromState(input.parentWorkspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${input.parentWorkspaceId}`);
  }

  const parentChild = parentChildRecord(store, input.parentWorkspaceId, input.parentSessionId);
  const depth = (parentChild?.depth ?? 0) + 1;
  if (depth > ORCHESTRATION_MAX_CHILD_DEPTH) {
    throw new Error(
      `Child thread depth ${depth} exceeds the limit of ${ORCHESTRATION_MAX_CHILD_DEPTH}; summarize instead of delegating further.`,
    );
  }
  // Authority cannot widen down the chain: a scout parent may only spawn scouts.
  const mode: OrchestrationChildMode =
    parentChild?.mode === "scout" ? "scout" : (input.mode ?? "worker");

  const pendingKey = input.sourceToolCallId ? childToolCallKey(input) : undefined;
  if (pendingKey && pendingCreateChildThreadToolCalls.has(pendingKey)) {
    throw new Error("Child thread creation is already in progress.");
  }

  const existing = input.sourceToolCallId ? childForToolCall(store, input) : undefined;
  if (existing) {
    if (existing.status === "failed") {
      throw new Error(existing.latestTranscript || "Failed to start child thread.");
    }
    const childRef = childSessionRef(existing);
    store.driver.setChildIsolation(childRef, {
      mode: existing.mode ?? "worker",
      workspacePath: workspace.path,
      depth: existing.depth ?? 1,
    });
    await store.ensureSessionReady(childRef);
    return {
      child: existing,
      deliveryStatus: requireInitialPromptRun(store, childRef, prompt),
    };
  }

  // Single-writer rule (phase A): one active worker per overlapping scope.
  // Scouts never block and are never blocked; an idempotent retry above
  // bypasses this like the budget below. An unscoped worker is treated as the
  // WHOLE workspace, not as "no claim": two unscoped writers are exactly the
  // collision this rule exists to stop, so it must be the strictest case, not
  // the exempt one. Existing scopes are unknown (no contract field), so any
  // active worker of the same parent conflicts — see `existingChildWriteScopes`
  // for the phase B seam.
  const newScopes = parseWriteScope(input.scope);
  if (mode !== "scout") {
    const blocker = findConflictingWorker(
      store.orchestrationState().orchestrationChildren,
      input.parentWorkspaceId,
      input.parentSessionId,
      newScopes,
    );
    if (blocker) {
      throw new WriterScopeConflictError(
        writerScopeConflictMessage(blocker.title || blocker.id, newScopes[0] ?? "the workspace"),
      );
    }
  }

  // Unbounded-spawn protection: cap child records per parent regardless of
  // status. An idempotent retry above bypasses the cap; fresh spawns do not.
  const budgetLimit = resolveDelegationBudgetLimit();
  const delegatedCount = countChildrenForParent(
    store.orchestrationState().orchestrationChildren,
    input.parentWorkspaceId,
    input.parentSessionId,
  );
  if (delegatedCount >= budgetLimit) {
    throw new DelegationBudgetError(delegationBudgetExceededMessage(budgetLimit));
  }

  if (pendingKey) {
    pendingCreateChildThreadToolCalls.add(pendingKey);
  }
  try {
    // Model for a child, most specific first: the app-global scout model for a
    // read-only sweep, then the thread's sidekick, then (for a child spawning a
    // grandchild) the spawning session's own model, then the workspace default.
    // Workers never take the scout model: it exists so cheap read-only sweeps
    // stay cheap without downgrading edits.
    const parentRef: SessionRef = {
      workspaceId: input.parentWorkspaceId,
      sessionId: input.parentSessionId,
    };
    const sidekick =
      (mode === "scout" ? store.defaultScoutModel() : undefined) ??
      store.sidekickModelFor(parentRef) ??
      (parentChild ? store.sessionModelFor(parentRef) : undefined);
    const createOptions = await store.buildCreateSessionOptions(input.parentWorkspaceId);
    const session = await store.driver.createSession(workspace, {
      ...createOptions,
      ...(sidekick ? { initialModel: sidekick } : {}),
      title: titleFromPrompt(displayPrompt),
    });
    const childRef = session.ref;
    store.seedSession(session);
    await store.ensureSessionSubscription(childRef);

    const now = new Date().toISOString();
    const git = await workspaceGitRef(input.parentWorkspaceId, workspace.path);
    const status = toOrchestrationStatus(session.status, childRef, store);
    store.driver.setChildIsolation(childRef, { mode, workspacePath: workspace.path, depth });
    const child: OrchestrationChildThread = {
      id: randomUUID(),
      ...(input.sourceToolCallId ? { sourceToolCallId: input.sourceToolCallId } : {}),
      parentWorkspaceId: input.parentWorkspaceId,
      parentSessionId: input.parentSessionId,
      childWorkspaceId: childRef.workspaceId,
      childSessionId: childRef.sessionId,
      title: session.title || titleFromPrompt(displayPrompt),
      goal: displayPrompt,
      mode,
      depth,
      status,
      latestTranscript: session.preview || displayPrompt,
      transcript: [],
      evidence: [
        {
          id: evidenceId("created", input.sourceToolCallId ?? childRef.sessionId),
          childThreadId: "",
          kind: "orchestrator_acceptance",
          source: "orchestrator-accepted",
          status: "accepted",
          title: "Child thread created",
          detail: displayPrompt,
          parentSessionId: input.parentSessionId,
          childSessionId: childRef.sessionId,
          ...(git ? { git } : {}),
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: session.updatedAt || now,
    };
    const childWithEvidence = {
      ...child,
      evidence: child.evidence.map((record) => ({ ...record, childThreadId: child.id })),
    };
    childGenerationByThreadId.set(child.id, 1);

    store.replaceOrchestrationChildren(
      projectOrchestrationChildren(store, [
        childWithEvidence,
        ...store.orchestrationState().orchestrationChildren,
      ]),
    );
    await store.refreshState({
      selectedWorkspaceId: input.parentWorkspaceId,
      selectedSessionId: input.parentSessionId,
      clearLastError: true,
      activeView: "threads",
      emitState: false,
      persistState: false,
      publishSelectedTranscript: false,
    });

    let deliveryStatus: CreatedChildThreadResult["deliveryStatus"];
    try {
      deliveryStatus = await launchInitialChildPrompt(store, childRef, prompt);
    } catch (error) {
      markInitialPromptDeliveryFailed(store, child.id, error);
      await store.persistUiState();
      throw error;
    }

    return {
      child:
        store.orchestrationState().orchestrationChildren.find((entry) => entry.id === child.id) ??
        childWithEvidence,
      deliveryStatus,
    };
  } finally {
    if (pendingKey) {
      pendingCreateChildThreadToolCalls.delete(pendingKey);
    }
  }
}

async function handleCreateChildThreadToolResult(
  store: OrchestrationOwnerHost,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): Promise<boolean> {
  if (!event.success) {
    return false;
  }

  const tool = toolCallForFinishedEvent(store, event);
  if (!tool || tool.toolName !== createChildThreadToolName) {
    return false;
  }

  const finalOutput = finalThreadToolProjectionFromOutput(event.output);
  if (finalOutput) {
    updateThreadToolOutput(store, event, finalOutput);
    return true;
  }

  const prompt = createChildThreadPromptFromToolOutput(event.output);
  if (!prompt) {
    return false;
  }
  const mode = createChildThreadModeFromToolOutput(event.output);

  // Tool outputs now carry the caller's raw prompt in details.prompt, while
  // the child was launched with the composed brief. Delivery matching is
  // transcript-anchored (see initialPromptDeliveryStatus), so pass the raw
  // text through as the display prompt and re-ensure the report suffix for
  // the edge case where no child record exists yet and we must (re)deliver.
  // Legacy outputs already end with the suffix and pass through unchanged.
  const deliveryPrompt = prompt.endsWith(CHILD_REPORT_SUFFIX)
    ? prompt
    : composeChildBrief({ prompt });

  let deliveryStatus: CreatedChildThreadResult["deliveryStatus"];
  try {
    const result = await createChildThreadRecord(store, {
      parentWorkspaceId: event.sessionRef.workspaceId,
      parentSessionId: event.sessionRef.sessionId,
      prompt: deliveryPrompt,
      sourcePrompt: prompt,
      ...(mode ? { mode } : {}),
      sourceToolCallId: event.callId,
    });
    deliveryStatus = result.deliveryStatus;
  } catch (error) {
    const message = errorMessage(error);
    await store.withError(error);
    updateThreadToolOutput(
      store,
      event,
      projectionFromToolResult(createChildThreadErrorResult(prompt, message)),
    );
    return true;
  }

  const child = childForToolCall(store, {
    parentWorkspaceId: event.sessionRef.workspaceId,
    parentSessionId: event.sessionRef.sessionId,
    sourceToolCallId: event.callId,
  });
  if (!child) {
    return false;
  }

  updateCreateChildThreadToolOutput(store, event, prompt, child, deliveryStatus, mode);
  return true;
}

async function handleOrchestrationThreadToolResult(
  store: OrchestrationOwnerHost,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
  cursors: Map<string, number>,
): Promise<boolean> {
  if (!event.success) {
    return false;
  }

  const tool = toolCallForFinishedEvent(store, event);
  if (!tool) {
    return false;
  }

  if (tool.toolName === createChildThreadToolName) {
    return handleCreateChildThreadToolResult(store, event);
  }

  if (tool.toolName === listThreadsToolName && listThreadsRequestedFromToolOutput(event.output)) {
    updateListThreadsToolOutput(store, event);
    refreshParentOrchestrationEvidence(store, event.sessionRef);
    return true;
  }

  if (tool.toolName === readThreadToolName) {
    await updateReadThreadToolOutput(store, event, cursors);
    refreshParentOrchestrationEvidence(store, event.sessionRef);
    return true;
  }

  if (tool.toolName === sendMessageToThreadToolName) {
    await updateSendMessageToThreadToolOutput(store, event);
    refreshParentOrchestrationEvidence(store, event.sessionRef);
    return true;
  }

  return false;
}

async function sendChildThreadFollowUp(
  store: OrchestrationOwnerHost,
  input: SendChildThreadFollowUpInput,
): Promise<DesktopAppState> {
  await store.initialize();
  const text = input.text.trim();
  if (!text) {
    return store.withError("Child thread follow-up cannot be empty.");
  }

  const child = store
    .orchestrationState()
    .orchestrationChildren.find((entry) => entry.id === input.childThreadId);
  if (!child) {
    return store.withError("Unknown child thread.");
  }
  if (!child.childSessionId) {
    return store.withError("Legacy child thread records are read-only.");
  }

  const childRef = childSessionRef(child);
  if (!store.sessionFromState(childRef)) {
    return store.withError("Child thread session is no longer available.");
  }

  await store.submitComposerToSession(childRef, text, [], {
    deliverAs: "followUp",
    allowCommands: false,
  });
  await store.persistUiState();
  return store.emit();
}

async function cancelChildRun(
  store: OrchestrationOwnerHost,
  child: OrchestrationChildThread,
): Promise<void> {
  if (!child.childSessionId) {
    return;
  }
  await store.driver.cancelCurrentRun(childSessionRef(child)).catch(() => undefined);
}

/**
 * Cancel the active runs of every child owned by a parent session. Call this
 * when the parent's own run is cancelled so children don't keep running
 * unsupervised. Best-effort per child.
 */
async function cancelChildRunsForParent(
  store: OrchestrationOwnerHost,
  parentRef: SessionRef,
): Promise<void> {
  const children = store
    .orchestrationState()
    .orchestrationChildren.filter(
      (child) =>
        child.parentWorkspaceId === parentRef.workspaceId &&
        child.parentSessionId === parentRef.sessionId,
    );
  await Promise.all(children.map((child) => cancelChildRun(store, child)));
}

async function createChildThreadToolResult(
  store: OrchestrationOwnerHost,
  parentRef: SessionRef,
  input: {
    readonly prompt: string;
    readonly sourcePrompt?: string;
    readonly toolCallId: string;
    readonly mode?: OrchestrationChildMode;
    readonly scope?: string;
  },
): Promise<AgentToolResult<CreateChildThreadToolDetails>> {
  const displayPrompt = (input.sourcePrompt ?? input.prompt).trim();
  let child: OrchestrationChildThread;
  let deliveryStatus: CreatedChildThreadResult["deliveryStatus"];
  try {
    ({ child, deliveryStatus } = await createChildThreadRecord(store, {
      parentWorkspaceId: parentRef.workspaceId,
      parentSessionId: parentRef.sessionId,
      prompt: input.prompt,
      ...(input.sourcePrompt ? { sourcePrompt: input.sourcePrompt } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      sourceToolCallId: input.toolCallId,
    }));
  } catch (error) {
    // A refused delegation is a normal result, not a throw: the lead needs
    // the actionable text, not a failed tool call.
    if (error instanceof DelegationBudgetError) {
      const refused = createChildThreadErrorResult(displayPrompt, errorMessage(error));
      return {
        ...refused,
        details: { ...refused.details, delegationsRemaining: 0 },
      };
    }
    if (error instanceof WriterScopeConflictError) {
      return createChildThreadErrorResult(displayPrompt, errorMessage(error));
    }
    throw error;
  }
  const budgetLimit = resolveDelegationBudgetLimit();
  const details: CreateChildThreadToolDetails = {
    action: createChildThreadAction,
    prompt: displayPrompt,
    ...(child.mode ? { mode: child.mode } : {}),
    ...(typeof child.depth === "number" ? { depth: child.depth } : {}),
    childThreadId: child.id,
    childWorkspaceId: child.childWorkspaceId,
    childSessionId: child.childSessionId,
    title: child.title,
    deliveryStatus,
    delegationsRemaining: Math.max(
      0,
      budgetLimit -
        countChildrenForParent(
          store.orchestrationState().orchestrationChildren,
          parentRef.workspaceId,
          parentRef.sessionId,
        ),
    ),
    generation: generationForChildThread(child.id),
  };

  return {
    content: [
      {
        type: "text",
        text: formatCreateChildThreadResult(details, store.isOrchestratorSession(parentRef)),
      },
    ],
    details,
  };
}

function updateListThreadsToolOutput(
  store: OrchestrationOwnerHost,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): void {
  updateThreadToolOutput(
    store,
    event,
    finalThreadToolProjectionFromOutput(event.output) ??
      projectionFromToolResult(listThreadsToolResult(store, event.sessionRef)),
  );
}

async function updateReadThreadToolOutput(
  store: OrchestrationOwnerHost,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
  cursors: Map<string, number>,
): Promise<void> {
  const finalOutput = finalThreadToolProjectionFromOutput(event.output);
  if (finalOutput) {
    updateThreadToolOutput(store, event, finalOutput);
    return;
  }

  const threadId = readThreadIdFromToolOutput(event.output);
  if (!threadId) {
    updateThreadToolOutput(
      store,
      event,
      projectionFromToolResult(readThreadErrorResult("", "read_thread requires a thread_id.")),
    );
    return;
  }

  // Refresh path for legacy/non-final rows: re-read the full window without
  // consuming the delta cursor (the live tool result already advanced it).
  updateThreadToolOutput(
    store,
    event,
    projectionFromToolResult(
      await readThreadToolResult(store, event.sessionRef, threadId, { full: true }, cursors),
    ),
  );
}

async function updateSendMessageToThreadToolOutput(
  store: OrchestrationOwnerHost,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): Promise<void> {
  const finalOutput = finalThreadToolProjectionFromOutput(event.output);
  if (finalOutput) {
    updateThreadToolOutput(store, event, finalOutput);
    return;
  }

  const request = sendMessageToThreadFromToolOutput(event.output);
  if (!request) {
    updateThreadToolOutput(
      store,
      event,
      projectionFromToolResult(
        sendMessageToThreadErrorResult(
          "",
          "",
          "send_message_to_thread requires thread_id and message.",
        ),
      ),
    );
    return;
  }

  updateThreadToolOutput(
    store,
    event,
    projectionFromToolResult(await sendMessageToThreadToolResult(store, event.sessionRef, request)),
  );
}

function listThreadsToolResult(
  store: OrchestrationOwnerHost,
  parentRef: SessionRef,
  options: { readonly query?: string } = {},
): AgentToolResult<ListThreadsToolDetails> {
  store.replaceOrchestrationChildren(projectOrchestrationChildren(store));
  const query = options.query?.trim() || undefined;
  const { threads, omitted } = shownListThreads(listThreadsForContext(store, parentRef), query);
  return {
    content: [{ type: "text", text: formatThreadList(threads, omitted) }],
    details: {
      action: listThreadsAction,
      threads: [...threads],
      ...(omitted > 0 ? { omitted } : {}),
      ...(query ? { query } : {}),
    },
  };
}

/**
 * Wait for a child session to leave the running state, watching live driver
 * events. Always unsubscribes; resolves on completion, failure, close, an
 * idle status update, the timeout, or abort — whichever comes first.
 */
export async function waitForChildSettled(options: {
  readonly subscribe: OrchestrationOwnerHost["subscribeToSessionEvents"];
  readonly isRunning: () => boolean;
  readonly sessionRef: SessionRef;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<"settled" | "timeout" | "aborted"> {
  if (options.signal?.aborted) return "aborted";
  if (!options.isRunning()) return "settled";
  if (!(options.timeoutMs > 0)) return "timeout";
  const key = sessionKey(options.sessionRef);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: "settled" | "timeout" | "aborted") => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      resolve(outcome);
    };
    const onAbort = () => finish("aborted");
    const unsubscribe = options.subscribe((event) => {
      if (sessionKey(event.sessionRef) !== key) return;
      if (
        event.type === "runCompleted" ||
        event.type === "runFailed" ||
        event.type === "sessionClosed"
      ) {
        finish("settled");
      } else if (event.type === "sessionUpdated" && event.snapshot.status !== "running") {
        finish("settled");
      }
    });
    // The child may have settled between the caller's check and this subscribe.
    if (!options.isRunning() || options.signal?.aborted) {
      finish(options.signal?.aborted ? "aborted" : "settled");
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish("timeout"), options.timeoutMs);
  });
}

async function readThreadToolResult(
  store: OrchestrationOwnerHost,
  parentRef: SessionRef,
  threadId: string,
  options: {
    readonly waitSeconds?: number;
    readonly signal?: AbortSignal;
    readonly full?: boolean;
  } = {},
  cursors: Map<string, number>,
): Promise<AgentToolResult<ReadThreadToolDetails>> {
  const target = resolveThreadTarget(store, parentRef, threadId);
  if (!target) {
    return readThreadErrorResult(threadId, `Unknown thread: ${threadId}`);
  }

  await store.ensureSessionReady(target.sessionRef);
  // Read status fresh on every check: the child record captured in `target`
  // goes stale across the async ready above, and a stale "running" would miss
  // an already-fired runCompleted and block for the full timeout.
  const liveChildStatus = () => resolveThreadTarget(store, parentRef, threadId)?.child?.status;
  const isRunning = () => {
    if (store.sessionFromState(target.sessionRef)?.status === "running") return true;
    const status = liveChildStatus();
    return status === "queued" || status === "running" || status === "waiting";
  };

  let waitedSeconds = 0;
  let timedOut = false;
  const waitSeconds = options.waitSeconds ?? 0;
  if (waitSeconds > 0 && isRunning()) {
    const startedAt = Date.now();
    const outcome = await waitForChildSettled({
      subscribe: (listener) => store.subscribeToSessionEvents(listener),
      isRunning,
      sessionRef: target.sessionRef,
      timeoutMs: waitSeconds * 1000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (outcome === "aborted") {
      return readThreadErrorResult(threadId, `read_thread wait aborted for ${threadId}.`);
    }
    waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
    timedOut = outcome === "timeout";
  }

  // Re-resolve after a wait so the transcript and status reflect the settle.
  const fresh = resolveThreadTarget(store, parentRef, threadId) ?? target;
  const transcript = store.transcriptFor(fresh.sessionRef);
  const session = store.sessionFromState(fresh.sessionRef);
  // Bound the window before converting: a cheap kind-only pass counts the
  // kept rows and locates the tail slice, so only that slice is converted.
  // full:true raises the window but keeps a hard total cap.
  const full = options.full === true;
  const window = full ? READ_THREAD_FULL_WINDOW : READ_THREAD_DEFAULT_WINDOW;
  const totalBudget = full ? READ_THREAD_FULL_TOTAL_LIMIT : READ_THREAD_DEFAULT_TOTAL_LIMIT;
  const totalMessages = countKeptReadThreadMessages(transcript);
  const cursorKey = `${parentRef.sessionId}:${fresh.sessionRef.sessionId}`;
  const seen = full ? 0 : Math.min(cursors.get(cursorKey) ?? 0, totalMessages);
  if (!full) {
    cursors.set(cursorKey, totalMessages);
  }
  // The returned tail is the newest window past the delta cursor.
  const firstIndex = Math.max(seen, totalMessages - window);
  const rawStart = rawIndexOfKeptReadThreadMessage(transcript, firstIndex, totalMessages);
  let messages = toReadThreadMessages(transcript.slice(rawStart));
  const title = session?.title ?? fresh.child?.title ?? fresh.sessionRef.sessionId;
  const status = fresh.child?.status ?? session?.status ?? "unknown";
  const stillRunning = status === "running" || status === "queued" || status === "waiting";
  // A timeout that missed its settle event must not report "still running"
  // once the fresh state shows idle.
  if (timedOut && !stillRunning) {
    timedOut = false;
  }
  // Lead parents are woken by the child's report; only non-lead parents need
  // the wait_seconds hint because they receive no report (see reportChildCompletion).
  const isLead = store.isOrchestratorSession(parentRef);
  const notice = timedOut
    ? isLead
      ? `Still running after a ${waitSeconds}s wait (timed out). This child reports back automatically when its run ends; act on the report.`
      : `Still running after a ${waitSeconds}s wait. Call read_thread again with wait_seconds (up to 120) to keep waiting — do not poll rapidly.`
    : stillRunning
      ? isLead
        ? "The thread is still running. It reports back automatically when its run ends; act on the report."
        : "The thread is still running. Call read_thread again with wait_seconds (up to 120) to wait for completion instead of polling."
      : waitedSeconds > 0
        ? `Waited ${waitedSeconds}s for completion.`
        : undefined;
  const rawGoal = fresh.child?.goal;
  const goal =
    rawGoal === undefined ? undefined : truncateReadThreadText(rawGoal, READ_THREAD_GOAL_LIMIT);
  let truncated = rawGoal !== undefined && goal !== rawGoal;
  messages = messages.map((message) => {
    if (message.text.length <= READ_THREAD_MESSAGE_LIMIT) {
      return message;
    }
    truncated = true;
    return {
      ...message,
      text: `${message.text.slice(0, READ_THREAD_MESSAGE_LIMIT - 1)}…`,
    };
  });
  const budgeted = enforceReadThreadTotalBudget(messages, totalBudget);
  if (budgeted.trimmed) {
    truncated = true;
  }
  messages = budgeted.messages;
  const details: ReadThreadToolDetails = {
    action: readThreadAction,
    threadId,
    workspaceId: fresh.sessionRef.workspaceId,
    sessionId: fresh.sessionRef.sessionId,
    title,
    status,
    ...(fresh.child
      ? {
          childThreadId: fresh.child.id,
          goal,
        }
      : {}),
    messages,
    truncated,
    totalMessages,
    omittedEarlier: totalMessages - messages.length,
    ...(waitedSeconds > 0 ? { waitedSeconds } : {}),
    ...(timedOut ? { timedOut: true } : {}),
  };

  return {
    content: [
      {
        type: "text",
        text: formatThreadReadResult({ ...details, title, status, messages, notice }),
      },
    ],
    details,
  };
}

async function sendMessageToThreadToolResult(
  store: OrchestrationOwnerHost,
  parentRef: SessionRef,
  input: { readonly threadId: string; readonly message: string; readonly interrupt?: boolean },
): Promise<AgentToolResult<SendMessageToThreadToolDetails>> {
  const target = resolveThreadTarget(store, parentRef, input.threadId);
  if (!target) {
    return sendMessageToThreadErrorResult(
      input.threadId,
      input.message,
      `Unknown thread: ${input.threadId}`,
    );
  }

  // A running target steered without interrupt keeps its turn (deliverAs
  // "steer"); interrupt:true cancels first so the message starts a NEW
  // turn. An idle target submits normally either way. A rejected cancel never
  // loses the message: it still delivers, reported as not interrupted.
  const running = store.sessionFromState(target.sessionRef)?.status === "running";
  let interrupted = false;
  let deliverAs: "steer" | "followUp" = "followUp";
  if (running && input.interrupt === true) {
    try {
      await store.driver.cancelCurrentRun(target.sessionRef);
      interrupted = true;
    } catch {
      interrupted = false;
    }
    // The cancel races the submit below: without a settle wait the message
    // can queue into the dying run instead of starting a new turn. Wait for
    // the target to leave the running state (bounded), then submit
    // regardless so the message is never lost.
    await waitForChildSettled({
      subscribe: (listener) => store.subscribeToSessionEvents(listener),
      isRunning: () => store.sessionFromState(target.sessionRef)?.status === "running",
      sessionRef: target.sessionRef,
      timeoutMs: 5000,
    });
  } else if (running) {
    deliverAs = "steer";
  }

  await store.submitComposerToSession(target.sessionRef, input.message, [], {
    deliverAs,
    allowCommands: false,
  });
  if (target.child) {
    await store.persistUiState();
  }

  // Every continuation starts a new run of the same thread: bump its
  // generation so reports from different runs stay distinguishable.
  let generation: number | undefined;
  if (target.child) {
    generation = generationForChildThread(target.child.id) + 1;
    childGenerationByThreadId.set(target.child.id, generation);
  }

  const queuedMessages = store.getQueuedComposerMessages(target.sessionRef);
  const status = queuedMessages.length > 0 ? "queued" : "sent";
  const details: SendMessageToThreadToolDetails = {
    action: sendMessageToThreadAction,
    threadId: input.threadId,
    workspaceId: target.sessionRef.workspaceId,
    sessionId: target.sessionRef.sessionId,
    status,
    queuedMessageCount: queuedMessages.length,
    ...(interrupted ? { interrupted: true as const } : {}),
    ...(generation !== undefined ? { generation } : {}),
    message: input.message,
  };

  return {
    content: [{ type: "text", text: formatSendMessageToThreadResult(details) }],
    details,
  };
}

function projectOrchestrationChildren(
  store: OrchestrationOwnerHost,
  children: readonly OrchestrationChildThread[] = store.orchestrationState().orchestrationChildren,
): readonly OrchestrationChildThread[] {
  const parentEvidenceByChild = parentEvidenceIndex(store, children);
  return children.map((child) =>
    projectOrchestrationChild(store, child, parentEvidenceByChild.get(child.id) ?? []),
  );
}

function projectOrchestrationChildrenForSession(
  store: OrchestrationOwnerHost,
  sessionRef: SessionRef,
): readonly OrchestrationChildThread[] {
  const children = store.orchestrationState().orchestrationChildren;
  const parentEvidenceByChild = parentEvidenceIndex(store, children);
  return children.map((child) =>
    child.childWorkspaceId === sessionRef.workspaceId &&
    child.childSessionId === sessionRef.sessionId
      ? projectOrchestrationChild(store, child, parentEvidenceByChild.get(child.id) ?? [])
      : child,
  );
}

let backgroundChildHydrationInFlight = false;
const HYDRATE_REMAINING_CONCURRENCY = 4;

async function hydrateOrchestrationChildren(store: OrchestrationOwnerHost): Promise<void> {
  await hydrateVisibleOrchestrationChildren(store);
  // Heal background children: without their transcripts every idle-but-finished
  // child projects to `queued` and reads as running after a restart. Load the
  // rest in the background and re-project once settled so the sidebar counts
  // and the persisted file converge on the true terminal statuses.
  if (!backgroundChildHydrationInFlight) {
    backgroundChildHydrationInFlight = true;
    void hydrateRemainingOrchestrationChildren(store)
      .catch((error) => {
        console.warn("[orchestration] background child hydration failed", error);
      })
      .finally(() => {
        backgroundChildHydrationInFlight = false;
      });
  }
}

async function hydrateRemainingOrchestrationChildren(
  store: OrchestrationOwnerHost,
): Promise<void> {
  const state = store.orchestrationState();
  const visibleKeys = new Set(
    state.orchestrationChildren
      .filter(
        (child) =>
          child.parentWorkspaceId === state.selectedWorkspaceId &&
          child.parentSessionId === state.selectedSessionId,
      )
      .map((child) => sessionKey(childSessionRef(child))),
  );
  const seen = new Set<string>();
  const pending: SessionRef[] = [];
  for (const child of state.orchestrationChildren) {
    if (!child.childSessionId) {
      continue;
    }
    const childRef = childSessionRef(child);
    const key = sessionKey(childRef);
    if (visibleKeys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    // Skip children whose workspace cannot be resolved (hydration has
    // nothing to open them with) and already-loaded children: unresolvable
    // ones keep their stored status, loaded ones already project correctly.
    // A session missing from the catalog is not a skip — hydration is what
    // opens it, and the transcript it loads heals the stored status.
    if (
      !store.workspaceRefFromState(child.childWorkspaceId) ||
      store.isTranscriptLoaded(childRef)
    ) {
      continue;
    }
    pending.push(childRef);
  }
  if (pending.length === 0) {
    return;
  }
  // Bounded concurrency: each hydration opens a session and reads its
  // transcript, so avoid an I/O storm when dozens of children piled up.
  for (let index = 0; index < pending.length; index += HYDRATE_REMAINING_CONCURRENCY) {
    const batch = pending.slice(index, index + HYDRATE_REMAINING_CONCURRENCY);
    await Promise.all(
      batch.map((childRef) =>
        store.ensureSessionReady(childRef).catch((error) => {
          store.setSessionError(childRef, errorMessage(error));
        }),
      ),
    );
  }
  store.replaceOrchestrationChildren(projectOrchestrationChildren(store));
  store.emit();
  await store.persistUiState();
}

function parentChildRecord(
  store: OrchestrationOwnerHost,
  parentWorkspaceId: string,
  parentSessionId: string,
): OrchestrationChildThread | undefined {
  return store
    .orchestrationState()
    .orchestrationChildren.find(
      (child) =>
        child.childWorkspaceId === parentWorkspaceId && child.childSessionId === parentSessionId,
    );
}

function registerChildIsolation(
  store: OrchestrationOwnerHost,
  child: OrchestrationChildThread,
): void {
  if (!child.childSessionId) return;
  const workspace =
    store.workspaceRefFromState(child.childWorkspaceId) ??
    store.workspaceRefFromState(child.parentWorkspaceId);
  if (!workspace) return;
  try {
    store.driver.setChildIsolation(childSessionRef(child), {
      mode: child.mode ?? "worker",
      workspacePath: workspace.path,
      depth: child.depth ?? 1,
    });
  } catch {
    // Isolation registration is best-effort: a missing driver method on older
    // hosts must not break hydration or creation.
  }
}

async function hydrateVisibleOrchestrationChildren(store: OrchestrationOwnerHost): Promise<void> {
  const state = store.orchestrationState();
  for (const child of state.orchestrationChildren) {
    registerChildIsolation(store, child);
  }
  const visibleChildren = state.orchestrationChildren.filter(
    (child) =>
      child.parentWorkspaceId === state.selectedWorkspaceId &&
      child.parentSessionId === state.selectedSessionId,
  );
  const seen = new Set<string>();
  const hydrationTasks: Promise<unknown>[] = [];
  for (const child of visibleChildren) {
    if (!child.childSessionId) {
      continue;
    }
    const childRef = childSessionRef(child);
    const key = sessionKey(childRef);
    if (seen.has(key) || !store.sessionFromState(childRef) || store.isTranscriptLoaded(childRef)) {
      continue;
    }
    seen.add(key);
    hydrationTasks.push(
      store.ensureSessionReady(childRef).catch((error) => {
        store.setSessionError(childRef, errorMessage(error));
      }),
    );
  }
  await Promise.all(hydrationTasks);
}

function hasOrchestrationChildSession(
  children: readonly OrchestrationChildThread[],
  sessionRef: SessionRef,
): boolean {
  return children.some(
    (child) =>
      Boolean(child.childSessionId) &&
      child.childWorkspaceId === sessionRef.workspaceId &&
      child.childSessionId === sessionRef.sessionId,
  );
}

function hasOrchestrationParentSession(
  children: readonly OrchestrationChildThread[],
  sessionRef: SessionRef,
): boolean {
  return children.some(
    (child) =>
      child.parentWorkspaceId === sessionRef.workspaceId &&
      child.parentSessionId === sessionRef.sessionId,
  );
}

/**
 * Wake a child's orchestrator with the child's result. The report is a
 * host-authored custom message (never a fake user bubble): an idle orchestrator
 * starts a review turn from it, a busy one gets it as a follow-up. Only
 * orchestrator-mode parents receive unsolicited reports; a normal thread already
 * owns its children through the tool results it is waiting on.
 *
 * De-duplicated per finished run, so repeated session updates cannot wake the
 * parent twice; a follow-up that re-runs the child reports again.
 */
async function reportChildCompletion(
  store: OrchestrationOwnerHost,
  sessionRef: SessionRef,
  reportedRuns: Map<string, string>,
): Promise<void> {
  const child = store
    .orchestrationState()
    .orchestrationChildren.find(
      (entry) =>
        entry.childWorkspaceId === sessionRef.workspaceId &&
        entry.childSessionId === sessionRef.sessionId,
    );
  if (!child) {
    return;
  }

  const session = store.sessionFromState(sessionRef);
  const status = toOrchestrationStatus(session?.status ?? "idle", sessionRef, store);
  if (!isTerminalChildStatus(status) || !hasStartedRun(store, sessionRef)) {
    reportedRuns.delete(child.id);
    return;
  }

  // The supervision timer used to flip the parent's `create_child_thread`
  // tool row to its completed/failed text. Keep that visible outcome on the
  // event-driven path now that the timer is gone.
  finalizeChildThreadToolRow(store, { ...child, status });

  const parentRef: SessionRef = {
    workspaceId: child.parentWorkspaceId,
    sessionId: child.parentSessionId,
  };
  if (!store.isOrchestratorSession(parentRef)) {
    return;
  }

  const error = store.getSessionError(sessionRef);
  const finalMessage = lastAssistantMessage(store.transcriptFor(sessionRef));
  // The preview is the same final text when the transcript cache has not caught
  // up yet (the child ran in the background).
  const finalText = finalMessage?.text ?? session?.preview;
  const signature = [status, finalMessage?.id ?? "", finalText?.length ?? 0, error ?? ""].join(
    "\0",
  );
  if (reportedRuns.get(child.id) === signature) {
    return;
  }
  reportedRuns.set(child.id, signature);

  try {
    await store.driver.sendCustomMessage(
      parentRef,
      {
        customType: CHILD_REPORT_CUSTOM_TYPE,
        text: childCompletionReportText(
          child,
          status,
          finalText,
          error,
          generationForChildThread(child.id),
          store.isOrchestratorSession(parentRef),
        ),
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } catch (cause) {
    // Leave the run unreported so the next session event can retry it.
    reportedRuns.delete(child.id);
    console.warn(`[orchestration] could not report child ${child.id} to its parent:`, cause);
  }
}

/** Report text injected into the orchestrator when a child run ends. Pure; unit-tested. */
export function childCompletionReportText(
  child: Pick<OrchestrationChildThread, "id" | "title" | "goal" | "status">,
  status: OrchestrationChildThreadStatus,
  finalText: string | undefined,
  error?: string,
  generation?: number,
  isLeadParent = false,
): string {
  const trimmed = finalText?.trim();
  // The child's output is the expensive half of delegation: cap what the
  // host injects at CHILD_REPORT_MESSAGE_LIMIT and say so explicitly, so
  // the lead knows content is missing instead of assuming completeness.
  const body = trimmed
    ? trimmed.length > CHILD_REPORT_MESSAGE_LIMIT
      ? `${trimmed.slice(0, CHILD_REPORT_MESSAGE_LIMIT)}${REPORT_TRUNCATED_NOTE}`
      : trimmed
    : status === "failed"
      ? "No final answer: the child run failed."
      : `Child finished without a final report. Nothing was summarized, so this work is unverified: call read_thread("${child.id}") to inspect what it actually did before trusting this task.`;
  // The lead wrote the goal itself, so repeating it back wastes lead tokens.
  // Keep the title and thread_id so the lead can route follow-ups.
  return [
    `Child thread "${child.title}" ${status === "failed" ? "failed" : "finished"}.`,
    `thread_id: ${child.id}${generation !== undefined ? ` (run ${generation})` : ""}`,
    `status: ${status}`,
    ...(isLeadParent
      ? []
      : [`goal: ${truncateReadThreadText(child.goal, READ_THREAD_GOAL_LIMIT)}`]),
    ...(error ? [`error: ${truncateReadThreadText(error, READ_THREAD_GOAL_LIMIT)}`] : []),
    "",
    body,
    "",
    `Continue the lead plan. Call read_thread("${child.id}") only if you need detail this report omits.`,
  ].join("\n");
}

function lastAssistantMessage(
  transcript: readonly TranscriptMessage[],
): Extract<TranscriptMessage, { kind: "message" }> | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === "message" && item.role === "assistant" && item.text.trim()) {
      return item;
    }
  }
  return undefined;
}

/**
 * Evidence sources worth keeping across a restart. Everything else is
 * re-derived from the parent and child transcripts when the record loads
 * (`projectOrchestrationChild`), so persisting it wrote ~1.9MB of data that
 * nothing ever read — 46 child records and 2068 evidence rows — and it grew with
 * every child ever spawned. The creation record is the exception: it carries the
 * git context captured at spawn time, which no transcript can reproduce.
 */
const PERSISTED_EVIDENCE_SOURCES: ReadonlySet<OrchestrationEvidenceRecord["source"]> = new Set([
  "orchestrator-accepted",
]);

/** Keeps the saved child list bounded; older terminal records age out first. */
const MAX_PERSISTED_CHILDREN = 40;

function capPersistedChildren(
  children: readonly OrchestrationChildThread[],
): readonly OrchestrationChildThread[] {
  if (children.length <= MAX_PERSISTED_CHILDREN) {
    return children;
  }
  // Unfinished work always survives: dropping a running child would lose its
  // record while its session keeps going. Then newest first.
  const active = children.filter((child) => !isTerminalChildStatus(child.status));
  const settled = children
    .filter((child) => isTerminalChildStatus(child.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return [...active, ...settled].slice(0, MAX_PERSISTED_CHILDREN);
}

export function toPersistedOrchestrationChildren(
  children: readonly OrchestrationChildThread[],
): readonly OrchestrationChildThread[] | undefined {
  if (children.length === 0) {
    return undefined;
  }
  return capPersistedChildren(children).map((child) => ({
    ...child,
    // A child with a session re-derives both from its transcript on load
    // (`projectOrchestrationChild`); persisting them stored the goal text twice
    // per child — the largest remaining chunk of this file after evidence.
    latestTranscript: child.childSessionId ? "" : child.latestTranscript,
    transcript: child.childSessionId ? [] : child.transcript,
    evidence: child.evidence
      .filter((record) => PERSISTED_EVIDENCE_SOURCES.has(record.source))
      .map((record) => ({ ...record, childThreadId: child.id })),
  }));
}

function childSessionRef(child: OrchestrationChildThread): SessionRef {
  return {
    workspaceId: child.childWorkspaceId,
    sessionId: child.childSessionId,
  };
}

async function launchInitialChildPrompt(
  store: OrchestrationOwnerHost,
  childRef: SessionRef,
  prompt: string,
): Promise<CreatedChildThreadResult["deliveryStatus"]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let runningTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Child thread did not acknowledge its initial prompt within ${CHILD_START_TIMEOUT_MS}ms.`,
        ),
      );
    }, CHILD_START_TIMEOUT_MS);
    const unsubscribe = store.subscribeToSessionEvents((event) => {
      if (sessionKey(event.sessionRef) !== sessionKey(childRef)) {
        return;
      }
      if (event.type === "runFailed") {
        finish(new Error(`Failed to start child thread: ${event.error.message}`));
        return;
      }
      if (event.type === "sessionClosed" && event.reason === "failed") {
        finish(new Error("Failed to start child thread: the child session closed."));
        return;
      }
      acknowledgeCurrentState();
    });

    function cleanup(): void {
      clearTimeout(timeout);
      if (runningTimer) {
        clearTimeout(runningTimer);
      }
      unsubscribe();
    }

    function finish(result: CreatedChildThreadResult["deliveryStatus"] | Error): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    }

    function acknowledgeCurrentState(): void {
      try {
        const status = initialPromptDeliveryStatus(store, childRef, prompt);
        if (status === "responded") {
          finish(status);
        } else if (status === "running" && !runningTimer) {
          // The driver publishes `running` immediately before session.prompt().
          // Race submission completion and failure events against a bounded grace
          // so deterministic auth/config failures win without awaiting the turn.
          runningTimer = setTimeout(() => finish("running"), CHILD_RUNNING_FAILURE_GRACE_MS);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    }

    const submission = store.submitComposerToSession(childRef, prompt, [], {
      deliverAs: "followUp",
      allowCommands: false,
    });
    void submission.then(
      () => {
        if (settled) {
          return;
        }
        acknowledgeCurrentState();
        if (!settled && !runningTimer) {
          finish(
            new Error(
              "Child thread prompt submission completed without starting a run or producing a response.",
            ),
          );
        }
      },
      (error) => finish(error instanceof Error ? error : new Error(errorMessage(error))),
    );
  });
}

function requireInitialPromptRun(
  store: OrchestrationOwnerHost,
  childRef: SessionRef,
  prompt: string,
): CreatedChildThreadResult["deliveryStatus"] {
  const status = initialPromptDeliveryStatus(store, childRef, prompt);
  if (status) {
    return status;
  }
  throw new Error(
    "Child thread has no evidence that its initial prompt started a run or produced a response.",
  );
}

function initialPromptDeliveryStatus(
  store: OrchestrationOwnerHost,
  childRef: SessionRef,
  prompt: string,
): CreatedChildThreadResult["deliveryStatus"] | undefined {
  const key = sessionKey(childRef);
  const sessionError = store.getSessionError(childRef);
  if (sessionError) {
    throw new Error(`Failed to start child thread: ${sessionError}`);
  }

  const session = store.sessionFromState(childRef);
  if (session?.status === "failed") {
    throw new Error(
      `Failed to start child thread: ${session.preview || "the child session failed."}`,
    );
  }

  const transcript = store.transcriptFor(childRef);
  let promptIndex = transcript.findIndex(
    (item) => item.kind === "message" && item.role === "user" && item.text === prompt,
  );
  if (promptIndex < 0) {
    // Tool outputs carry the caller's raw prompt while the child received the
    // composed brief (raw prompt plus Scope blocks and the report suffix), so
    // anchor on the first delivered user message instead: the initial prompt.
    promptIndex = transcript.findIndex((item) => item.kind === "message" && item.role === "user");
  }
  if (promptIndex < 0) {
    return undefined;
  }
  if (transcript.slice(promptIndex + 1).some(isWorkerResponse)) {
    return "responded";
  }
  return session?.status === "running" ? "running" : undefined;
}

function isWorkerResponse(item: TranscriptMessage): boolean {
  return item.kind === "tool" || (item.kind === "message" && item.role === "assistant");
}

function markInitialPromptDeliveryFailed(
  store: OrchestrationOwnerHost,
  childThreadId: string,
  error: unknown,
): void {
  const now = new Date().toISOString();
  const message = errorMessage(error);
  store.replaceOrchestrationChildren(
    store.orchestrationState().orchestrationChildren.map((child) =>
      child.id === childThreadId
        ? {
            ...child,
            status: "failed",
            latestTranscript: message,
            evidence: mergeEvidenceRecords(child.evidence, [
              {
                id: evidenceId("delivery-failed", child.sourceToolCallId ?? child.childSessionId),
                childThreadId: child.id,
                kind: "blocker",
                source: "blocker",
                status: "failed",
                title: "Initial prompt delivery failed",
                detail: message,
                parentSessionId: child.parentSessionId,
                childSessionId: child.childSessionId,
                createdAt: now,
              },
            ]),
            updatedAt: now,
          }
        : child,
    ),
  );
}

function projectOrchestrationChild(
  store: OrchestrationOwnerHost,
  child: OrchestrationChildThread,
  parentEvidence: readonly OrchestrationEvidenceRecord[],
): OrchestrationChildThread {
  if (!child.childSessionId) {
    return child;
  }
  const childRef = childSessionRef(child);
  const key = sessionKey(childRef);
  const session = store.sessionFromState(childRef);
  const transcriptLoaded = store.isTranscriptLoaded(childRef);
  const rawTranscript = recentTranscriptItems(store.transcriptFor(childRef));
  const transcript = toChildTranscript(rawTranscript, MAX_CHILD_TRANSCRIPT_MESSAGES);
  const latestTranscript = session?.preview || previewFromTranscript(rawTranscript) || child.goal;
  const updatedAt = latestSessionActivityAt(session?.updatedAt ?? child.updatedAt, rawTranscript);
  // An unloaded transcript reads as empty, which is indistinguishable from
  // "never started" — deriving a status from it flips every finished
  // background child to `queued` (counted as running) after a restart.
  // Only derive when the transcript is actually cached; otherwise preserve
  // the stored status and let definitive live signals override it. The
  // background hydration pass loads the rest shortly after startup. A loaded
  // transcript is sufficient evidence on its own: even without a session
  // snapshot, hasStartedRun can tell a finished child from a never-started one.
  const status =
    transcriptLoaded
      ? toOrchestrationStatus(session?.status ?? "idle", childRef, store)
      : (liveChildStatus(session?.status, childRef, store) ?? child.status);

  return {
    ...child,
    title: session?.title || child.title,
    status,
    latestTranscript,
    transcript,
    evidence: mergeEvidenceRecords(child.evidence, [
      ...evidenceFromChildTranscript(child, rawTranscript),
      ...parentEvidence,
      ...blockerEvidenceFromChildStatus(child, status, updatedAt),
    ]),
    updatedAt,
  };
}

function isTerminalChildStatus(status: OrchestrationChildThreadStatus): boolean {
  return status === "complete" || status === "failed";
}

/** Parent tool-row text once a child run ends. Pure; unit-tested. */
export function childThreadFinalDetail(
  child: Pick<OrchestrationChildThread, "title" | "status">,
): string {
  return child.status === "failed"
    ? `Child thread "${child.title}" failed.`
    : `Child thread "${child.title}" completed.`;
}

/**
 * Rewrite the parent's `create_child_thread` tool row when the child run
 * ends, so the parent transcript shows live status Claude-style. Only
 * rewrites rows still showing the creation text (idempotent) and only when
 * the parent transcript is loaded, never synthesizing one.
 */
function finalizeChildThreadToolRow(
  store: OrchestrationOwnerHost,
  child: OrchestrationChildThread,
): boolean {
  if (!child.sourceToolCallId) return false;
  if (!isTerminalChildStatus(child.status)) return false;
  const parentRef: SessionRef = {
    workspaceId: child.parentWorkspaceId,
    sessionId: child.parentSessionId,
  };
  if (!store.isTranscriptLoaded(parentRef)) return false;
  const transcript = store.transcriptFor(parentRef);
  const entry = transcript.find(
    (item): item is TimelineToolCall =>
      isTimelineToolCall(item) && item.callId === child.sourceToolCallId,
  );
  if (!entry || !(entry.detail ?? "").startsWith("Created child thread:")) return false;
  const detail = childThreadFinalDetail(child);
  updateThreadToolOutput(
    store,
    {
      type: "toolFinished",
      sessionRef: parentRef,
      timestamp: new Date().toISOString(),
      callId: child.sourceToolCallId,
      success: true,
    },
    {
      detail,
      text: detail,
      details: existingToolOutputDetails(entry.output),
    },
  );
  return true;
}

function existingToolOutputDetails(output: unknown): Readonly<Record<string, unknown>> {
  if (typeof output === "object" && output !== null && "details" in output) {
    const details = (output as { readonly details?: unknown }).details;
    if (typeof details === "object" && details !== null) {
      return details as Readonly<Record<string, unknown>>;
    }
  }
  return {};
}

function updateCreateChildThreadToolOutput(
  store: OrchestrationOwnerHost,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
  prompt: string,
  child: OrchestrationChildThread,
  deliveryStatus: CreatedChildThreadResult["deliveryStatus"],
  mode?: OrchestrationChildMode,
): void {
  const resolvedMode = child.mode ?? mode;
  updateThreadToolOutput(store, event, {
    detail: `Created child thread: ${child.title}`,
    text: `Created child thread: ${child.title}`,
    details: {
      action: createChildThreadAction,
      prompt,
      ...(resolvedMode ? { mode: resolvedMode } : {}),
      ...(typeof child.depth === "number" ? { depth: child.depth } : {}),
      childThreadId: child.id,
      childWorkspaceId: child.childWorkspaceId,
      childSessionId: child.childSessionId,
      title: child.title,
      deliveryStatus,
      delegationsRemaining: Math.max(
        0,
        resolveDelegationBudgetLimit() -
          countChildrenForParent(
            store.orchestrationState().orchestrationChildren,
            event.sessionRef.workspaceId,
            event.sessionRef.sessionId,
          ),
      ),
      generation: generationForChildThread(child.id),
    },
  });
}

function updateThreadToolOutput(
  store: OrchestrationOwnerHost,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
  output: {
    readonly detail: string;
    readonly text: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly status?: TimelineToolCall["status"];
  },
): void {
  const key = sessionKey(event.sessionRef);
  const transcript = [...store.transcriptFor(event.sessionRef)];
  const index = transcript.findIndex(
    (item) => item.kind === "tool" && item.callId === event.callId,
  );
  const item = transcript[index];
  if (!item || !isTimelineToolCall(item)) {
    return;
  }
  transcript[index] = {
    ...item,
    status: output.status ?? item.status,
    detail: output.detail,
    output: {
      content: [
        {
          type: "text",
          text: output.text,
        },
      ],
      details: output.details,
    },
  };
  store.replaceTranscript(event.sessionRef, transcript);
}

function refreshParentOrchestrationEvidence(
  store: OrchestrationOwnerHost,
  parentRef: SessionRef,
): void {
  if (
    !store
      .orchestrationState()
      .orchestrationChildren.some(
        (child) =>
          child.parentWorkspaceId === parentRef.workspaceId &&
          child.parentSessionId === parentRef.sessionId,
      )
  ) {
    return;
  }
  store.replaceOrchestrationChildren(projectOrchestrationChildren(store));
}

function toolCallForFinishedEvent(
  store: OrchestrationOwnerHost,
  event: Extract<SessionDriverEvent, { type: "toolFinished" }>,
): TimelineToolCall | undefined {
  const transcript = store.transcriptFor(event.sessionRef);
  return transcript?.find(
    (item): item is TimelineToolCall => isTimelineToolCall(item) && item.callId === event.callId,
  );
}

type ThreadListEntry = OrchestrationThreadListEntry;

interface ResolvedThreadTarget {
  readonly sessionRef: SessionRef;
  readonly child?: OrchestrationChildThread;
}

function createChildThreadErrorResult(
  prompt: string,
  error: string,
): AgentToolResult<CreateChildThreadToolDetails> {
  return {
    content: [{ type: "text", text: error }],
    details: {
      action: createChildThreadAction,
      prompt,
      error,
    },
  };
}

function readThreadErrorResult(
  threadId: string,
  error: string,
): AgentToolResult<ReadThreadToolDetails> {
  return {
    content: [{ type: "text", text: error }],
    details: {
      action: readThreadAction,
      threadId,
      error,
    },
  };
}

function sendMessageToThreadErrorResult(
  threadId: string,
  message: string,
  error: string,
): AgentToolResult<SendMessageToThreadToolDetails> {
  return {
    content: [{ type: "text", text: error }],
    details: {
      action: sendMessageToThreadAction,
      threadId,
      message,
      error,
    },
  };
}

function projectionFromToolResult(
  result: AgentToolResult<
    | CreateChildThreadToolDetails
    | ListThreadsToolDetails
    | ReadThreadToolDetails
    | SendMessageToThreadToolDetails
  >,
): {
  readonly detail: string;
  readonly text: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly status?: TimelineToolCall["status"];
} {
  const details = result.details as unknown as Readonly<Record<string, unknown>>;
  return {
    detail: detailFromThreadToolDetails(details),
    text: textFromAgentToolResult(result),
    details,
    ...(typeof details.error === "string" ? { status: "error" as const } : {}),
  };
}

function finalThreadToolProjectionFromOutput(output: unknown):
  | {
      readonly detail: string;
      readonly text: string;
      readonly details: Readonly<Record<string, unknown>>;
      readonly status?: TimelineToolCall["status"];
    }
  | undefined {
  if (!isRecord(output) || !isRecord(output.details) || !isFinalThreadToolDetails(output.details)) {
    return undefined;
  }
  return {
    detail: detailFromThreadToolDetails(output.details),
    text: textFromToolOutput(output),
    details: output.details,
    ...(typeof output.details.error === "string" ? { status: "error" as const } : {}),
  };
}

function isFinalThreadToolDetails(details: Record<string, unknown>): boolean {
  if (typeof details.error === "string") {
    return true;
  }
  if (details.action === listThreadsAction) {
    return Array.isArray(details.threads);
  }
  if (details.action === createChildThreadAction) {
    return typeof details.childThreadId === "string";
  }
  if (details.action === readThreadAction) {
    return Array.isArray(details.messages);
  }
  if (details.action === sendMessageToThreadAction) {
    return details.status === "queued" || details.status === "sent";
  }
  return false;
}

function detailFromThreadToolDetails(details: Readonly<Record<string, unknown>>): string {
  if (typeof details.error === "string") {
    return details.error;
  }
  if (details.action === listThreadsAction) {
    const count = Array.isArray(details.threads) ? details.threads.length : 0;
    return `Listed ${count} thread${count === 1 ? "" : "s"}`;
  }
  if (details.action === createChildThreadAction) {
    const title =
      typeof details.title === "string"
        ? details.title
        : typeof details.prompt === "string"
          ? details.prompt
          : "unknown";
    return `Created child thread: ${title}`;
  }
  if (details.action === readThreadAction) {
    const title =
      typeof details.title === "string"
        ? details.title
        : typeof details.threadId === "string"
          ? details.threadId
          : "unknown";
    return `Read thread: ${title}`;
  }
  if (details.action === sendMessageToThreadAction) {
    const verb = details.status === "queued" ? "Queued" : "Sent";
    return `${verb} message to thread: ${typeof details.threadId === "string" ? details.threadId : "unknown"}`;
  }
  return "Thread tool result";
}

function textFromAgentToolResult(result: AgentToolResult<unknown>): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function textFromToolOutput(output: { readonly content?: unknown }): string {
  if (!Array.isArray(output.content)) {
    return "";
  }
  return output.content
    .map((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function listThreadsForContext(
  store: OrchestrationOwnerHost,
  parentRef: SessionRef,
): readonly ThreadListEntry[] {
  const entries = new Map<string, ThreadListEntry>();
  const state = store.orchestrationState();
  const parentChildren = state.orchestrationChildren.filter(
    (child) =>
      child.parentWorkspaceId === parentRef.workspaceId &&
      child.parentSessionId === parentRef.sessionId,
  );
  const childSessionKeys = new Map(
    parentChildren.map((child) => [sessionKey(childSessionRef(child)), child] as const),
  );

  for (const workspace of state.workspaces) {
    if (
      workspace.id !== parentRef.workspaceId &&
      !parentChildren.some((child) => child.childWorkspaceId === workspace.id)
    ) {
      continue;
    }
    for (const session of workspace.sessions) {
      if (session.archivedAt) {
        continue;
      }
      const key = sessionKey({ workspaceId: workspace.id, sessionId: session.id });
      const child = childSessionKeys.get(key);
      entries.set(key, {
        threadId: child?.id ?? session.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        title: child?.title ?? session.title,
        status: child?.status ?? session.status,
        relationship: child
          ? "child"
          : session.id === parentRef.sessionId && workspace.id === parentRef.workspaceId
            ? "current"
            : "workspace",
        updatedAt: child?.updatedAt ?? session.updatedAt,
        preview: child?.latestTranscript ?? session.preview,
        ...(child ? { childThreadId: child.id } : {}),
      });
    }
  }

  for (const child of parentChildren) {
    const key = sessionKey(childSessionRef(child));
    if (entries.has(key)) {
      continue;
    }
    entries.set(key, {
      threadId: child.id,
      workspaceId: child.childWorkspaceId,
      sessionId: child.childSessionId,
      title: child.title,
      status: child.status,
      relationship: "child",
      updatedAt: child.updatedAt,
      preview: child.latestTranscript,
      childThreadId: child.id,
    });
  }

  return [...entries.values()].sort((left, right) => {
    const rank = relationshipRank(left.relationship) - relationshipRank(right.relationship);
    if (rank !== 0) {
      return rank;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt.localeCompare(left.updatedAt);
    }
    return left.title.localeCompare(right.title);
  });
}

/**
 * Display slice of the unbounded thread list: the current thread and its
 * children first, then at most LIST_THREADS_OTHER_LIMIT other workspace
 * threads with previews cut to LIST_THREADS_PREVIEW_LIMIT. Resolution keeps
 * the full list so older threads stay addressable; only the formatted output
 * is bounded.
 */
function shownListThreads(
  threads: readonly ThreadListEntry[],
  query: string | undefined,
): { readonly threads: readonly ThreadListEntry[]; readonly omitted: number } {
  const normalized = query?.trim().toLowerCase();
  const scoped = normalized
    ? threads.filter((thread) => thread.title.toLowerCase().includes(normalized))
    : threads;
  const current = scoped.filter((thread) => thread.relationship === "current");
  const children = scoped.filter((thread) => thread.relationship === "child");
  const others = scoped.filter((thread) => thread.relationship === "workspace");
  const shownOthers = others.slice(0, LIST_THREADS_OTHER_LIMIT);
  return {
    threads: [...current, ...children, ...shownOthers].map((thread) =>
      thread.preview.length > LIST_THREADS_PREVIEW_LIMIT
        ? { ...thread, preview: truncateListThreadsPreview(thread.preview) }
        : thread,
    ),
    omitted: others.length - shownOthers.length,
  };
}

function truncateListThreadsPreview(preview: string): string {
  return preview.length > LIST_THREADS_PREVIEW_LIMIT
    ? `${preview.slice(0, LIST_THREADS_PREVIEW_LIMIT)}…`
    : preview;
}

function relationshipRank(relationship: ThreadListEntry["relationship"]): number {
  if (relationship === "current") {
    return 0;
  }
  if (relationship === "child") {
    return 1;
  }
  return 2;
}

function resolveThreadTarget(
  store: OrchestrationOwnerHost,
  parentRef: SessionRef,
  threadId: string,
): ResolvedThreadTarget | undefined {
  const normalized = threadId.trim();
  if (!normalized) {
    return undefined;
  }

  const visibleThread = listThreadsForContext(store, parentRef).find(
    (thread) =>
      thread.threadId === normalized ||
      thread.sessionId === normalized ||
      thread.childThreadId === normalized ||
      `${thread.workspaceId}:${thread.sessionId}` === normalized,
  );
  if (!visibleThread) {
    return undefined;
  }

  const child = visibleThread.childThreadId
    ? store
        .orchestrationState()
        .orchestrationChildren.find((entry) => entry.id === visibleThread.childThreadId)
    : undefined;
  return {
    sessionRef: {
      workspaceId: visibleThread.workspaceId,
      sessionId: visibleThread.sessionId,
    },
    ...(child ? { child } : {}),
  };
}

function formatThreadList(threads: readonly ThreadListEntry[], omitted: number): string {
  if (threads.length === 0) {
    return "No visible threads.";
  }
  const lines = [
    "Visible threads:",
    ...threads.map(
      (thread) =>
        `- ${thread.threadId} (${thread.relationship}, ${thread.status}): ${thread.title}` +
        (thread.preview ? ` - ${thread.preview}` : ""),
    ),
  ];
  if (omitted > 0) {
    lines.push(
      `+${omitted} more thread(s) not shown. Pass query to list_threads to find an older thread by title.`,
    );
  }
  return lines.join("\n");
}

function formatThreadReadResult(result: {
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly goal?: string;
  readonly messages: readonly OrchestrationChildTranscriptMessage[];
  readonly omittedEarlier?: number;
  readonly truncated?: boolean;
  readonly notice?: string;
}): string {
  const omitted = result.omittedEarlier ?? 0;
  const lines = [
    `Thread ${result.threadId}: ${result.title}`,
    `Status: ${result.status}`,
    ...(result.goal ? [`Goal: ${result.goal}`] : []),
    `Transcript: showing ${result.messages.length} message(s), ${omitted} earlier omitted.`,
  ];
  if (result.messages.length === 0) {
    lines.push("- No transcript messages loaded.");
  } else {
    lines.push(...result.messages.map((message) => `- ${message.role}: ${message.text}`));
  }
  if (result.truncated) {
    lines.push("Some messages were shortened to fit the output budget.");
  }
  if (result.notice) {
    lines.push(result.notice);
  }
  return lines.join("\n");
}

function formatCreateChildThreadResult(
  result: CreateChildThreadToolDetails,
  isLead: boolean,
): string {
  // Lead parents are woken by the child's report; only non-lead parents,
  // which receive no report, get the wait_seconds hint.
  const closing = isLead
    ? "This child reports back automatically when its run ends; act on the report."
    : "To wait for completion, call read_thread once with wait_seconds (up to 120) instead of polling.";
  return (
    `Created child thread: ${result.title ?? result.prompt}\n` +
    `childThreadId: ${result.childThreadId ?? ""}\n` +
    `childWorkspaceId: ${result.childWorkspaceId ?? ""}\n` +
    `childSessionId: ${result.childSessionId ?? ""}` +
    (result.mode ? `\nmode: ${result.mode}` : "") +
    (result.deliveryStatus ? `\ninitialPrompt: ${result.deliveryStatus}` : "") +
    (result.delegationsRemaining !== undefined
      ? `\ndelegationsRemaining: ${result.delegationsRemaining}`
      : "") +
    `\n${closing}`
  );
}

function formatSendMessageToThreadResult(result: SendMessageToThreadToolDetails): string {
  const verb = result.status === "queued" ? "Queued" : "Sent";
  return (
    (result.interrupted === true
      ? `Interrupted thread ${result.threadId} and started a new turn. `
      : "") +
    `${verb} message to thread ${result.threadId}.` +
    (result.queuedMessageCount && result.queuedMessageCount > 0
      ? ` Pending messages: ${result.queuedMessageCount}.`
      : "")
  );
}

function mergeEvidenceRecords(
  existing: readonly OrchestrationEvidenceRecord[] = [],
  derived: readonly OrchestrationEvidenceRecord[],
): readonly OrchestrationEvidenceRecord[] {
  const records = new Map<string, OrchestrationEvidenceRecord>();
  for (const record of existing) {
    records.set(record.id, record);
  }
  for (const record of derived) {
    records.set(record.id, {
      ...records.get(record.id),
      ...record,
    });
  }
  return capEvidenceRecords(
    [...records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  );
}

function capEvidenceRecords(
  records: readonly OrchestrationEvidenceRecord[],
): readonly OrchestrationEvidenceRecord[] {
  if (records.length <= MAX_EVIDENCE_RECORDS_PER_CHILD) {
    return records;
  }
  const priority = records.filter(
    (record) =>
      record.status === "blocked" ||
      record.status === "failed" ||
      record.source === "orchestrator-accepted",
  );
  const remaining = records.filter((record) => !priority.includes(record));
  return [...priority, ...remaining].slice(0, MAX_EVIDENCE_RECORDS_PER_CHILD);
}

function parentEvidenceIndex(
  store: OrchestrationOwnerHost,
  children: readonly OrchestrationChildThread[],
): ReadonlyMap<string, readonly OrchestrationEvidenceRecord[]> {
  const childById = new Map(children.map((child) => [child.id, child] as const));
  const parentKeys = new Set(
    children.map((child) =>
      sessionKey({
        workspaceId: child.parentWorkspaceId,
        sessionId: child.parentSessionId,
      }),
    ),
  );
  const index = new Map<string, OrchestrationEvidenceRecord[]>();
  for (const key of parentKeys) {
    const transcript = store.transcriptForKey(key);
    for (const record of evidenceFromParentTranscript(childById, transcript)) {
      const bucket = index.get(record.childThreadId) ?? [];
      bucket.push(record);
      index.set(record.childThreadId, bucket);
    }
  }
  return index;
}

function evidenceFromChildTranscript(
  child: OrchestrationChildThread,
  transcript: readonly TranscriptMessage[],
): readonly OrchestrationEvidenceRecord[] {
  return transcript.flatMap((message): readonly OrchestrationEvidenceRecord[] => {
    if (message.kind === "tool") {
      return [commandEvidenceFromTool(child, message)];
    }
    if (message.kind !== "message" || message.role !== "assistant") {
      return [];
    }
    const text = message.text.trim();
    if (!text) {
      return [];
    }
    const severity = severityFromText(text);
    const isBlocker = looksLikeBlocker(text);
    return [
      {
        id: evidenceId("worker", message.id),
        childThreadId: child.id,
        kind: isBlocker ? "blocker" : severity ? "review_finding" : "worker_report",
        source: "worker-reported",
        status: isBlocker ? "blocked" : "reported",
        title: isBlocker
          ? "Worker reported blocker"
          : severity
            ? `${severity} review finding`
            : "Worker reported output",
        detail: truncateEvidenceDetail(text),
        ...(severity ? { severity } : {}),
        parentSessionId: child.parentSessionId,
        childSessionId: child.childSessionId,
        createdAt: message.createdAt,
      },
    ];
  });
}

function commandEvidenceFromTool(
  child: OrchestrationChildThread,
  tool: TimelineToolCall,
): OrchestrationEvidenceRecord {
  const command = commandFromToolInput(tool.input);
  return {
    id: evidenceId("command", tool.callId),
    childThreadId: child.id,
    kind: "command",
    source: "command",
    status: tool.status === "running" ? "running" : tool.status === "error" ? "failed" : "passed",
    title: command && looksLikeTestCommand(command) ? "Test command run" : "Command or tool run",
    detail: tool.detail ? truncateEvidenceDetail(tool.detail) : tool.label,
    ...(command ? { command } : {}),
    toolName: tool.toolName,
    parentSessionId: child.parentSessionId,
    childSessionId: child.childSessionId,
    createdAt: tool.createdAt,
  };
}

function evidenceFromParentTranscript(
  childById: ReadonlyMap<string, OrchestrationChildThread>,
  transcript: readonly TranscriptMessage[],
): readonly OrchestrationEvidenceRecord[] {
  return transcript.flatMap((message): readonly OrchestrationEvidenceRecord[] => {
    if (message.kind === "message" && message.role === "assistant") {
      return explicitAcceptanceEvidenceFromParentMessage(childById, message);
    }
    if (message.kind !== "tool" || message.status !== "success" || !isRecord(message.output)) {
      return [];
    }
    const details = isRecord(message.output.details) ? message.output.details : undefined;
    if (!details) {
      return [];
    }
    const childId =
      typeof details.childThreadId === "string"
        ? details.childThreadId
        : typeof details.threadId === "string"
          ? details.threadId
          : undefined;
    const child = childId ? childById.get(childId) : undefined;
    if (!child) {
      return [];
    }
    if (details.action === readThreadAction && details.childThreadId === child.id) {
      return [
        {
          id: evidenceId("observed-read", message.callId),
          childThreadId: child.id,
          kind: "orchestrator_observation",
          source: "orchestrator-observed",
          status: "reported",
          title: "Lead read child output",
          detail: truncateEvidenceDetail(textFromToolOutput(message.output)),
          parentSessionId: child.parentSessionId,
          childSessionId: child.childSessionId,
          createdAt: message.createdAt,
        },
      ];
    }
    if (details.action === sendMessageToThreadAction && details.threadId === child.id) {
      return [
        {
          id: evidenceId("follow-up", message.callId),
          childThreadId: child.id,
          kind: "orchestrator_action",
          source: "orchestrator-action",
          status: "reported",
          title: "Lead sent follow-up",
          ...(typeof details.message === "string"
            ? { detail: truncateEvidenceDetail(details.message) }
            : {}),
          parentSessionId: child.parentSessionId,
          childSessionId: child.childSessionId,
          createdAt: message.createdAt,
        },
      ];
    }
    return [];
  });
}

function explicitAcceptanceEvidenceFromParentMessage(
  childById: ReadonlyMap<string, OrchestrationChildThread>,
  message: Extract<TranscriptMessage, { kind: "message" }>,
): readonly OrchestrationEvidenceRecord[] {
  const records: OrchestrationEvidenceRecord[] = [];
  for (const line of message.text.split("\n")) {
    const match = /^orchestrator-accepted:\s*(\S+)\s*(.*)$/i.exec(line.trim());
    if (!match) {
      continue;
    }
    const child = childById.get(match[1] ?? "");
    if (!child) {
      continue;
    }
    records.push({
      id: evidenceId("accepted", `${message.id}:${child.id}`),
      childThreadId: child.id,
      kind: "orchestrator_acceptance",
      source: "orchestrator-accepted",
      status: "accepted",
      title: "Orchestrator accepted child evidence",
      detail: truncateEvidenceDetail(match[2] || message.text),
      parentSessionId: child.parentSessionId,
      childSessionId: child.childSessionId,
      createdAt: message.createdAt,
    });
  }
  return records;
}

function blockerEvidenceFromChildStatus(
  child: OrchestrationChildThread,
  status: OrchestrationChildThreadStatus,
  updatedAt: string,
): readonly OrchestrationEvidenceRecord[] {
  if (status !== "failed") {
    return [];
  }
  return [
    {
      id: evidenceId("blocker-status", child.id),
      childThreadId: child.id,
      kind: "blocker",
      source: "blocker",
      status: "blocked",
      title: "Child thread failed",
      detail: child.latestTranscript,
      parentSessionId: child.parentSessionId,
      childSessionId: child.childSessionId,
      createdAt: updatedAt,
    },
  ];
}

function commandFromToolInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  for (const key of ["cmd", "command", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function looksLikeTestCommand(command: string): boolean {
  return /\b(test|spec|typecheck|build|playwright|vitest|jest|tsc)\b/i.test(command);
}

function looksLikeBlocker(text: string): boolean {
  return /^\s*(?:\[?BLOCKER\]?|blocked)\s*:/i.test(text);
}

function severityFromText(text: string): OrchestrationEvidenceRecord["severity"] | undefined {
  const match = /^\s*\[?(P[0-3])\]?\s*:/.exec(text);
  return match?.[1] as OrchestrationEvidenceRecord["severity"] | undefined;
}

function truncateReadThreadText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function truncateEvidenceDetail(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
}

function evidenceId(prefix: string, sourceId: string): string {
  return `${prefix}:${sourceId}`;
}

async function workspaceGitRef(
  workspaceId: string,
  workspacePath: string,
): Promise<OrchestrationEvidenceRecord["git"] | undefined> {
  const [branch, head] = await gitOutputLines(workspacePath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
    "HEAD",
  ]);
  const branchName = branch && branch !== "HEAD" ? branch : undefined;
  if (!branchName && !head) {
    return undefined;
  }
  return {
    workspaceId,
    ...(branchName ? { branchName } : {}),
    ...(head ? { headSha: head } : {}),
  };
}

async function gitOutputLines(
  workspacePath: string,
  args: readonly string[],
): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: workspacePath });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function childForToolCall(
  store: OrchestrationOwnerHost,
  input: Pick<SpawnChildThreadInput, "parentWorkspaceId" | "parentSessionId" | "sourceToolCallId">,
): OrchestrationChildThread | undefined {
  if (!input.sourceToolCallId) {
    return undefined;
  }
  return store
    .orchestrationState()
    .orchestrationChildren.find(
      (child) =>
        child.sourceToolCallId === input.sourceToolCallId &&
        child.parentWorkspaceId === input.parentWorkspaceId &&
        child.parentSessionId === input.parentSessionId,
    );
}

function childToolCallKey(
  input: Pick<SpawnChildThreadInput, "parentWorkspaceId" | "parentSessionId" | "sourceToolCallId">,
): string {
  return `${input.parentWorkspaceId}\0${input.parentSessionId}\0${input.sourceToolCallId ?? ""}`;
}

function isTimelineToolCall(value: TranscriptMessage): value is TimelineToolCall {
  return (
    value.kind === "tool" &&
    "callId" in value &&
    "toolName" in value &&
    "status" in value &&
    typeof value.callId === "string" &&
    typeof value.toolName === "string"
  );
}

function toOrchestrationStatus(
  status: string,
  sessionRef: SessionRef,
  store: OrchestrationOwnerHost,
): OrchestrationChildThreadStatus {
  if (store.getQueuedComposerMessages(sessionRef).length > 0) {
    return "waiting";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "running") {
    return "running";
  }
  // An idle session that has never produced a run is queued, not complete. The
  // child record is inserted before its prompt is void-fired, so without this a
  // never-started child would read "complete" and trigger a false parent wake.
  if (!hasStartedRun(store, sessionRef)) {
    return "queued";
  }
  return "complete";
}

function hasStartedRun(store: OrchestrationOwnerHost, sessionRef: SessionRef): boolean {
  const transcript = store.transcriptFor(sessionRef);
  return transcript.some(isWorkerResponse);
}

/**
 * Status overrides that hold without a cached transcript. Applied when
 * `projectOrchestrationChild` cannot derive from the transcript (not loaded
 * yet, e.g. a background child right after a restart): a live run, a dead
 * session, or queued follow-ups are facts the empty cache cannot hide, while
 * anything else keeps the stored status instead of inventing `queued`.
 */
function liveChildStatus(
  sessionStatus: string | undefined,
  sessionRef: SessionRef,
  store: OrchestrationOwnerHost,
): OrchestrationChildThreadStatus | undefined {
  if (store.getQueuedComposerMessages(sessionRef).length > 0) {
    return "waiting";
  }
  if (sessionStatus === "failed") {
    return "failed";
  }
  if (sessionStatus === "running") {
    return "running";
  }
  return undefined;
}

/**
 * Whether a raw transcript row survives into read_thread output. Only the
 * parent/child messages and one-line tool rows are kept: pins, cards,
 * activity, summaries and other extension rows are dropped, and the
 * branch/compaction summaries never spoke as the thread itself.
 */
function isKeptReadThreadMessage(message: TranscriptMessage): boolean {
  if (message.kind === "tool") {
    return true;
  }
  return (
    message.kind === "message" &&
    (message.role === "user" || message.role === "assistant") &&
    message.text.length > 0
  );
}

/** Kind-only count of the rows read_thread would return. No text is built. */
function countKeptReadThreadMessages(transcript: readonly TranscriptMessage[]): number {
  let count = 0;
  for (const message of transcript) {
    if (isKeptReadThreadMessage(message)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Raw transcript index of the `firstIndex`-th kept row (`total` kept rows in
 * all), so the caller converts only the tail slice. Clamped to the ends.
 */
function rawIndexOfKeptReadThreadMessage(
  transcript: readonly TranscriptMessage[],
  firstIndex: number,
  total: number,
): number {
  if (firstIndex <= 0) {
    return 0;
  }
  if (firstIndex >= total) {
    return transcript.length;
  }
  let kept = 0;
  for (let index = 0; index < transcript.length; index += 1) {
    const message = transcript[index];
    if (message !== undefined && isKeptReadThreadMessage(message)) {
      if (kept === firstIndex) {
        return index;
      }
      kept += 1;
    }
  }
  return transcript.length;
}

/**
 * Convert a tail slice of raw transcript rows to read_thread messages.
 * Tool calls collapse to one line each (`toolName: label [status]`).
 */
function toReadThreadMessages(
  transcript: readonly TranscriptMessage[],
): OrchestrationChildTranscriptMessage[] {
  const messages: OrchestrationChildTranscriptMessage[] = [];
  for (const message of transcript) {
    if (message.kind === "tool") {
      const label = "label" in message && typeof message.label === "string" ? message.label : "";
      messages.push({
        id: message.id,
        role: "system",
        text: label
          ? `${message.toolName}: ${label} [${message.status}]`
          : `${message.toolName} [${message.status}]`,
        createdAt: message.createdAt,
      });
    } else if (isKeptReadThreadMessage(message) && message.kind === "message") {
      messages.push({
        id: message.id,
        role: message.role === "user" ? "parent" : "child",
        text: message.text,
        createdAt: message.createdAt,
      });
    }
  }
  return messages;
}

/**
 * Enforce the total message-text budget, squeezing the earliest messages
 * first so the newest evidence survives intact. Post-trim lengths account
 * for the ellipsis so the returned sum never exceeds the budget.
 */
function enforceReadThreadTotalBudget(
  messages: readonly OrchestrationChildTranscriptMessage[],
  budget: number,
): { readonly messages: OrchestrationChildTranscriptMessage[]; readonly trimmed: boolean } {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
  }
  if (total <= budget) {
    return { messages: [...messages], trimmed: false };
  }
  const out = [...messages];
  let keptAfter = 0;
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const current = out[index];
    if (!current) {
      continue;
    }
    const allow = Math.max(0, budget - keptAfter);
    if (current.text.length > allow) {
      out[index] = {
        ...current,
        text: allow > 0 ? `${current.text.slice(0, allow - 1)}…` : "",
      };
      keptAfter += allow;
    } else {
      keptAfter += current.text.length;
    }
  }
  return { messages: out, trimmed: true };
}

function toChildTranscript(
  transcript: readonly TranscriptMessage[],
  limit: number,
): readonly OrchestrationChildTranscriptMessage[] {
  const messages: OrchestrationChildTranscriptMessage[] = [];
  for (let index = transcript.length - 1; index >= 0 && messages.length < limit; index -= 1) {
    const message = transcript[index];
    if (!message) {
      continue;
    }
    const text = transcriptText(message);
    if (!text) {
      continue;
    }
    messages.push({
      id: message.id,
      role: transcriptRole(message),
      text,
      createdAt: message.createdAt,
    });
  }
  return messages.reverse();
}

function recentTranscriptItems(
  transcript: readonly TranscriptMessage[],
): readonly TranscriptMessage[] {
  // Pins sit at the end of a transcript but are never child messages, so they take no slots.
  return transcript.filter((item) => item.kind !== "pin").slice(-MAX_CHILD_TRANSCRIPT_MESSAGES);
}

function transcriptText(message: TranscriptMessage): string {
  switch (message.kind) {
    case "message":
      return message.text;
    case "custom":
      return `[${message.customType}] ${message.text}`;
    case "card": {
      const { title, subtitle } = message.card;
      return subtitle ? `${title}: ${subtitle}` : title;
    }
    case "activity":
    case "tool":
      return message.detail ? `${message.label}: ${message.detail}` : message.label;
    case "summary":
      return message.metadata ? `${message.label}: ${message.metadata}` : message.label;
    // A pin is extension state above the composer, not something the thread said.
    case "pin":
      return "";
    default: {
      const unhandled: never = message;
      void unhandled;
      return "";
    }
  }
}

function transcriptRole(message: TranscriptMessage): OrchestrationChildTranscriptMessage["role"] {
  if (message.kind !== "message") {
    return "system";
  }
  if (message.role === "user") {
    return "parent";
  }
  if (message.role === "assistant") {
    return "child";
  }
  return "system";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= CHILD_TITLE_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, CHILD_TITLE_LIMIT - 3).trimEnd()}...`;
}
