import type { CompactionModelRoute } from "@pi-gui/pi-sdk-driver";
import type { SessionModelSelection } from "@pi-gui/session-driver";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";

/**
 * Exploratory mid-session routing (lead/sidekick plan 6c). Off unless this is
 * "1": measure it on real runs before making it a default.
 */
export const COMPACTION_MODEL_ROUTING_ENV_VAR = "PI_APP_COMPACTION_MODEL_ROUTING";

/** Failed or blocked evidence records after which a worker sidekick escalates. */
export const SIDEKICK_ESCALATION_FAILURES = 2;

export function compactionModelRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COMPACTION_MODEL_ROUTING_ENV_VAR] === "1";
}

/**
 * Desktop policy for the driver's compaction hook: a worker child whose
 * evidence shows at least two failures moves to its lead's model at its next
 * compaction, where the prompt cache is lost anyway. Scouts, healthy workers,
 * non-child sessions and children already on the lead model keep their model.
 */
export function sidekickEscalationRoute(input: {
  readonly child: OrchestrationChildThread | undefined;
  readonly leadModel: SessionModelSelection | undefined;
  readonly currentModel: SessionModelSelection | undefined;
}): CompactionModelRoute | undefined {
  const { child, leadModel, currentModel } = input;
  if (!child || child.mode === "scout" || !leadModel) return undefined;
  const failures = child.evidence.filter(
    (record) => record.status === "failed" || record.status === "blocked",
  ).length;
  if (failures < SIDEKICK_ESCALATION_FAILURES) return undefined;
  if (currentModel?.provider === leadModel.provider && currentModel.modelId === leadModel.modelId) {
    return undefined;
  }
  return { model: leadModel };
}
