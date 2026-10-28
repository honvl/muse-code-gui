import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const createChildThreadToolName = "create_child_thread";
export const createChildThreadAction = "pi_gui_create_child_thread";
export const listThreadsToolName = "list_threads";
export const listThreadsAction = "pi_gui_list_threads";
export const readThreadToolName = "read_thread";
export const readThreadAction = "pi_gui_read_thread";
export const sendMessageToThreadToolName = "send_message_to_thread";
export const sendMessageToThreadAction = "pi_gui_send_message_to_thread";

export type OrchestrationChildMode = "scout" | "worker";

/** Mirrors MAX_CHILD_DEPTH in pi-sdk-driver child isolation; kept local to avoid a runtime cross-package import. */
export const ORCHESTRATION_MAX_CHILD_DEPTH = 3;

export interface CreateChildThreadToolDetails {
  readonly action: typeof createChildThreadAction;
  readonly prompt: string;
  readonly mode?: OrchestrationChildMode;
  readonly depth?: number;
  readonly childThreadId?: string;
  readonly childWorkspaceId?: string;
  readonly childSessionId?: string;
  readonly title?: string;
  readonly deliveryStatus?: "running" | "responded";
  readonly delegationsRemaining?: number;
  readonly briefWarnings?: readonly string[];
  readonly generation?: number;
  /** The brief continued an existing idle sidekick instead of spawning one. */
  readonly reused?: boolean;
  /** Why a warm sidekick was passed over (context budget), when it was. */
  readonly reuseNote?: string;
  readonly error?: string;
}

export interface OrchestrationThreadListEntry {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly relationship: "current" | "child" | "workspace";
  readonly updatedAt: string;
  readonly preview: string;
  readonly childThreadId?: string;
}

export interface OrchestrationThreadTranscriptMessage {
  readonly id: string;
  readonly role: "parent" | "child" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export interface ListThreadsToolDetails {
  readonly action: typeof listThreadsAction;
  readonly threads?: readonly OrchestrationThreadListEntry[];
  readonly omitted?: number;
  readonly query?: string;
  readonly error?: string;
}

export interface ReadThreadToolDetails {
  readonly action: typeof readThreadAction;
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly childThreadId?: string;
  readonly goal?: string;
  readonly messages?: readonly OrchestrationThreadTranscriptMessage[];
  readonly truncated?: boolean;
  readonly totalMessages?: number;
  readonly omittedEarlier?: number;
  readonly waitedSeconds?: number;
  readonly timedOut?: boolean;
  readonly error?: string;
}

export interface SendMessageToThreadToolDetails {
  readonly action: typeof sendMessageToThreadAction;
  readonly threadId: string;
  readonly message: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly status?: "queued" | "sent";
  readonly queuedMessageCount?: number;
  readonly interrupted?: boolean;
  readonly generation?: number;
  readonly error?: string;
}

export interface OrchestrationRuntimeBridge {
  readonly createChildThread: (
    ctx: ExtensionContext,
    input: {
      readonly prompt: string;
      readonly sourcePrompt?: string;
      readonly toolCallId: string;
      readonly mode?: OrchestrationChildMode;
      readonly scope?: string;
      readonly fresh?: boolean;
      /** False when an earlier create_child_thread call of the same assistant message exists. */
      readonly firstInTurn?: boolean;
    },
  ) => Promise<AgentToolResult<CreateChildThreadToolDetails>>;
  readonly listThreads: (
    ctx: ExtensionContext,
    input?: { readonly query?: string },
  ) => Promise<AgentToolResult<ListThreadsToolDetails>>;
  readonly readThread: (
    ctx: ExtensionContext,
    threadId: string,
    options?: {
      readonly waitSeconds?: number;
      readonly signal?: AbortSignal;
      readonly full?: boolean;
    },
  ) => Promise<AgentToolResult<ReadThreadToolDetails>>;
  readonly sendMessageToThread: (
    ctx: ExtensionContext,
    input: { readonly threadId: string; readonly message: string; readonly interrupt?: boolean },
  ) => Promise<AgentToolResult<SendMessageToThreadToolDetails>>;
}

type OrchestrationToolDetails =
  | CreateChildThreadToolDetails
  | ListThreadsToolDetails
  | ReadThreadToolDetails
  | SendMessageToThreadToolDetails;

function createCreateChildThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: createChildThreadToolName,
    label: "Create child thread",
    description:
      "Delegate an independent investigation or implementation task to a separate pi-gui child thread that runs in parallel. Child threads run on the thread's configured sidekick model, falling back to the workspace default. A short brief (objective plus scope) is enough: the host adds default success criteria and verification. Children report back automatically when a run ends. Use mode scout for read-only investigations and worker when file changes or mutating shell are required.",
    promptSnippet:
      "create_child_thread: delegate independent work to a separate pi-gui child thread running in parallel.",
    promptGuidelines: [
      "create_child_thread takes a prompt plus optional scope, constraints, success_criteria and verify blocks; scope decides the single-writer rule, so parallel workers need disjoint scopes and an unscoped worker claims the whole workspace.",
      "Mode scout is read-only: it may run read-only, workspace-confined shell commands such as rg, grep, and ls, but cannot edit, write, or run mutating/background shell. Mode worker may edit files and run shell commands. Defaults to worker.",
      "Returns the child thread id, workspace id, and session id. A thin brief still spawns; a missing scope adds a hint to the result instead of blocking.",
      "Child threads are isolated: they cannot leave the workspace, write dotenv files, run destructive shell commands, or recurse past 3 levels. A scout cannot spawn a worker.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Concrete instructions for the child thread.",
        },
        scope: {
          type: "string",
          description:
            "Paths the child should work in, relative to the workspace (absolute paths must be inside it). Prose and (asides) around paths are ignored.",
        },
        constraints: {
          type: "string",
          description: "Limits the child must respect (what not to touch or change).",
        },
        success_criteria: {
          type: "string",
          description: "How the child knows it is done.",
        },
        verify: {
          type: "string",
          description: "Verification the child must run before reporting back.",
        },
        mode: {
          type: "string",
          enum: ["scout", "worker"],
          description:
            'Isolation mode: "scout" is read-only (search and review, plus read-only workspace-confined shell), "worker" may edit files and run shell commands. Defaults to "worker".',
        },
        fresh: {
          type: "boolean",
          description:
            "Start a new child. Without it, a lead's worker brief continues its most recent idle worker while that child's cache is warm. Pass true for parallel or unrelated slices.",
        },
      },
      required: ["prompt"],
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const prompt = createChildThreadBriefFromParams(params);
      if (!prompt) {
        throw new Error("create_child_thread requires a non-empty prompt.");
      }
      const sourcePrompt = createChildThreadPromptFromParams(params);
      const warnings = briefWarningsFromParams(params);
      const scope = createChildThreadScopeFromParams(params);
      const firstInTurn = isFirstCreateChildThreadCallInTurn(ctx?.sessionManager, toolCallId);
      const result = await bridge.createChildThread(ctx, {
        prompt,
        ...(sourcePrompt ? { sourcePrompt } : {}),
        toolCallId,
        mode: createChildThreadModeFromParams(params),
        ...(scope ? { scope } : {}),
        ...(isRecord(params) && params.fresh === true ? { fresh: true } : {}),
        ...(firstInTurn !== undefined ? { firstInTurn } : {}),
      });
      return attachBriefWarnings(result, warnings);
    },
  };
}

function createListThreadsTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: listThreadsToolName,
    label: "List threads",
    description: "List pi-gui threads visible to the current workspace and parent thread.",
    promptSnippet:
      "list_threads: list relevant pi-gui threads for the current workspace and parent context.",
    promptGuidelines: [
      "Use list_threads before reading or messaging another pi-gui thread when you need the exact thread id.",
      "Use the returned thread id with read_thread or send_message_to_thread.",
      "Pass query (a thread-title substring) to find an older thread without listing everything.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Thread-title substring to filter by. Omit to list recent threads.",
        },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return bridge.listThreads(ctx, listThreadsQueryFromParams(params));
    },
  };
}

function createReadThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: readThreadToolName,
    label: "Read thread",
    description:
      "Read a pi-gui thread transcript or child thread summary by id. " +
      "If the thread is still running, pass wait_seconds to block until it finishes " +
      "(up to 120s) instead of polling. " +
      "Incremental by default: returns only messages not yet seen by the calling parent; " +
      "pass full:true for the entire transcript.",
    promptSnippet: "read_thread: read a pi-gui thread transcript by id.",
    promptGuidelines: [
      "Args: thread_id (required); wait_seconds (up to 120) to block until the thread settles instead of returning immediately; full (return the whole window, not just unseen messages).",
      "Returns the latest window (default 8 messages) with per-message and total caps; earlier messages are reported as omitted.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id, child thread id, or session id to read.",
        },
        wait_seconds: {
          type: "number",
          description:
            "Seconds to wait for a running thread to finish before returning (max 120). Omit or 0 to return immediately.",
        },
        full: {
          type: "boolean",
          description:
            "Return the entire transcript. Omit for an incremental read of only messages not yet returned for this parent/child pair.",
        },
      },
      required: ["thread_id"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      if (!threadId) {
        return {
          content: [{ type: "text", text: "read_thread requires a thread_id." }],
          details: {
            action: readThreadAction,
            threadId: "",
            error: "read_thread requires a thread_id.",
          },
        };
      }
      const waitSeconds = readThreadWaitSecondsFromParams(params);
      const full = fullFromParams(params);
      return bridge.readThread(ctx, threadId, {
        ...(waitSeconds !== undefined ? { waitSeconds } : {}),
        ...(full !== undefined ? { full } : {}),
        signal,
      });
    },
  };
}

function createSendMessageToThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: sendMessageToThreadToolName,
    label: "Send message to thread",
    description: "Send a follow-up message to an existing pi-gui thread.",
    promptSnippet: "send_message_to_thread: send a follow-up to an existing pi-gui thread.",
    promptGuidelines: [
      "Use send_message_to_thread to follow up with an existing child or sibling pi-gui thread.",
      "Use a thread id returned by list_threads or create_child_thread.",
      "If a child is drifting, pass interrupt:true to stop its current run before the message starts a new turn; otherwise steer it without interrupting.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id, child thread id, or session id to message.",
        },
        message: {
          type: "string",
          description: "Follow-up message to send.",
        },
        interrupt: {
          type: "boolean",
          description:
            "Set true to interrupt a still-running thread before delivering, so the message starts a new turn. Omit or false to steer without interrupting.",
        },
      },
      required: ["thread_id", "message"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      const message = messageFromParams(params);
      if (!threadId || !message) {
        return {
          content: [
            { type: "text", text: "send_message_to_thread requires thread_id and message." },
          ],
          details: {
            action: sendMessageToThreadAction,
            threadId: threadId ?? "",
            message: message ?? "",
            error: "send_message_to_thread requires thread_id and message.",
          },
        };
      }
      const interrupt = interruptFromParams(params);
      return bridge.sendMessageToThread(ctx, {
        threadId,
        message,
        ...(interrupt !== undefined ? { interrupt } : {}),
      });
    },
  };
}

export function createOrchestrationRuntimeTools(
  bridge: OrchestrationRuntimeBridge,
): readonly ToolDefinition<any, OrchestrationToolDetails>[] {
  return [
    createCreateChildThreadTool(bridge),
    createListThreadsTool(bridge),
    createReadThreadTool(bridge),
    createSendMessageToThreadTool(bridge),
  ];
}

export function createOrchestrationRuntimeExtension(
  bridge: OrchestrationRuntimeBridge,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createOrchestrationRuntimeTools(bridge)) {
      pi.registerTool(tool);
    }
  };
}

export function createChildThreadPromptFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  return prompt || undefined;
}

export interface ChildBriefParts {
  readonly prompt: string;
  readonly scope?: string;
  readonly constraints?: string;
  readonly success_criteria?: string;
  readonly verify?: string;
  /** Child isolation mode; selects the self-check block. Defaults to worker. */
  readonly mode?: OrchestrationChildMode;
}

/**
 * Always-on closing instruction appended to every child brief so each handoff
 * ends with a structured report. The lead acts on that report and only calls
 * read_thread for detail it omits. The report lands in the lead's
 * frontier-priced context while the child is near-free, so the child
 * compresses: a short fixed form, summarized rather than pasted.
 */
export const CHILD_REPORT_SUFFIX =
  "Do not commit or push. End with a report under ~800 characters in this form:\nResult: what you found or changed, in 1-2 sentences.\nFiles: paths changed or inspected.\nChecks: each command you ran and its outcome.\nRisks: blockers or open questions, or none.\nSummarize; never paste files, diffs, or logs.";

/**
 * Child-side quality loop: child tokens are near-free, so the child checks
 * and retries before the lead pays to review. Workers re-read their own diff;
 * scouts have no diff, so they only check their findings.
 */
export const WORKER_SELF_CHECK =
  "Before reporting, re-read your own diff against the success criteria, then rerun the narrowest check until it passes or you hit a real blocker.";
export const SCOUT_SELF_CHECK =
  "Before reporting, check your findings against the success criteria.";

/**
 * Host-supplied defaults so the cheapest possible delegation is a one-liner:
 * `create_child_thread({prompt})` already carries everything the child needs
 * to self-direct, so delegating competes with doing the work by hand instead
 * of losing on briefing friction. Scope keeps its hint: it decides the
 * single-writer rule, so it must come from the lead.
 */
export const DEFAULT_SUCCESS_CRITERIA =
  "The change matches the objective, and the project's narrowest relevant check passes.";
export const DEFAULT_VERIFY =
  "Run the narrowest check that proves this changed behaviour, and report the command and outcome.";

/**
 * Compose the single prompt string handed to the child-thread bridge.
 * The base prompt comes first, then each optional block as a labeled section
 * in fixed order (Scope, Constraints, Success criteria, Verify), separated
 * by blank lines. Blank scope/constraints blocks are omitted; blank success
 * criteria/verify fall back to the host defaults above. The mode's self-check
 * comes next, and the report suffix is always appended last so even a bare
 * prompt teaches the report contract.
 */
export function composeChildBrief(parts: ChildBriefParts): string {
  const blocks = [parts.prompt.trim()];
  const labeled: ReadonlyArray<readonly [string, string | undefined]> = [
    ["Scope", parts.scope],
    ["Constraints", parts.constraints],
    ["Success criteria", parts.success_criteria?.trim() || DEFAULT_SUCCESS_CRITERIA],
    ["Verify", parts.verify?.trim() || DEFAULT_VERIFY],
  ];
  for (const [label, value] of labeled) {
    const trimmed = value?.trim();
    if (trimmed) blocks.push(`${label}: ${trimmed}`);
  }
  blocks.push(parts.mode === "scout" ? SCOUT_SELF_CHECK : WORKER_SELF_CHECK);
  blocks.push(CHILD_REPORT_SUFFIX);
  return blocks.join("\n\n");
}

/**
 * Feedback for the lead when a brief is missing scope. Success criteria and
 * verify now fall back to host defaults, so only scope still hints — it
 * decides the single-writer rule and must come from the lead. Warnings are
 * never delivered to the child: they are attached to the tool result so the
 * lead writes better briefs next time. A thin brief still spawns; this never
 * rejects.
 */
export const SCOPE_BRIEF_WARNING = "Brief hint: add scope so the child knows where to work.";

export function briefWarningsFromParams(params: unknown): readonly string[] {
  if (!isRecord(params)) {
    return [];
  }
  const warnings: string[] = [];
  if (!optionalBriefParam(params, "scope")) {
    warnings.push(SCOPE_BRIEF_WARNING);
  }
  return warnings;
}

/**
 * Attach brief-quality feedback to a create_child_thread result. Appends a
 * single line to the result text and records the warnings on the details.
 * The child prompt itself is untouched.
 */
export function attachBriefWarnings(
  result: AgentToolResult<CreateChildThreadToolDetails>,
  warnings: readonly string[],
): AgentToolResult<CreateChildThreadToolDetails> {
  if (warnings.length === 0) {
    return result;
  }
  const hintLine = warnings.join(" ");
  const content = [...result.content];
  let appended = false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const item = content[index];
    if (item?.type === "text") {
      content[index] = { ...item, text: `${item.text}\n${hintLine}` };
      appended = true;
      break;
    }
  }
  if (!appended) {
    content.push({ type: "text", text: hintLine });
  }
  return {
    ...result,
    content,
    details: { ...result.details, briefWarnings: [...warnings] },
  };
}

/**
 * Read the full child brief (prompt plus optional scope/constraints/
 * success_criteria/verify blocks) from create_child_thread params.
 */
export function createChildThreadBriefFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const prompt = createChildThreadPromptFromParams(params);
  if (!prompt) {
    return undefined;
  }
  return composeChildBrief({
    prompt,
    scope: optionalBriefParam(params, "scope"),
    constraints: optionalBriefParam(params, "constraints"),
    success_criteria: optionalBriefParam(params, "success_criteria"),
    verify: optionalBriefParam(params, "verify"),
    mode: createChildThreadModeFromParams(params),
  });
}

function optionalBriefParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function createChildThreadModeFromParams(
  params: unknown,
): OrchestrationChildMode | undefined {
  if (!isRecord(params)) return undefined;
  return params.mode === "scout" || params.mode === "worker" ? params.mode : undefined;
}

/** Raw `scope` string from create_child_thread params, when present. Host-side overlap checks use this; the composed brief text carries it to the child. */
export function createChildThreadScopeFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return optionalBriefParam(params, "scope");
}

/** Steps walked back from the session leaf to find the calling assistant message. */
const TURN_LOOKBACK_LIMIT = 64;

/**
 * Whether `toolCallId` is the first create_child_thread call of its assistant
 * message. Pi persists the assistant message before executing its tools, so
 * the message sits at (or just behind tool results before) the session leaf.
 * Undefined when the session manager cannot say (tests, older hosts).
 */
export function isFirstCreateChildThreadCallInTurn(
  sessionManager: Pick<ExtensionContext["sessionManager"], "getLeafEntry" | "getEntry"> | undefined,
  toolCallId: string,
): boolean | undefined {
  if (
    typeof sessionManager?.getLeafEntry !== "function" ||
    typeof sessionManager.getEntry !== "function"
  ) {
    return undefined;
  }
  let entry: unknown = sessionManager.getLeafEntry();
  for (let step = 0; isRecord(entry) && step < TURN_LOOKBACK_LIMIT; step += 1) {
    const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
    if (message?.role === "assistant") {
      const callIds = (Array.isArray(message.content) ? message.content : []).flatMap((part) =>
        isRecord(part) &&
        part.type === "toolCall" &&
        part.name === createChildThreadToolName &&
        typeof part.id === "string"
          ? [part.id]
          : [],
      );
      const index = callIds.indexOf(toolCallId);
      return index === -1 ? undefined : index === 0;
    }
    entry =
      typeof entry.parentId === "string" ? sessionManager.getEntry(entry.parentId) : undefined;
  }
  return undefined;
}

export function createChildThreadModeFromToolOutput(
  output: unknown,
): OrchestrationChildMode | undefined {
  if (!isRecord(output) || !isRecord(output.details)) return undefined;
  if (output.details.action !== createChildThreadAction) return undefined;
  return createChildThreadModeFromParams(output.details);
}

export function createChildThreadPromptFromToolOutput(output: unknown): string | undefined {
  if (!isRecord(output) || !isRecord(output.details)) {
    return undefined;
  }
  if (output.details.action !== createChildThreadAction) {
    return undefined;
  }
  return createChildThreadPromptFromParams(output.details);
}

export function listThreadsRequestedFromToolOutput(output: unknown): boolean {
  return toolOutputDetails(output)?.action === listThreadsAction;
}

/** Trimmed `query` from list_threads params, or undefined when absent/blank. */
export function listThreadsQueryFromParams(
  params: unknown,
): { readonly query: string } | undefined {
  if (!isRecord(params)) return undefined;
  const raw = params.query;
  if (typeof raw !== "string") return undefined;
  const query = raw.trim();
  return query ? { query } : undefined;
}

export function readThreadIdFromToolOutput(output: unknown): string | undefined {
  const details = toolOutputDetails(output);
  if (details?.action !== readThreadAction) {
    return undefined;
  }
  return threadIdFromParams(details);
}

/** Upper bound for a single blocking read_thread wait. */
export const MAX_READ_THREAD_WAIT_SECONDS = 120;

/** Whole clamped wait seconds from read_thread params; undefined means return immediately. */
export function readThreadWaitSecondsFromParams(params: unknown): number | undefined {
  if (!isRecord(params)) return undefined;
  const raw = params.wait_seconds ?? params.waitSeconds;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(Math.floor(raw), MAX_READ_THREAD_WAIT_SECONDS);
}

/** True only when read_thread params explicitly request the full transcript. */
function fullFromParams(params: unknown): boolean | undefined {
  if (!isRecord(params)) return undefined;
  return params.full === true || params.full === "true" ? true : undefined;
}

export function sendMessageToThreadFromToolOutput(
  output: unknown,
): { readonly threadId: string; readonly message: string } | undefined {
  const details = toolOutputDetails(output);
  if (details?.action !== sendMessageToThreadAction) {
    return undefined;
  }
  const threadId = threadIdFromParams(details);
  const message = messageFromParams(details);
  if (!threadId || !message) {
    return undefined;
  }
  // Legacy refresh rows predate the interrupt flag and must never cancel a
  // live run, so the interrupt request is intentionally not replayed here.
  return { threadId, message };
}

/** True only when send_message_to_thread params explicitly request an interrupt. */
function interruptFromParams(params: unknown): boolean | undefined {
  if (!isRecord(params)) return undefined;
  return params.interrupt === true ? true : undefined;
}

function toolOutputDetails(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output) || !isRecord(output.details)) {
    return undefined;
  }
  return output.details;
}

function threadIdFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const threadId =
    stringParam(params, "thread_id") ??
    stringParam(params, "threadId") ??
    stringParam(params, "id");
  return threadId || undefined;
}

function messageFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const message = stringParam(params, "message") ?? stringParam(params, "text");
  return message || undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
