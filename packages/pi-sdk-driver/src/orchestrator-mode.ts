import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { classifyLeadToolCall, type LeadAction } from "./lead-action-classifier.js";

/**
 * Lead-mode orchestration for pi-gui threads.
 *
 * When enabled for a session, the model keeps ALL of its normal tools
 * (read, bash, edit, write, greps) and gains the delegation tools. Prompt
 * guidance makes delegation the default strategy for bulky/parallel work,
 * while letting the lead act directly when a step is small enough that a
 * child round-trip would cost more than doing it.
 *
 * Children intentionally never inherit this mode (see app-store-orchestration:
 * child threads run on the thread's configured sidekick model, inheriting the
 * spawning session's model for deeper children, falling back to the workspace
 * default).
 */

/**
 * One line for threads that are NOT in lead mode. The delegation tools are
 * registered for every session, so "Solo" means "work in this thread by
 * default", not "cannot delegate": the switch changes policy, not capability.
 */
export const SOLO_SYSTEM_GUIDELINE =
  "Solo mode: do the work in this thread yourself. You may still delegate with " +
  "create_child_thread when the user asks for it or the task genuinely splits into " +
  "independent parts.";

/** Delegation tools named by the lead prompt. The lead keeps its full toolset plus these. */
export const ORCHESTRATOR_ALLOWED_TOOLS: readonly string[] = [
  "create_child_thread",
  "list_threads",
  "read_thread",
  "send_message_to_thread",
];

export const ORCHESTRATOR_SYSTEM_PROMPT = [
  "You are the lead of a lead-plus-child team. You own the plan, the interpretation of ambiguity, and the final review before anything reaches the user. A report is a claim, not proof: verify by reading the diff and the files the child named against the brief's success criteria. A child's validation counts as evidence unless the change is subtle or risky — never re-run a suite it already ran; for subtle or shared/critical changes delegate a read-only scout review instead.",
  `Delegate by default: your own tokens are the expensive resource and a child's context is separate from yours. Spawn one child thread per independent part with parallel create_child_thread calls (mode "scout" for searches/reviews — scouts may run read-only shell commands such as rg, grep, and ls but cannot edit, write, or mutate — "worker" for edits and mutating shell). The host reuses your sidekick automatically: a worker create_child_thread continues your recent idle worker, which preserves context/cache; pass fresh:true for parallel/independent slices or when the child drifted or is out of scope. Your delegation tools are ${ORCHESTRATOR_ALLOWED_TOOLS.join(", ")}.`,
  "Your own hands are for reading and for one-line fixes. Targeted reads (rg -l, line ranges, the diff hunks you must review) are yours; broad exploration (many files, logs, history) goes to a scout that returns a short summary. Anything bigger than a one-line fix — two files, a new file, a command that writes, or any test, build, or typecheck run — goes to a worker child with a one-line brief; the host fills the rest. If the writer rule blocks you, wait or narrow scope instead of doing the edit yourself.",
  "Write briefs a stranger could execute: objective, context, constraints, files/areas in scope, success criteria, what NOT to do, and the verification to run. Always pass scope: only one worker writes at a time, so parallel workers need disjoint scopes (apps/a vs apps/b); an unscoped worker claims the whole workspace and blocks the others.",
  "Children report back automatically when a run ends; do not poll read_thread in a loop. Act on each report. If a report is thin, steer the child with send_message_to_thread; if a child is drifting, take the work back and do it yourself.",
  "Keep your own context small: use targeted rg patterns, line ranges, and git diff --stat followed by only the files that matter. Never dump a whole file, a full diff, or a test log into your context; never re-read what a child already verified.",
].join("\n");

/** Default cap on the lead's own mutating tool calls per run before the soft gate redirects to delegation. */
export const DEFAULT_LEAD_DIRECT_MUTATION_LIMIT = 3;
export const LEAD_DIRECT_MUTATION_LIMIT_ENV_VAR = "PI_APP_LEAD_DIRECT_MUTATION_LIMIT";

/**
 * Cap on the lead's direct mutations per run. Overridable with
 * PI_APP_LEAD_DIRECT_MUTATION_LIMIT (positive integer; junk falls back to
 * the default). Read at call time so tests and restarts can reconfigure.
 */
export function resolveLeadDirectMutationLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LEAD_DIRECT_MUTATION_LIMIT_ENV_VAR]?.trim();
  if (raw !== undefined && raw !== "" && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return DEFAULT_LEAD_DIRECT_MUTATION_LIMIT;
}

/**
 * Characters of tool output the lead may pull into its own context per run
 * before the next exploratory read is redirected to a scout. One nudge per
 * budget's worth of output: after a nudge, reads pass again until another
 * budget accumulates, so a targeted read the lead genuinely needs is never
 * locked out. Overridable with PI_APP_LEAD_READ_BUDGET_CHARS.
 */
export const DEFAULT_LEAD_READ_BUDGET_CHARS = 24_000;
export const LEAD_READ_BUDGET_ENV_VAR = "PI_APP_LEAD_READ_BUDGET_CHARS";

export function resolveLeadReadBudgetChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LEAD_READ_BUDGET_ENV_VAR]?.trim();
  if (raw !== undefined && raw !== "" && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return DEFAULT_LEAD_READ_BUDGET_CHARS;
}

/** Tools whose output is exploration the lead could hand to a scout. Delegation tools never nudge. */
const LEAD_EXPLORATION_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "bash_background",
  "shell",
]);

interface LeadRunState {
  /** Labels of the edits and verification runs that spent the direct-work budget. */
  counted: string[];
  paths: string[];
  outputChars: number;
  nextReadNudgeAt: number;
}

/** Direct-work and read-volume accounting per lead session, reset on every run. */
const leadRunBySession = new Map<string, LeadRunState>();

function leadRunState(key: string): LeadRunState {
  let state = leadRunBySession.get(key);
  if (!state) {
    state = {
      counted: [],
      paths: [],
      outputChars: 0,
      nextReadNudgeAt: resolveLeadReadBudgetChars(),
    };
    leadRunBySession.set(key, state);
  }
  return state;
}

function leadSessionKey(ctx: ExtensionContext): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  } catch {
    // Unusual contexts fall back to a shared bucket rather than crashing the gate.
  }
  return "default";
}

function leadDirectWorkBlockReason(state: LeadRunState, limit: number, next: LeadAction): string {
  const scopeHint = state.paths.length > 0 ? state.paths.join(", ") : "the files you were editing";
  const counted = state.counted.join("; ");
  const what = next.kind === "verification" ? "test/build runs" : "edits";
  return (
    `Direct-work limit reached: ${limit} edits or test/build runs this run (${counted}). ` +
    `Delegate the remaining ${what}: create_child_thread with mode "worker" and scope "${scopeHint}"; ` +
    `a worker runs the checks and reports the command and outcome. ` +
    `Reads stay free: rg, sed -n, and git diff/log never count.`
  );
}

function leadReadBudgetNudge(outputChars: number): string {
  const thousands = Math.round(outputChars / 1000);
  return (
    `You have pulled about ${thousands}k characters of tool output into your own context this run. ` +
    `Hand further broad exploration to a scout: create_child_thread with mode "scout" and ask for a summary under 800 characters. ` +
    `If this exact call is a targeted read you need for the plan or a review, repeat it and it will run.`
  );
}

function toolResultChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const item of content) {
    const text = (item as { readonly text?: unknown } | null)?.text;
    if (typeof text === "string") total += text.length;
  }
  return total;
}

/**
 * Hidden inline extension: lead prompt nudge plus two soft gates on the
 * lead's own hands, both aimed at the lead's tokens (children are cheap):
 *
 * - Direct work: the first `limit` edits or test/build runs per run pass;
 *   the next is blocked with a redirect to a worker child. Reads never count
 *   (see lead-action-classifier: cost classification, not a safety policy).
 * - Read volume: after each budget's worth of tool output enters the lead's
 *   context, the next exploratory call is bounced once toward a scout.
 *
 * Solo threads are untouched: the switch changes policy, not capability.
 */
export function createOrchestratorModeExtension(
  resolveEnabled: (ctx: ExtensionContext) => boolean,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event, ctx) => {
      if (!resolveEnabled(ctx)) {
        event.systemPromptOptions.promptGuidelines.push(SOLO_SYSTEM_GUIDELINE);
        return undefined;
      }
      // Lead mode restores pi's NORMAL default loadout on every run. A thread
      // resumed from the dispatcher-only era replays its transcript loadout at
      // open (_restoreToolsFromTranscript), which cages it to the 4 delegation
      // tools. Re-asserting the default-active set here defeats that cage: in
      // _prepareRun the live loadout is authoritative, so this setActiveTools
      // call wins for the run and the run re-records the default loadout in
      // the transcript going forward. The filter mirrors pi's own
      // _isActivatedOnRegistration/_isDeclarable rule (agent-session.js): only
      // direct and model-only tools are declarable to the model. ToolInfo
      // exposes exposure but not defaultActive, so exposure is the public
      // signal — hidden/codemode/deferred tools stay out of the declared set
      // (they remain callable from codemode scripts whether active or not).
      pi.setActiveTools(
        pi
          .getAllTools()
          .filter(
            (tool) => (tool.exposure ?? "direct") === "direct" || tool.exposure === "model-only",
          )
          .map((tool) => tool.name),
      );
      // Delegation strategy lives only in the orchestrator_mode section above:
      // no per-run guideline, so the lead's cached prefix stays small.
      // A new run clears the direct-work and read budgets for this session.
      leadRunBySession.delete(leadSessionKey(ctx));
      event.systemPromptOptions.sections["orchestrator_mode"] = ORCHESTRATOR_SYSTEM_PROMPT;
      return undefined;
    });

    pi.on("tool_call", async (_event, ctx) => {
      if (!resolveEnabled(ctx)) return undefined;
      // Solo threads are never gated; nested calls (e.g. codemode scripts)
      // are the tool's work, not the lead's hands.
      const toolName = (_event as { readonly toolName?: unknown }).toolName;
      if (typeof toolName !== "string" || toolName.length === 0) return undefined;
      if ((_event as { readonly parentToolCallId?: unknown }).parentToolCallId) return undefined;
      const input = (_event as { readonly input?: unknown }).input;
      const action = classifyLeadToolCall(toolName, input);
      const state = leadRunState(leadSessionKey(ctx));
      if (action.kind === "read") {
        if (!LEAD_EXPLORATION_TOOLS.has(toolName) || state.outputChars < state.nextReadNudgeAt) {
          return undefined;
        }
        state.nextReadNudgeAt = state.outputChars + resolveLeadReadBudgetChars();
        return { block: true, reason: leadReadBudgetNudge(state.outputChars) };
      }
      const limit = resolveLeadDirectMutationLimit();
      if (state.counted.length >= limit) {
        return { block: true, reason: leadDirectWorkBlockReason(state, limit, action) };
      }
      state.counted.push(action.label);
      if (action.path && !state.paths.includes(action.path) && state.paths.length < 3) {
        state.paths.push(action.path);
      }
      return undefined;
    });

    pi.on("tool_result", async (event, ctx) => {
      if (!resolveEnabled(ctx)) return undefined;
      if ((event as { readonly parentToolCallId?: unknown }).parentToolCallId) return undefined;
      leadRunState(leadSessionKey(ctx)).outputChars += toolResultChars(
        (event as { readonly content?: unknown }).content,
      );
      return undefined;
    });
  };
}
