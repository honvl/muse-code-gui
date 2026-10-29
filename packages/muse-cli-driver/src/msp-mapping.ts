import type { SessionUsageSnapshot } from "@pi-gui/session-driver";
import type { MspAllowance, MspRecord } from "./msp.js";

/**
 * Pure mapping from `muse exec --json` MSP records (schema_version 1) onto the
 * pieces a SessionDriver turn needs: assistant text, tool rows, usage and the
 * terminal outcome.
 *
 * Only `task_lifecycle` records that represent tool calls become tool rows. A
 * task represents a tool call when its `task_kind` (on `proposed`) or its
 * `side_effect_intent` operation names a `tool.*` (or `tool:*`) operation.
 * The recorded fixtures show the other shapes: `reminder.*` child runs and
 * `model.*` model steps, which are internal to the run and intentionally
 * produce no tool rows (model text arrives via `run_output_delta`).
 */

export interface MappedToolEvent {
  readonly type: "toolStarted" | "toolFinished";
  readonly toolName: string;
  /** The MSP task id; stable for the call's whole lifecycle. */
  readonly callId: string;
  readonly success?: boolean;
  /** True when the call never reached a terminal record and was closed by the run ending. */
  readonly interrupted?: boolean;
}

export interface MappedUsage {
  readonly model: string | null;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly calls: number;
  readonly allowance: MspAllowance | null;
}

export type MappedTerminalStatus = "completed" | "failed" | "cancelled";

export interface MappedTerminal {
  readonly status: MappedTerminalStatus;
  readonly text: string;
  readonly reason: string | null;
}

function toolNameFrom(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "tool") {
    return "tool";
  }
  for (const prefix of ["tool.", "tool:"]) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return undefined;
}

/**
 * Incrementally folds one turn's MSP records. Feed records in stream order;
 * read the accumulated state at the end (or mid-stream for live deltas).
 */
export class MspTurnCollector {
  private assistantChunks: string[] = [];
  private readonly toolEvents: MappedToolEvent[] = [];
  private readonly taskToolNames = new Map<string, string>();
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();
  private usage: MappedUsage = {
    model: null,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    allowance: null,
  };
  private terminal: MappedTerminal | undefined;
  private prompt: string | undefined;
  private runId: string | undefined;
  private commandId: string | undefined;
  /** Assistant text length already handed out via `drainDelta`. */
  private drainedLength = 0;

  ingest(record: MspRecord): void {
    const payload = record.payload;
    switch (payload.kind) {
      case "turn_input_user":
        this.prompt ??= payload.prompt;
        this.commandId ??= payload.command_id;
        if (payload.run_stream) {
          this.runId ??= payload.run_stream.id;
        }
        return;
      case "run_started":
        this.commandId ??= payload.command_id;
        if (payload.run_stream) {
          this.runId ??= payload.run_stream.id;
        }
        this.prompt ??= payload.prompt;
        return;
      case "run_output_delta":
        if (typeof payload.text === "string") {
          this.assistantChunks.push(payload.text);
        }
        return;
      case "task_lifecycle":
        this.ingestTaskLifecycle(record);
        return;
      case "run_usage":
        this.ingestUsage(payload.models ?? [], payload.allowance ?? null);
        return;
      case "run_terminal":
        this.terminal = {
          status: terminalStatusOf(payload.terminal),
          text: payload.text ?? "",
          reason: payload.reason ?? null,
        };
        this.drainOpenTools();
        return;
      default:
        return;
    }
  }

  private ingestTaskLifecycle(record: MspRecord): void {
    const event = record.payload.event;
    if (!event || event.task_id === undefined) {
      return;
    }
    const declared = toolNameFrom(event.task_kind) ?? toolNameFrom(event.operation);
    if (declared !== undefined) {
      this.taskToolNames.set(event.task_id, declared);
    }
    const toolName = this.taskToolNames.get(event.task_id);
    if (toolName === undefined) {
      return;
    }
    switch (event.kind) {
      case "side_effect_intent":
      case "started":
        if (!this.startedTools.has(event.task_id)) {
          this.startedTools.add(event.task_id);
          this.toolEvents.push({ type: "toolStarted", toolName, callId: event.task_id });
        }
        return;
      case "completed":
        this.finishTool(event.task_id, toolName, true);
        return;
      case "failed":
      case "cancelled":
        this.finishTool(event.task_id, toolName, false);
        return;
      default:
        return;
    }
  }

  private finishTool(taskId: string, toolName: string, success: boolean): void {
    if (this.finishedTools.has(taskId)) {
      return;
    }
    this.finishedTools.add(taskId);
    this.toolEvents.push({ type: "toolFinished", toolName, callId: taskId, success });
  }

  /**
   * Close every started-but-unfinished tool with an interrupted finish. Runs
   * end (completed, failed or cancelled) while a live-process call is still
   * open, and kills never deliver its terminal record; without this the UI
   * would show the call running forever. Idempotent: already-finished calls
   * are skipped, so a late terminal record cannot double-close.
   */
  drainOpenTools(): MappedToolEvent[] {
    const closed: MappedToolEvent[] = [];
    for (const taskId of this.startedTools) {
      if (this.finishedTools.has(taskId)) {
        continue;
      }
      this.finishedTools.add(taskId);
      const finished: MappedToolEvent = {
        type: "toolFinished",
        toolName: this.taskToolNames.get(taskId) ?? "tool",
        callId: taskId,
        success: false,
        interrupted: true,
      };
      this.toolEvents.push(finished);
      closed.push(finished);
    }
    return closed;
  }

  private ingestUsage(
    models: readonly {
      model: string | null;
      input_tokens: number;
      cached_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      calls: number;
    }[],
    allowance: MspAllowance | null,
  ): void {
    for (const model of models) {
      this.usage = {
        model: model.model ?? this.usage.model,
        inputTokens: this.usage.inputTokens + (model.input_tokens ?? 0),
        cachedTokens: this.usage.cachedTokens + (model.cached_tokens ?? 0),
        outputTokens: this.usage.outputTokens + (model.output_tokens ?? 0),
        reasoningTokens: this.usage.reasoningTokens + (model.reasoning_tokens ?? 0),
        calls: this.usage.calls + (model.calls ?? 0),
        allowance: allowance ?? this.usage.allowance,
      };
    }
    if (models.length === 0 && allowance !== null) {
      this.usage = { ...this.usage, allowance };
    }
  }

  /** All assistant text seen so far. */
  get assistantText(): string {
    return this.assistantChunks.join("");
  }

  /** Text since the last `drainDelta` call; used for live `assistantDelta` events. */
  drainDelta(): string {
    const full = this.assistantText;
    const delta = full.slice(this.drainedLength);
    this.drainedLength = full.length;
    return delta;
  }

  get pendingToolEvents(): readonly MappedToolEvent[] {
    return this.toolEvents;
  }

  get mappedUsage(): MappedUsage {
    return this.usage;
  }

  get mappedTerminal(): MappedTerminal | undefined {
    return this.terminal;
  }

  get mappedPrompt(): string | undefined {
    return this.prompt;
  }

  get mappedRunId(): string | undefined {
    return this.runId;
  }

  get mappedCommandId(): string | undefined {
    return this.commandId;
  }
}

function terminalStatusOf(value: string | undefined): MappedTerminalStatus {
  if (value === "failed" || value === "cancelled") {
    return value;
  }
  return "completed";
}

/** Fold a usage record into session totals. Echo runs report zeros and no allowance. */
export function toSessionUsageSnapshot(usage: MappedUsage): SessionUsageSnapshot {
  const window = usage.allowance?.window ?? null;
  const weekly = usage.allowance?.weekly ?? null;
  return {
    cache: {},
    totals: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cachedTokens,
      cacheWrite: 0,
      cost: 0,
    },
    lastTurn: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cachedTokens,
      cacheWrite: 0,
    },
    subscription: usage.allowance !== null,
    ...(usage.allowance
      ? {
          quota: {
            tier: usage.allowance.tier,
            window: window
              ? { usedPercent: window.used_percent, resetsAtMs: window.resets_at_ms }
              : null,
            weekly: weekly
              ? { usedPercent: weekly.used_percent, resetsAtMs: weekly.resets_at_ms }
              : null,
            fetchedAt: usage.allowance.as_of_ms,
            error: null,
          },
        }
      : {}),
  };
}

export interface ExportToolRow {
  readonly callId: string;
  readonly toolName: string;
  readonly success: boolean;
}

export interface ExportTurn {
  readonly runId: string;
  readonly prompt: string;
  readonly text: string;
  readonly usage: MappedUsage;
  readonly terminal: MappedTerminal | undefined;
  readonly tools: readonly ExportToolRow[];
}

/**
 * Rebuild per-turn history from a `muse export --session` document. The
 * durable log uses a different record vocabulary than the live `exec --json`
 * stream: `runtime.session` run records carry the prompt (`started`), the
 * reply (`assistant_message_committed`, possibly several), token usage
 * (`model_completed`) and the outcome (`terminal`), grouped by `run_id`.
 * Task records reuse the live `task_kind`/`operation` vocabulary, so the
 * same `tool.*` discriminator applies to tool rows.
 */
export function collectExportTurns(document: {
  readonly events?: readonly { readonly envelope?: unknown }[];
}): ExportTurn[] {
  interface Builder {
    prompt: string;
    texts: string[];
    usage: MappedUsage;
    terminal: MappedTerminal | undefined;
    toolNames: Map<string, string>;
    tools: ExportToolRow[];
  }
  const byRun = new Map<string, Builder>();
  const order: string[] = [];
  const builderFor = (runId: string): Builder => {
    let builder = byRun.get(runId);
    if (!builder) {
      builder = {
        prompt: "",
        texts: [],
        usage: {
          model: null,
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          calls: 0,
          allowance: null,
        },
        terminal: undefined,
        toolNames: new Map(),
        tools: [],
      };
      byRun.set(runId, builder);
      order.push(runId);
    }
    return builder;
  };

  for (const event of document.events ?? []) {
    const envelope = event.envelope as
      { readonly schema_version?: unknown; readonly payload?: unknown } | undefined;
    if (!envelope || envelope.schema_version !== 1 || typeof envelope.payload !== "object") {
      continue;
    }
    const payload = envelope.payload as {
      readonly kind?: unknown;
      readonly run_id?: unknown;
      readonly event?: unknown;
    };
    if (payload.kind === "run" && typeof payload.run_id === "string") {
      const builder = builderFor(payload.run_id);
      const runEvent = payload.event as
        | {
            readonly kind?: unknown;
            readonly prompt?: unknown;
            readonly text?: unknown;
            readonly terminal?: unknown;
            readonly reason?: unknown;
            readonly usage?: unknown;
          }
        | undefined;
      if (!runEvent || typeof runEvent.kind !== "string") {
        continue;
      }
      switch (runEvent.kind) {
        case "started":
          if (!builder.prompt && typeof runEvent.prompt === "string") {
            builder.prompt = runEvent.prompt;
          }
          break;
        case "assistant_message_committed":
          if (typeof runEvent.text === "string" && runEvent.text) {
            builder.texts.push(runEvent.text);
          }
          break;
        case "model_completed": {
          const usage = runEvent.usage as
            | {
                readonly input_tokens?: unknown;
                readonly cached_tokens?: unknown;
                readonly output_tokens?: unknown;
                readonly reasoning_tokens?: unknown;
              }
            | undefined;
          builder.usage = {
            ...builder.usage,
            inputTokens: builder.usage.inputTokens + numberOf(usage?.input_tokens),
            cachedTokens: builder.usage.cachedTokens + numberOf(usage?.cached_tokens),
            outputTokens: builder.usage.outputTokens + numberOf(usage?.output_tokens),
            reasoningTokens: builder.usage.reasoningTokens + numberOf(usage?.reasoning_tokens),
            calls: builder.usage.calls + 1,
          };
          break;
        }
        case "terminal":
          builder.terminal = {
            status: terminalStatusOf(
              typeof runEvent.terminal === "string" ? runEvent.terminal : undefined,
            ),
            text: builder.texts.join(""),
            reason: typeof runEvent.reason === "string" ? runEvent.reason : null,
          };
          break;
        default:
          break;
      }
      continue;
    }
    if (payload.kind === "task") {
      const taskEvent = payload.event as
        | {
            readonly kind?: unknown;
            readonly task_id?: unknown;
            readonly task_kind?: unknown;
            readonly operation?: unknown;
          }
        | undefined;
      if (!taskEvent || typeof taskEvent.task_id !== "string") {
        continue;
      }
      // Task records carry no run id; attribute them to the latest open run.
      const current = order.length > 0 ? byRun.get(order[order.length - 1] as string) : undefined;
      if (!current) {
        continue;
      }
      const declared =
        toolNameFrom(typeof taskEvent.task_kind === "string" ? taskEvent.task_kind : undefined) ??
        toolNameFrom(typeof taskEvent.operation === "string" ? taskEvent.operation : undefined);
      if (declared !== undefined) {
        current.toolNames.set(taskEvent.task_id, declared);
      }
      const toolName = current.toolNames.get(taskEvent.task_id);
      if (toolName === undefined) {
        continue;
      }
      if (
        taskEvent.kind === "completed" ||
        taskEvent.kind === "failed" ||
        taskEvent.kind === "cancelled"
      ) {
        current.tools.push({
          callId: taskEvent.task_id,
          toolName,
          success: taskEvent.kind === "completed",
        });
      }
    }
  }
  return order.map((runId) => {
    const builder = byRun.get(runId);
    const usage = builder?.usage ?? {
      model: null,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      calls: 0,
      allowance: null,
    };
    return {
      runId,
      prompt: builder?.prompt ?? "",
      text: builder?.terminal?.text ?? builder?.texts.join("") ?? "",
      usage,
      terminal: builder?.terminal,
      tools: builder?.tools ?? [],
    };
  });
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
