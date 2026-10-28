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
    },
  ) => Promise<AgentToolResult<CreateChildThreadToolDetails>>;
  readonly listThreads: (ctx: ExtensionContext) => Promise<AgentToolResult<ListThreadsToolDetails>>;
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
      "Delegate an independent investigation or implementation task to a separate pi-gui child thread that runs in parallel. Child threads run on the thread's configured sidekick model, falling back to the workspace default. Brief the child like a stranger: give it the objective, context, and verification it needs to finish without asking. Children report back automatically when a run ends. Use mode scout for read-only investigations and worker when file changes or mutating shell are required.",
    promptSnippet:
      "create_child_thread: delegate independent work to a separate pi-gui child thread running in parallel.",
    promptGuidelines: [
      "When a task splits into independent parts (parallel investigations, independent implementations), spawn one child thread per part proactively instead of doing everything serially in this thread.",
      "Reuse a child whose context already covers the work via send_message_to_thread (preserves context/cache); spawn fresh only for parallel or independent slices.",
      "Prefer mode scout for searches, exploration, and reviews; it is read-only but may run read-only, workspace-confined shell commands such as rg, grep, and git log — it cannot edit, write, or run mutating/background shell. Use worker only when the child must change files or run mutating commands.",
      "Brief the child like a stranger: the prompt must stand alone with objective, context, constraints, scope, success criteria, and the verification to run. Use the scope, constraints, success_criteria, and verify fields for those blocks.",
      "Children report back automatically when a run ends; act on the report instead of polling read_thread.",
      "Children end every run with a four-part report: result summary, files changed or inspected, validation commands and outcomes, risks/blockers/questions.",
      "Treat a report with no summary as unverified — a report is a claim, not proof: call read_thread or check the diff/files against the success criteria before trusting it.",
      "Child threads are isolated: they cannot leave the workspace, write dotenv files, run destructive shell commands, or recurse past 3 levels. A scout thread cannot spawn a worker.",
      "Prefer reading a child thread before summarizing its status back to the user.",
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
          description: "Files or areas the child should work in.",
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
      const result = await bridge.createChildThread(ctx, {
        prompt,
        ...(sourcePrompt ? { sourcePrompt } : {}),
        toolCallId,
        mode: createChildThreadModeFromParams(params),
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
    ],
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return bridge.listThreads(ctx);
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
      "Child threads report back automatically when a run ends; act on the report instead of polling read_thread.",
      "Call read_thread only for detail a report omits; it returns only messages you have not seen yet.",
      "Never poll read_thread in a loop while a child runs; wait once with wait_seconds or let the report wake you.",
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
}

/**
 * Always-on closing instruction appended to every child brief so each handoff
 * ends with a structured report. The lead acts on that report and only calls
 * read_thread for detail it omits. The character budget keeps the expensive
 * half of delegation (the child's output) bounded: summarize, don't paste.
 */
export const CHILD_REPORT_SUFFIX =
  "Report back with: 1) the result summary, 2) files changed or inspected, 3) the validation commands you ran and their outcomes, 4) risks, blockers, or open questions. Do not commit or push. Keep the final report under ~1200 characters: summarize rather than pasting files, diffs, or logs.";

/**
 * Compose the single prompt string handed to the child-thread bridge.
 * The base prompt comes first, then each non-blank optional block as a
 * labeled section in fixed order (Scope, Constraints, Success criteria,
 * Verify), separated by blank lines. Blank blocks are omitted. The report
 * suffix is always appended last so even a bare prompt teaches the report contract.
 */
export function composeChildBrief(parts: ChildBriefParts): string {
  const blocks = [parts.prompt.trim()];
  const labeled: ReadonlyArray<readonly [string, string | undefined]> = [
    ["Scope", parts.scope],
    ["Constraints", parts.constraints],
    ["Success criteria", parts.success_criteria],
    ["Verify", parts.verify],
  ];
  for (const [label, value] of labeled) {
    const trimmed = value?.trim();
    if (trimmed) blocks.push(`${label}: ${trimmed}`);
  }
  blocks.push(CHILD_REPORT_SUFFIX);
  return blocks.join("\n\n");
}

/**
 * Feedback for the lead when a brief is missing the blocks a child needs to
 * self-direct. These warnings are never delivered to the child: they are
 * attached to the tool result so the lead writes better briefs next time.
 * A thin brief still spawns; this never rejects.
 */
export const SCOPE_BRIEF_WARNING = "Brief hint: add scope so the child knows where to work.";
export const SUCCESS_CRITERIA_BRIEF_WARNING =
  "Brief hint: add success_criteria so the child can self-check.";

export function briefWarningsFromParams(params: unknown): readonly string[] {
  if (!isRecord(params)) {
    return [];
  }
  const warnings: string[] = [];
  if (!optionalBriefParam(params, "scope")) {
    warnings.push(SCOPE_BRIEF_WARNING);
  }
  if (!optionalBriefParam(params, "success_criteria")) {
    warnings.push(SUCCESS_CRITERIA_BRIEF_WARNING);
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
