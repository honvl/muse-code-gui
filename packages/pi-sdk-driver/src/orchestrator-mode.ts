import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { extractChildToolArg, isScoutReadOnlyBashCommand } from "./child-isolation.js";

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
  `Delegate by default: your own tokens are the expensive resource and a child's context is separate from yours. Spawn one child thread per independent part with parallel create_child_thread calls (mode "scout" for searches/reviews — scouts may run read-only shell commands such as rg, grep, and ls but cannot edit, write, or mutate — "worker" for edits and mutating shell). Reuse a child whose context already covers the work (list_threads to find it, send_message_to_thread to continue it — preserves context/cache); spawn fresh only for parallel/independent slices or when the child drifted or is out of scope. Your delegation tools are ${ORCHESTRATOR_ALLOWED_TOOLS.join(", ")}.`,
  "Your own hands are for reading and for one-line fixes. Anything bigger — two files, a new file, or a command that writes — goes to a worker child with a one-line brief; the host fills the rest. If the writer rule blocks you, wait or narrow scope instead of doing the edit yourself.",
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

interface LeadMutationState {
  count: number;
  paths: string[];
}

/** Direct-mutation counts per lead session, reset on every run. */
const leadMutationBySession = new Map<string, LeadMutationState>();

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

/** True when a lead tool call mutates: edits, writes, and bash the scout read-only policy rejects. */
function isLeadDirectMutation(toolName: string, input: unknown): boolean {
  if (toolName === "edit" || toolName === "write") {
    return true;
  }
  if (toolName === "bash") {
    return !isScoutReadOnlyBashCommand(extractChildToolArg("bash", input));
  }
  return false;
}

function leadDirectMutationBlockReason(paths: readonly string[], limit: number): string {
  const scopeHint = paths.length > 0 ? paths.join(", ") : "the files you were editing";
  return (
    `You have made ${limit} direct edits this run. Delegate the remaining work: ` +
    `create_child_thread with scope "${scopeHint}" and mode "worker". ` +
    `Keep only a single one-line fix in your own hands.`
  );
}

/**
 * Hidden inline extension: lead prompt nudge plus a soft gate on the lead's
 * own mutations. The first `limit` direct mutations per run pass through;
 * the next one is blocked with a redirect to `create_child_thread`. Solo
 * threads are untouched: the switch changes policy, not capability.
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
      // A new run clears the direct-mutation budget for this session.
      leadMutationBySession.delete(leadSessionKey(ctx));
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
      if (!isLeadDirectMutation(toolName, input)) return undefined;
      const key = leadSessionKey(ctx);
      const limit = resolveLeadDirectMutationLimit();
      const state = leadMutationBySession.get(key) ?? { count: 0, paths: [] };
      if (state.count >= limit) {
        return { block: true, reason: leadDirectMutationBlockReason(state.paths, limit) };
      }
      state.count += 1;
      if (toolName === "edit" || toolName === "write") {
        const path = extractChildToolArg(toolName, input)?.trim();
        if (path && !state.paths.includes(path) && state.paths.length < 3) {
          state.paths.push(path);
        }
      }
      leadMutationBySession.set(key, state);
      return undefined;
    });
  };
}
