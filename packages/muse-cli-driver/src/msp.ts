/**
 * Minimal shapes for the `muse exec --json` MSP JSONL records (schema_version 1)
 * that the driver maps onto SessionDriver events. Only the fields the mapping
 * reads are declared; unknown records pass through untouched.
 */

export interface MspStreamRef {
  readonly kind: string;
  readonly id: string;
}

export interface MspRunRef {
  readonly kind: string;
  readonly id: string;
}

/** A task-lifecycle event inside a `task_lifecycle` payload. */
export interface MspTaskEvent {
  readonly kind: string;
  readonly task_id: string;
  /** Present on `proposed`: what the task does (e.g. `reminder.agent.skill-reminder`). */
  readonly task_kind?: string;
  /** Present on `side_effect_intent`: the operation (e.g. `reminder.child_run`). */
  readonly operation?: string;
  readonly reason?: string;
  readonly message?: string;
}

export interface MspPayload {
  readonly kind: string;
  readonly command_id?: string;
  readonly run_stream?: MspRunRef;
  /** `run_output_delta`: streamed assistant text. */
  readonly text?: string;
  /** `run_terminal`: `completed` | `failed` | `cancelled`. */
  readonly terminal?: string;
  readonly reason?: string | null;
  /** `task_lifecycle` records. */
  readonly task_stream?: MspStreamRef;
  readonly task_id?: string;
  readonly event?: MspTaskEvent;
  /** `run_usage` records. */
  readonly models?: readonly MspModelUsage[];
  readonly calls?: number;
  readonly completed_calls?: number;
  readonly failed_calls?: number;
  readonly cancelled_calls?: number;
  readonly allowance?: MspAllowance | null;
  /** `turn.input.user`: the submitted prompt. */
  readonly prompt?: string;
}

export interface MspModelUsage {
  readonly model: string | null;
  readonly input_tokens: number;
  readonly cached_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly calls: number;
}

export interface MspAllowanceWindow {
  readonly used_percent: number;
  readonly resets_at_ms: number | null;
}

export interface MspAllowance {
  readonly tier: string | null;
  readonly window: MspAllowanceWindow | null;
  readonly weekly: MspAllowanceWindow | null;
  readonly as_of_ms: number | null;
  readonly source?: string;
}

export interface MspRecord {
  readonly schema_version: number;
  readonly id: string;
  readonly stream: MspStreamRef;
  readonly sequence: number;
  readonly recorded_at: number;
  readonly record_type: string;
  readonly durability: string;
  readonly causation_id: string | null;
  readonly payload_type: string;
  readonly payload_schema_version: number;
  readonly payload: MspPayload;
}

/** Parse one JSONL line; returns undefined for blank or unparseable lines. */
export function parseMspLine(line: string): MspRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const record = parsed as Partial<MspRecord>;
    if (record.schema_version !== 1 || typeof record.payload_type !== "string") {
      return undefined;
    }
    return record as MspRecord;
  } catch {
    return undefined;
  }
}
