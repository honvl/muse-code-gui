import type { TranscriptMessage } from "../../../contracts/timeline-types";

/**
 * Tool calls that count as third-party subagent delegations for first-class
 * follow. The `agent` tool comes from the `pi-cc-subagent` user extension, not
 * pi-gui; pi-gui only ever reads its transcript rows. `use-activity-auto-open`
 * imports this set rather than declaring its own.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["agent"]);

export type SubagentLaneStatus = "running" | "complete" | "failed";

export interface SubagentLane {
  /** Stable lane key: the parent transcript's tool call id. */
  readonly key: string;
  readonly toolCallId: string;
  readonly type: string;
  readonly description: string;
  readonly status: SubagentLaneStatus;
  /** Recent tool-call lines the subagent reported, newest last. */
  readonly activity: readonly string[];
  /** Worktree branch, present only for isolated (`worktree`) runs. */
  readonly branch?: string;
  /** Worktree directory, present only for isolated runs. */
  readonly worktreeDir?: string;
  /** Whether an isolated worktree was kept (false means it was removed). */
  readonly worktreeKept?: boolean;
  /** The subagent's pi session uuid, when the tool reported one. */
  readonly agentId?: string;
  /** Expected pi session name (`agent:<type>: <desc>`, truncated like the tool). */
  readonly sessionName: string;
  /** Final text or error preview from the tool result, when present. */
  readonly detailText?: string;
}

/**
 * Rebuild the session name the subagent tool passes as `pi --name`. Mirrors
 * the extension's `buildSpawnArgs` exactly: `agent:<type>: <desc>`, cut to 80
 * chars. The lookup only ever matches on this string (plus agentId), never on
 * model output, so the truncation must stay in sync with the extension.
 */
export function subagentSessionName(type: string, description: string): string {
  return `agent:${type}: ${description}`.slice(0, 80);
}

const SUBAGENT_SESSION_NAME_PATTERN = /^agent:[A-Za-z0-9_-]+: /;

/**
 * Whether a session title is a third-party subagent session name
 * (`agent:<type>: <desc>`, set by the extension's `pi --name`). The sidebar
 * hides these: their entry point is the parent lane, not a top-level row.
 */
export function isSubagentSessionName(name: string | undefined): boolean {
  return typeof name === "string" && SUBAGENT_SESSION_NAME_PATTERN.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function laneStatus(
  rowStatus: string,
  detailsStatus: unknown,
): SubagentLaneStatus {
  if (rowStatus === "running") {
    return "running";
  }
  if (detailsStatus === "done") {
    return "complete";
  }
  if (detailsStatus === "error" || detailsStatus === "cancelled") {
    return "failed";
  }
  return rowStatus === "success" ? "complete" : "failed";
}

/**
 * Derive one read-only lane per third-party `agent` tool call in a parent
 * transcript. Pure over the transcript snapshot: no persistence, no session
 * catalog reads. A lane is shown even when the subagent's session file cannot
 * be located — the tool-row status is always available.
 */
export function subagentLanesFromTranscript(
  transcript: readonly TranscriptMessage[] | undefined,
): readonly SubagentLane[] {
  if (!transcript) {
    return [];
  }
  const lanes = new Map<string, SubagentLane>();
  for (const item of transcript) {
    if (!isRecord(item) || item["kind"] !== "tool") {
      continue;
    }
    const toolName = item["toolName"];
    const callId = item["callId"];
    if (typeof toolName !== "string" || typeof callId !== "string") {
      continue;
    }
    if (!SUBAGENT_TOOL_NAMES.has(toolName)) {
      continue;
    }
    const input = isRecord(item["input"]) ? item["input"] : undefined;
    const type =
      (input && typeof input["subagent_type"] === "string" && input["subagent_type"]) ||
      "general-purpose";
    const description =
      (input && typeof input["description"] === "string" && input["description"]) ||
      "Subagent run";
    const rowStatus = typeof item["status"] === "string" ? item["status"] : "";
    const output = isRecord(item["output"]) ? item["output"] : undefined;
    const details = output && isRecord(output["details"]) ? output["details"] : undefined;
    const status = laneStatus(rowStatus, details?.["status"]);
    const worktree = details && isRecord(details["worktree"]) ? details["worktree"] : undefined;
    const branch = worktree && typeof worktree["branch"] === "string" ? worktree["branch"] : undefined;
    const worktreeDir = worktree && typeof worktree["dir"] === "string" ? worktree["dir"] : undefined;
    const agentId = details && typeof details["agentId"] === "string" ? details["agentId"] : undefined;
    const finalText = details && typeof details["finalText"] === "string" ? details["finalText"] : "";
    const errorText = details && typeof details["error"] === "string" ? details["error"] : "";
    const preview = (errorText || finalText).slice(0, 500);
    lanes.set(callId, {
      key: callId,
      toolCallId: callId,
      type: details && typeof details["type"] === "string" && details["type"] ? details["type"] : type,
      description:
        details && typeof details["description"] === "string" && details["description"]
          ? details["description"]
          : description,
      status,
      activity: details ? asStringArray(details["activity"]) : [],
      ...(branch ? { branch } : {}),
      ...(worktreeDir ? { worktreeDir } : {}),
      ...(worktree && typeof worktree["kept"] === "boolean" ? { worktreeKept: worktree["kept"] } : {}),
      ...(agentId ? { agentId } : {}),
      sessionName: subagentSessionName(type, description),
      ...(status !== "running" && preview ? { detailText: preview } : {}),
    });
  }
  return [...lanes.values()];
}
