import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BackgroundTaskStore, type BackgroundTaskStatus } from "./background-tasks.js";

export const bashBackgroundToolName = "bash_background";
export const backgroundOutputToolName = "background_output";
export const backgroundStopToolName = "background_stop";

export const bashBackgroundAction = "pi_gui_bash_background";
export const backgroundOutputAction = "pi_gui_background_output";
export const backgroundStopAction = "pi_gui_background_stop";

export interface BashBackgroundToolDetails {
  readonly action: typeof bashBackgroundAction;
  readonly taskId?: string;
  readonly command?: string;
  readonly status?: BackgroundTaskStatus;
  readonly error?: string;
}

export interface BackgroundOutputToolDetails {
  readonly action: typeof backgroundOutputAction;
  readonly taskId: string;
  readonly status?: BackgroundTaskStatus;
  readonly exitCode?: number;
  readonly outputOffset?: number;
  readonly outputBytes?: number;
  readonly truncated?: boolean;
  readonly error?: string;
}

export interface BackgroundStopToolDetails {
  readonly action: typeof backgroundStopAction;
  readonly taskId: string;
  readonly status?: BackgroundTaskStatus;
  readonly error?: string;
}

type BackgroundToolDetails =
  | BashBackgroundToolDetails
  | BackgroundOutputToolDetails
  | BackgroundStopToolDetails;

export interface BackgroundTaskContext {
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

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

function numberParam(params: unknown, ...keys: string[]): number | undefined {
  if (!isRecord(params)) return undefined;
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function errorResult(message: string, details: BackgroundToolDetails) {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
  };
}

function createBashBackgroundTool(
  store: BackgroundTaskStore,
  resolveContext: (ctx: ExtensionContext) => BackgroundTaskContext,
): ToolDefinition<any, BackgroundToolDetails> {
  return {
    name: bashBackgroundToolName,
    label: "Run bash in background",
    description:
      "Start a shell command as a background task and return immediately with a task id. " +
      "The command keeps running while the conversation continues, so the session stays free for " +
      "steered turns. Poll with background_output, stop with background_stop.",
    promptSnippet:
      "bash_background: run a shell command in the background; returns a task id right away.",
    promptGuidelines: [
      "For commands that may run longer than ~30 seconds (builds, remuxes, test suites, watchers), " +
        "prefer bash_background over bash so the thread stays responsive.",
      "bash_background returns immediately. Use background_output with the task id to read output, " +
        "and background_stop to cancel. Never poll in a tight loop; do other work between polls.",
      "Tell the user the task id and that they can steer or stop it while it runs.",
    ],
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute in the background.",
        },
      },
      required: ["command"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const command = stringParam(params, "command");
      if (!command) {
        const message = "bash_background requires a non-empty command.";
        return errorResult(message, { action: bashBackgroundAction, error: message });
      }
      // The agent run's abort signal must NOT kill the task: background work
      // intentionally outlives the turn that started it. Stopping is explicit.
      try {
        const context = resolveContext(ctx);
        const taskId = store.start(command, {
          cwd: ctx.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
          ...(context.sessionId ?? ctx.sessionManager.getSessionId()
            ? { sessionId: context.sessionId ?? ctx.sessionManager.getSessionId() }
            : {}),
        });
        const snapshot = store.get(taskId);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Started background bash task ${taskId} (status: ${snapshot?.status ?? "running"}). ` +
                `The session is free: continue other work and read output with background_output ` +
                `{"task_id": "${taskId}"}, or stop it with background_stop.`,
            },
          ],
          details: {
            action: bashBackgroundAction,
            taskId,
            command,
            status: snapshot?.status ?? "running",
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { action: bashBackgroundAction, command, error: message });
      }
    },
  };
}

function createBackgroundOutputTool(
  store: BackgroundTaskStore,
): ToolDefinition<any, BackgroundToolDetails> {
  return {
    name: backgroundOutputToolName,
    label: "Read background output",
    description:
      "Read combined stdout/stderr output of a background bash task started by bash_background. " +
      "Returns the task status (running, completed, failed, stopped) with an output window.",
    promptSnippet: "background_output: read a background task's output by task id.",
    promptGuidelines: [
      "Use a task_id returned by bash_background.",
      "Pass offset from a previous read to fetch only new output.",
    ],
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Background task id." },
        taskId: { type: "string", description: "Alias for task_id." },
        offset: {
          type: "number",
          description: "Byte offset into the full log. Omit to read the tail.",
        },
        limit: {
          type: "number",
          description: "Max bytes to return. Defaults to 32768, capped at 262144.",
        },
      },
      required: ["task_id"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = stringParam(params, "task_id", "taskId");
      if (!taskId) {
        const message = "background_output requires task_id.";
        return errorResult(message, {
          action: backgroundOutputAction,
          taskId: "",
          error: message,
        });
      }
      try {
        const output = await store.read(taskId, {
          ...(numberParam(params, "offset") !== undefined
            ? { offset: numberParam(params, "offset")! }
            : {}),
          ...(numberParam(params, "limit") !== undefined
            ? { limit: numberParam(params, "limit")! }
            : {}),
        });
        const summary =
          `Task ${taskId} status: ${output.status}` +
          (output.exitCode !== undefined ? ` (exit ${output.exitCode})` : "") +
          `, ${output.outputBytes} bytes total${output.truncated ? ", truncated to window" : ""}.`;
        return {
          content: [
            { type: "text" as const, text: summary },
            { type: "text" as const, text: output.output.length > 0 ? output.output : "(no output yet)" },
          ],
          details: {
            action: backgroundOutputAction,
            taskId,
            status: output.status,
            ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
            outputOffset: output.outputOffset,
            outputBytes: output.outputBytes,
            truncated: output.truncated,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { action: backgroundOutputAction, taskId, error: message });
      }
    },
  };
}

function createBackgroundStopTool(
  store: BackgroundTaskStore,
): ToolDefinition<any, BackgroundToolDetails> {
  return {
    name: backgroundStopToolName,
    label: "Stop background task",
    description: "Stop a running background bash task started by bash_background.",
    promptSnippet: "background_stop: stop a running background task by task id.",
    promptGuidelines: ["Use a task_id returned by bash_background."],
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Background task id." },
        taskId: { type: "string", description: "Alias for task_id." },
      },
      required: ["task_id"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = stringParam(params, "task_id", "taskId");
      if (!taskId) {
        const message = "background_stop requires task_id.";
        return errorResult(message, {
          action: backgroundStopAction,
          taskId: "",
          error: message,
        });
      }
      try {
        const snapshot = store.stop(taskId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${taskId} status: ${snapshot.status}.`,
            },
          ],
          details: { action: backgroundStopAction, taskId, status: snapshot.status },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { action: backgroundStopAction, taskId, error: message });
      }
    },
  };
}

export function createBackgroundTaskRuntimeTools(
  store: BackgroundTaskStore,
  resolveContext: (ctx: ExtensionContext) => BackgroundTaskContext = () => ({}),
): readonly ToolDefinition<any, BackgroundToolDetails>[] {
  return [
    createBashBackgroundTool(store, resolveContext),
    createBackgroundOutputTool(store),
    createBackgroundStopTool(store),
  ];
}

export function createBackgroundTaskRuntimeExtension(
  store: BackgroundTaskStore,
  resolveContext: (ctx: ExtensionContext) => BackgroundTaskContext = () => ({}),
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createBackgroundTaskRuntimeTools(store, resolveContext)) {
      pi.registerTool(tool);
    }
  };
}
