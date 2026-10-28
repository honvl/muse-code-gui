/**
 * Persistent sidekick (warm cache) decision.
 *
 * A lead's worker `create_child_thread` continues its most recent idle worker
 * instead of spawning a cold session, so the sidekick keeps its cached context
 * across briefs. This module is the pure decision; the orchestration owner
 * gathers the facts (live status, model, context usage, compactions), runs the
 * writer-scope check, and delivers the brief as a follow-up.
 */
import type { SessionModelSelection } from "@pi-gui/session-driver";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";

/** Prompt caches commonly expire after ~5 minutes; reuse only inside that. */
export const DEFAULT_SIDEKICK_REUSE_WINDOW_MS = 4 * 60_000;
export const SIDEKICK_REUSE_WINDOW_ENV_VAR = "PI_APP_SIDEKICK_REUSE_WINDOW_MS";
/** A sidekick takes at most this many briefs (runs) before a fresh one starts. */
export const SIDEKICK_MAX_GENERATION = 8;
/** Above this share of its model window a sidekick is too full to take another brief. */
export const SIDEKICK_CONTEXT_BUDGET_RATIO = 0.6;
/** A sidekick that compacted this often has lost most of its warm context. */
export const SIDEKICK_MAX_COMPACTIONS = 2;

/**
 * Reuse window in ms. Overridable with PI_APP_SIDEKICK_REUSE_WINDOW_MS (a
 * non-negative integer; 0 turns reuse off; junk falls back to the default).
 */
export function resolveSidekickReuseWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SIDEKICK_REUSE_WINDOW_ENV_VAR]?.trim();
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value)) {
      return value;
    }
  }
  return DEFAULT_SIDEKICK_REUSE_WINDOW_MS;
}

export interface SidekickContextUsage {
  /** Tokens the next request carries; null right after a compaction. */
  readonly tokens: number | null;
  readonly contextWindow: number;
}

export interface SidekickReuseCandidate {
  readonly child: OrchestrationChildThread;
  /** Runs this child has taken (1 on creation, +1 per follow-up). */
  readonly generation: number;
  /** The model the child session runs on, when known. */
  readonly model?: SessionModelSelection;
  /** The session is running, or another call already claimed it. */
  readonly busy: boolean;
  readonly context?: SidekickContextUsage;
  readonly compactions?: number;
}

export interface SidekickReuseInput {
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly candidates: readonly SidekickReuseCandidate[];
  readonly nowMs: number;
  readonly windowMs: number;
  /** The model a fresh worker would get; undefined means the workspace default (not checked). */
  readonly expectedModel?: SessionModelSelection;
  /** The lead asked for a separate child. */
  readonly fresh?: boolean;
  /** Another create_child_thread call of the same assistant turn came first. */
  readonly parallel?: boolean;
  /**
   * The brief asks for `isolation: "worktree"`. Only a worktree child takes a
   * worktree brief, and only a shared-checkout child takes the others.
   */
  readonly worktree?: boolean;
  readonly maxGeneration?: number;
}

export type SidekickReuseSkipReason =
  "fresh" | "parallel" | "no-candidate" | "context-budget" | "compactions";

export type SidekickReuseDecision =
  | { readonly reuse: true; readonly child: OrchestrationChildThread }
  | {
      readonly reuse: false;
      readonly reason: SidekickReuseSkipReason;
      /** One line for the tool result when a warm sidekick was passed over. */
      readonly note?: string;
    };

/**
 * Decide whether a worker brief continues an existing sidekick. Picks the
 * parent's most recent idle worker on the expected model and of the same
 * isolation (worktree or shared checkout), under the generation limit, whose
 * last activity is inside the window; then refuses it when its
 * context is over budget. Only the first call of an assistant turn may reuse,
 * so parallel slices never collapse onto one child. Pure.
 */
export function decideSidekickReuse(input: SidekickReuseInput): SidekickReuseDecision {
  if (input.fresh) {
    return { reuse: false, reason: "fresh" };
  }
  if (input.parallel) {
    return { reuse: false, reason: "parallel" };
  }
  const maxGeneration = input.maxGeneration ?? SIDEKICK_MAX_GENERATION;
  let best: { readonly candidate: SidekickReuseCandidate; readonly at: number } | undefined;
  for (const candidate of input.candidates) {
    const { child } = candidate;
    const at = Date.parse(child.updatedAt);
    if (
      child.parentWorkspaceId !== input.parentWorkspaceId ||
      child.parentSessionId !== input.parentSessionId ||
      child.mode === "scout" ||
      Boolean(child.worktreePath) !== Boolean(input.worktree) ||
      !child.childSessionId ||
      (child.status !== "complete" && child.status !== "failed") ||
      candidate.busy ||
      candidate.generation >= maxGeneration ||
      !sameModel(input.expectedModel, candidate.model) ||
      !Number.isFinite(at) ||
      input.nowMs - at > input.windowMs ||
      (best && best.at >= at)
    ) {
      continue;
    }
    best = { candidate, at };
  }
  if (!best) {
    return { reuse: false, reason: "no-candidate" };
  }
  const { child, context, compactions } = best.candidate;
  const note = sidekickContextBudgetNote(child.title || child.id, context, compactions);
  if (note) {
    return { reuse: false, reason: contextOver(context) ? "context-budget" : "compactions", note };
  }
  return { reuse: true, child };
}

/**
 * One line for the tool result when a sidekick's context is over budget (above
 * SIDEKICK_CONTEXT_BUDGET_RATIO of its window, or compacted
 * SIDEKICK_MAX_COMPACTIONS times); undefined when it can take another brief.
 * Unknown usage (none reported, or null tokens right after a compaction) does
 * not count against it. Pure.
 */
export function sidekickContextBudgetNote(
  title: string,
  context: SidekickContextUsage | undefined,
  compactions: number | undefined,
): string | undefined {
  if (contextOver(context)) {
    const percent = Math.round((contextShare(context) ?? 0) * 100);
    return `Started a fresh sidekick: "${title}" is at ${percent}% of its context window.`;
  }
  if (compactionsOver(compactions)) {
    return `Started a fresh sidekick: "${title}" has compacted ${compactions} times.`;
  }
  return undefined;
}

function contextShare(context: SidekickContextUsage | undefined): number | undefined {
  return context && context.tokens !== null && context.contextWindow > 0
    ? context.tokens / context.contextWindow
    : undefined;
}

function contextOver(context: SidekickContextUsage | undefined): boolean {
  return (contextShare(context) ?? 0) > SIDEKICK_CONTEXT_BUDGET_RATIO;
}

function compactionsOver(compactions: number | undefined): boolean {
  return compactions !== undefined && compactions >= SIDEKICK_MAX_COMPACTIONS;
}

function sameModel(
  expected: SessionModelSelection | undefined,
  actual: SessionModelSelection | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  return actual?.provider === expected.provider && actual.modelId === expected.modelId;
}
