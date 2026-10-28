import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

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

/** Delegation tools named by the lead prompt. The lead keeps its full toolset plus these. */
export const ORCHESTRATOR_ALLOWED_TOOLS: readonly string[] = [
  "create_child_thread",
  "list_threads",
  "read_thread",
  "send_message_to_thread",
];

export const ORCHESTRATOR_SYSTEM_PROMPT = [
  "You are the lead of a lead-plus-child team. You own the plan, the interpretation of ambiguity, and the final review of every result before it reaches the user.",
  `Delegate first when work is bulky, parallel, or mechanical — multi-file sweeps, broad searches, running builds/tests, repetitive edits — spawning one child thread per independent part with parallel create_child_thread calls (mode "scout" for searches/reviews, "worker" for edits/shell). Your delegation tools are ${ORCHESTRATOR_ALLOWED_TOOLS.join(", ")}.`,
  "Do it yourself when it is one small step: read one file, a one-line edit, one quick grep. Never delegate a trivial action just to stay in role; a child round-trip for seconds of work wastes time.",
  "Write briefs a stranger could execute: objective, context, constraints, files/areas in scope, success criteria, what NOT to do, and the verification to run.",
  "Children report back automatically when a run ends; do not poll read_thread in a loop. Act on each report. If a report is thin, steer the child with send_message_to_thread; if a child is drifting, take the work back and do it yourself.",
  "Keep your own context small: read only what you need to decide; do not re-read what a child already verified.",
].join("\n");

/** Hidden inline extension: lead prompt nudge. Nothing is blocked at tool_call. */
export function createOrchestratorModeExtension(
  resolveEnabled: (ctx: ExtensionContext) => boolean,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event, ctx) => {
      if (!resolveEnabled(ctx)) return undefined;
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
      event.systemPromptOptions.promptGuidelines.push(
        "Lead mode: you keep all your tools. Delegate bulky, parallel, or mechanical work " +
          "to child threads, do small steps yourself, brief children like strangers, and " +
          "never poll read_thread — finished children report back automatically.",
      );
      event.systemPromptOptions.sections["orchestrator_mode"] = ORCHESTRATOR_SYSTEM_PROMPT;
      return undefined;
    });

    pi.on("tool_call", async (_event, ctx) => {
      if (!resolveEnabled(ctx)) return undefined;
      // Lead mode blocks nothing: the lead may act directly or delegate.
      return undefined;
    });
  };
}
