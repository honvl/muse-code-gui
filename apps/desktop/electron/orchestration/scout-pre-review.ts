/**
 * Scout pre-review (plan item 7b): pure decision and composition logic.
 *
 * When a Lead's worker finishes a run that edited more than one file, the
 * host starts a read-only scout to review that diff against the worker's
 * brief and hands the lead one combined report. Child tokens are near-free;
 * lead tokens are not, so the lead should read only the hunks the scout
 * flags instead of the whole diff. The owner wires these functions into
 * `reportChildCompletion`; everything here is side-effect free.
 */
import type {
  OrchestrationChildThreadStatus,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import {
  CHILD_REPORT_SUFFIX,
  ORCHESTRATION_MAX_CHILD_DEPTH,
  WORKER_SELF_CHECK,
  type OrchestrationChildMode,
} from "./orchestration-runtime";

export const SCOUT_PRE_REVIEW_ENV_VAR = "PI_APP_SCOUT_PRE_REVIEW";
export const SCOUT_PRE_REVIEW_TIMEOUT_ENV_VAR = "PI_APP_SCOUT_PRE_REVIEW_TIMEOUT_MS";
/** How long the worker report is held for the scout's verdict before it is delivered alone. */
export const DEFAULT_SCOUT_PRE_REVIEW_TIMEOUT_MS = 180_000;
/** Host cap on the injected verdict. The scout is asked for ~400 chars. */
export const SCOUT_VERDICT_LIMIT = 600;
/** Host cap on a scout failure detail surfaced to the lead. */
export const SCOUT_FAILURE_DETAIL_LIMIT = 300;
/** Cap on the worker brief quoted to the scout. */
const REVIEW_BRIEF_LIMIT = 4_000;
/** Changed paths listed in the scout brief; the rest are counted. */
const REVIEW_FILES_LIMIT = 30;
/**
 * Synthetic `sourceToolCallId` prefix for review scouts. The scout has no
 * parent tool call; the prefix identifies it before its spawn resolves, so a
 * run that finishes during launch is still matched to its held report.
 */
export const SCOUT_PRE_REVIEW_CALL_PREFIX = "pi-gui-pre-review:";
/** Opening line of every review brief (tests key the fake provider on it). */
export const SCOUT_PRE_REVIEW_BRIEF_OPENING =
  "Pre-review a worker's uncommitted change against its brief before the lead sees it.";

/** On unless PI_APP_SCOUT_PRE_REVIEW is 0/false/off, so it can be measured both ways. */
export function isScoutPreReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SCOUT_PRE_REVIEW_ENV_VAR]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/** Positive integer override in ms; junk falls back to the default. */
export function resolveScoutPreReviewTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SCOUT_PRE_REVIEW_TIMEOUT_ENV_VAR]?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return DEFAULT_SCOUT_PRE_REVIEW_TIMEOUT_MS;
}

export function isScoutPreReviewCallId(sourceToolCallId: string | undefined): boolean {
  return Boolean(sourceToolCallId?.startsWith(SCOUT_PRE_REVIEW_CALL_PREFIX));
}

const FILE_PATH_TOOLS = new Set(["edit", "write"]);
const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/**
 * Distinct workspace-relative paths that the latest run changed through
 * successful edit/write/apply_patch tool rows. "Latest run" is everything
 * after the last user message (the brief or the lead's follow-up).
 *
 * This reads the child's own tool rows instead of `git diff`: they are in
 * memory, cost no subprocess, and are attributable to this run, while the
 * shared checkout's diff also holds the user's and other workers' edits. A
 * file changed only through bash is missed, which fails safe: no review, and
 * the lead reviews as before.
 */
export function changedFilesFromLatestRun(
  transcript: readonly TranscriptMessage[],
  workspacePath?: string,
): readonly string[] {
  let start = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === "message" && item.role === "user") {
      start = index + 1;
      break;
    }
  }
  const paths = new Set<string>();
  for (const item of transcript.slice(start)) {
    if (item.kind !== "tool" || item.status !== "success") continue;
    for (const raw of toolPaths(item.toolName, item.input)) {
      const normalized = normalizePath(raw, workspacePath);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths];
}

function toolPaths(toolName: string, input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  if (FILE_PATH_TOOLS.has(toolName)) {
    const value = record.path ?? record.file_path;
    return typeof value === "string" ? [value] : [];
  }
  if (toolName === "apply_patch") {
    const patch = record.input ?? record.patch;
    if (typeof patch !== "string") return [];
    return [...patch.matchAll(PATCH_FILE_LINE)].map((match) => match[1] ?? "");
  }
  return [];
}

function normalizePath(raw: string, workspacePath: string | undefined): string {
  let value = raw.trim();
  const root = workspacePath?.replace(/\/+$/, "");
  if (root && value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
  while (value.startsWith("./")) value = value.slice(2);
  return value;
}

export interface PreReviewDecisionInput {
  readonly enabled: boolean;
  /** The finished child's parent is a Lead-mode session. */
  readonly parentIsLead: boolean;
  readonly mode: OrchestrationChildMode | undefined;
  readonly status: OrchestrationChildThreadStatus;
  readonly error?: string;
  readonly depth: number | undefined;
  readonly changedFiles: readonly string[];
}

/**
 * Pre-review only a Lead's worker whose run completed cleanly and changed
 * more than one file. Scouts (including review scouts) are never reviewed,
 * and the review scout must fit under the depth limit as the worker's child.
 */
export function shouldPreReviewWorkerRun(input: PreReviewDecisionInput): boolean {
  return (
    input.enabled &&
    input.parentIsLead &&
    (input.mode ?? "worker") === "worker" &&
    input.status === "complete" &&
    !input.error &&
    (input.depth ?? 1) < ORCHESTRATION_MAX_CHILD_DEPTH &&
    input.changedFiles.length > 1
  );
}

/**
 * The worker's original brief: its first user message, minus the host's
 * self-check and report contract, which only add noise for the reviewer.
 * Falls back to the stored goal when the transcript has no user message.
 */
export function workerBriefFromTranscript(
  transcript: readonly TranscriptMessage[],
  goal: string,
): string {
  const first = transcript.find(
    (item): item is Extract<TranscriptMessage, { kind: "message" }> =>
      item.kind === "message" && item.role === "user" && Boolean(item.text.trim()),
  );
  let brief = first?.text.trim() || goal.trim();
  for (const tail of [CHILD_REPORT_SUFFIX, WORKER_SELF_CHECK]) {
    if (brief.endsWith(tail)) brief = brief.slice(0, -tail.length).trimEnd();
  }
  return brief.length > REVIEW_BRIEF_LIMIT ? `${brief.slice(0, REVIEW_BRIEF_LIMIT)}…` : brief;
}

/** The read-only review scout's prompt, with its own short verdict contract. */
export function scoutPreReviewBrief(input: {
  readonly workerTitle: string;
  readonly brief: string;
  readonly changedFiles: readonly string[];
}): string {
  const shown = input.changedFiles.slice(0, REVIEW_FILES_LIMIT);
  const more = input.changedFiles.length - shown.length;
  return [
    SCOUT_PRE_REVIEW_BRIEF_OPENING,
    `Worker "${input.workerTitle}" changed: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}.`,
    "Inspect only its change with read-only commands such as `git diff -- <file>` and `git status --short`; do not edit anything.",
    `Original brief:\n"""\n${input.brief}\n"""`,
    "Check the change against the brief and its success criteria: missed requirements, bugs, unrelated edits, missing checks.",
    "Reply under ~400 characters in this form:\nVerdict: ok | needs attention\nHunks: one line per hunk that needs the lead's attention, as file:line - problem. Omit when ok.\nDo not restate the change or paste diffs.",
  ].join("\n\n");
}

export type PreReviewOutcome =
  | { readonly kind: "verdict"; readonly scoutThreadId: string; readonly verdict: string }
  | {
      readonly kind: "unavailable";
      readonly reason: "failed" | "timeout" | "cancelled" | "superseded";
      /**
       * Why the review failed, for the lead's note. Present only for
       * `failed`: the spawn/launch error, or the scout run's session error.
       * Without it the lead cannot tell a broken reviewer from a bad diff.
       */
      readonly error?: string;
    };

/**
 * One report for the lead: the worker report unchanged, then the scout's
 * capped verdict (or a one-line note when the review did not finish).
 */
export function combinedPreReviewReportText(
  workerReport: string,
  outcome: PreReviewOutcome,
): string {
  if (outcome.kind === "unavailable") {
    // A failed review names its cause: without it the lead cannot tell a
    // broken reviewer (failed spawn, dead runtime) from a bad diff. Timeout,
    // cancellation and supersession need no detail.
    if (outcome.reason === "failed" && outcome.error?.trim()) {
      const detail = outcome.error.trim();
      const capped =
        detail.length > SCOUT_FAILURE_DETAIL_LIMIT
          ? `${detail.slice(0, SCOUT_FAILURE_DETAIL_LIMIT)}…`
          : detail;
      return `${workerReport}\n\nScout pre-review failed (${capped}); review the diff yourself.`;
    }
    const why = outcome.reason === "timeout" ? "timed out" : outcome.reason;
    return `${workerReport}\n\nScout pre-review ${why}; review the diff yourself.`;
  }
  const trimmed = outcome.verdict.trim() || "No verdict returned.";
  const verdict =
    trimmed.length > SCOUT_VERDICT_LIMIT
      ? `${trimmed.slice(0, SCOUT_VERDICT_LIMIT)}…(verdict truncated)`
      : trimmed;
  return [
    workerReport,
    "",
    `Scout pre-review (thread_id: ${outcome.scoutThreadId}):`,
    verdict,
    "Read only the hunks it flags.",
  ].join("\n");
}
