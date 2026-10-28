import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const listThreadsToolName = "list_threads";
export const readThreadToolName = "read_thread";
export const messageThreadToolName = "message_thread";

export const listThreadsAction = "pi_gui_list_threads";
export const readThreadAction = "pi_gui_read_thread";
export const messageThreadAction = "pi_gui_message_thread";

/** Cap so one read cannot flood the reading thread's context. */
const READ_THREAD_MAX_CHARS = 12_000;
const READ_THREAD_MAX_ITEMS = 40;
/** Cap an incoming cross-session message so a runaway sender cannot blow up context. */
const MESSAGE_THREAD_MAX_CHARS = 8_000;
const LIST_THREADS_MAX = 50;

export interface CrossSessionThreadSummary {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly preview?: string;
}

export interface CrossSessionTranscript {
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly excerpt: string;
  readonly truncated: boolean;
}

export interface CrossSessionDelivery {
  readonly targetSessionId: string;
  readonly targetTitle: string;
  /** "turn" started (or will start) work now; "queued" waits behind the running turn. */
  readonly mode: "turn" | "queued";
}

export interface CrossSessionSource {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface CrossSessionBridge {
  listThreads(): Promise<readonly CrossSessionThreadSummary[]>;
  readThread(sessionId: string): Promise<CrossSessionTranscript>;
  deliverMessage(
    source: CrossSessionSource,
    targetSessionId: string,
    text: string,
  ): Promise<CrossSessionDelivery>;
}

export interface ListThreadsToolDetails {
  readonly action: typeof listThreadsAction;
  readonly count?: number;
  readonly error?: string;
}

export interface ReadThreadToolDetails {
  readonly action: typeof readThreadAction;
  readonly sessionId: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

export interface MessageThreadToolDetails {
  readonly action: typeof messageThreadAction;
  readonly sessionId: string;
  readonly mode?: CrossSessionDelivery["mode"];
  readonly error?: string;
}

type CrossSessionToolDetails =
  ListThreadsToolDetails | ReadThreadToolDetails | MessageThreadToolDetails;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringParam(params: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(params)) return undefined;
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function errorResult(message: string, details: CrossSessionToolDetails) {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
  };
}

function createListThreadsTool(
  bridge: CrossSessionBridge,
): ToolDefinition<any, CrossSessionToolDetails> {
  return {
    name: listThreadsToolName,
    label: "List threads",
    description:
      "List this workspace's open threads (id, title, status, last update) so you can " +
      "find what another session concluded or pick a thread to message.",
    promptSnippet: "list_threads: list open threads with ids, titles, and status.",
    promptGuidelines: [
      "Use list_threads before read_thread or message_thread to resolve the thread id.",
      "Archived threads are omitted; only open threads can be read or messaged.",
    ],
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const threads = (await bridge.listThreads()).slice(0, LIST_THREADS_MAX);
        if (threads.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No open threads." }],
            details: { action: listThreadsAction, count: 0 },
          };
        }
        const lines = threads.map(
          (thread) =>
            `- ${thread.sessionId} [${thread.status}] "${thread.title}"` +
            (thread.workspaceName ? ` in ${thread.workspaceName}` : "") +
            ` (updated ${thread.updatedAt})` +
            (thread.preview ? `\n  ${thread.preview}` : ""),
        );
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { action: listThreadsAction, count: threads.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { action: listThreadsAction, error: message });
      }
    },
  };
}

function createReadThreadTool(
  bridge: CrossSessionBridge,
): ToolDefinition<any, CrossSessionToolDetails> {
  return {
    name: readThreadToolName,
    label: "Read thread",
    description:
      "Read a recent excerpt of another open thread's transcript by thread id. " +
      "Use it to see what that session concluded before messaging it.",
    promptSnippet: "read_thread: read another thread's recent transcript by thread id.",
    promptGuidelines: ["Use a session id from list_threads."],
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Thread (session) id." },
        sessionId: { type: "string", description: "Alias for session_id." },
      },
      required: ["session_id"],
    },
    async execute(_toolCallId, params) {
      const sessionId = stringParam(params, "session_id", "sessionId");
      if (!sessionId) {
        const message = "read_thread requires session_id.";
        return errorResult(message, { action: readThreadAction, sessionId: "", error: message });
      }
      try {
        const transcript = await bridge.readThread(sessionId);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Thread ${sessionId} "${transcript.title}" [${transcript.status}]` +
                (transcript.truncated ? " (excerpt, truncated):" : ":"),
            },
            { type: "text" as const, text: transcript.excerpt },
          ],
          details: {
            action: readThreadAction,
            sessionId,
            truncated: transcript.truncated,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { action: readThreadAction, sessionId, error: message });
      }
    },
  };
}

function createMessageThreadTool(
  bridge: CrossSessionBridge,
  resolveSource: (ctx: ExtensionContext) => CrossSessionSource,
): ToolDefinition<any, CrossSessionToolDetails> {
  return {
    name: messageThreadToolName,
    label: "Message thread",
    description:
      "Send a message to another open thread by thread id. The message arrives as a " +
      "user message prefixed with this thread's title; if the target is mid-run it is " +
      "held as a queued follow-up and read when the run settles. The reply comes back " +
      "through that thread, not this one.",
    promptSnippet: "message_thread: send a user message to another open thread.",
    promptGuidelines: [
      "Use a session id from list_threads; read it first when you need its context.",
      "Keep the message self-contained: the other thread only sees your text, prefixed " +
        "with this thread's title.",
      "A message to a running thread waits until its run settles; it never interrupts it.",
    ],
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Target thread (session) id." },
        sessionId: { type: "string", description: "Alias for session_id." },
        text: { type: "string", description: "Message for the other thread." },
      },
      required: ["session_id", "text"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = stringParam(params, "session_id", "sessionId");
      const text = stringParam(params, "text");
      if (!sessionId) {
        const message = "message_thread requires session_id.";
        return errorResult(message, { action: messageThreadAction, sessionId: "", error: message });
      }
      if (!text) {
        const message = "message_thread requires non-empty text.";
        return errorResult(message, { action: messageThreadAction, sessionId, error: message });
      }
      if (text.length > MESSAGE_THREAD_MAX_CHARS) {
        const message = `message_thread text is ${text.length} chars; keep it under ${MESSAGE_THREAD_MAX_CHARS}.`;
        return errorResult(message, { action: messageThreadAction, sessionId, error: message });
      }
      try {
        const delivery = await bridge.deliverMessage(resolveSource(ctx), sessionId, text);
        const held =
          delivery.mode === "queued"
            ? " It is mid-run, so the message is held and will be read when the run settles."
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Delivered to thread ${delivery.targetSessionId} "${delivery.targetTitle}".${held}`,
            },
          ],
          details: {
            action: messageThreadAction,
            sessionId: delivery.targetSessionId,
            mode: delivery.mode,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { action: messageThreadAction, sessionId, error: message });
      }
    },
  };
}

export function createCrossSessionRuntimeTools(
  bridge: CrossSessionBridge,
  resolveSource: (ctx: ExtensionContext) => CrossSessionSource = (ctx) => ({
    workspaceId: "",
    sessionId: ctx.sessionManager.getSessionId(),
  }),
  omittedToolNames: readonly string[] = [],
): readonly ToolDefinition<any, CrossSessionToolDetails>[] {
  const omitted = new Set(omittedToolNames);
  return [
    createListThreadsTool(bridge),
    createReadThreadTool(bridge),
    createMessageThreadTool(bridge, resolveSource),
  ].filter((tool) => !omitted.has(tool.name));
}

export function createCrossSessionRuntimeExtension(
  bridge: CrossSessionBridge,
  resolveSource?: (ctx: ExtensionContext) => CrossSessionSource,
  omittedToolNames?: readonly string[] | (() => readonly string[]),
): ExtensionFactory {
  const tools = createCrossSessionRuntimeTools(
    bridge,
    ...(resolveSource ? [resolveSource] : ([] as const)),
  );
  return (pi: ExtensionAPI) => {
    const omitted = new Set(
      typeof omittedToolNames === "function" ? omittedToolNames() : (omittedToolNames ?? []),
    );
    for (const tool of tools) {
      if (!omitted.has(tool.name)) {
        pi.registerTool(tool);
      }
    }
  };
}

export function formatTranscriptExcerpt(
  messages: readonly { role: string; text: string; toolName?: string }[],
): { excerpt: string; truncated: boolean } {
  const lines: string[] = [];
  let chars = 0;
  const start = Math.max(0, messages.length - READ_THREAD_MAX_ITEMS);
  for (let index = start; index < messages.length; index++) {
    const message = messages[index]!;
    const line =
      message.toolName !== undefined
        ? `[tool ${message.toolName}]`
        : `${message.role}: ${message.text}`;
    chars += line.length + 1;
    if (chars > READ_THREAD_MAX_CHARS) {
      return { excerpt: [...lines, "…(truncated)"].join("\n"), truncated: true };
    }
    lines.push(line);
  }
  return { excerpt: lines.join("\n"), truncated: start > 0 };
}
