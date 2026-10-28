import type { TranscriptMessage } from "../../../contracts/timeline-types";

/** Tool calls that count as subagent delegations for first-class follow. */
const SUBAGENT_TOOL_NAMES = new Set(["agent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Running delegation call ids in a transcript. Pure so the edge trigger is
 * unit-testable without Electron: only `agent`-tool calls with a running
 * status count, never pins, messages, or settled calls.
 */
export function runningAgentCallIds(
  transcript: readonly TranscriptMessage[] | undefined,
): readonly string[] {
  if (!transcript) {
    return [];
  }
  const ids: string[] = [];
  for (const item of transcript) {
    if (!isRecord(item)) {
      continue;
    }
    if (item["kind"] !== "tool" || item["status"] !== "running") {
      continue;
    }
    const toolName = item["toolName"];
    const callId = item["callId"];
    if (typeof toolName !== "string" || typeof callId !== "string") {
      continue;
    }
    if (SUBAGENT_TOOL_NAMES.has(toolName)) {
      ids.push(callId);
    }
  }
  return ids;
}
