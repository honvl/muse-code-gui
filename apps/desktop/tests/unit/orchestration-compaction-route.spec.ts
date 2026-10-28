import { expect, test } from "@playwright/test";
import type {
  OrchestrationChildThread,
  OrchestrationEvidenceRecord,
} from "../../contracts/desktop-state";
import {
  COMPACTION_MODEL_ROUTING_ENV_VAR,
  compactionModelRoutingEnabled,
  sidekickEscalationRoute,
} from "../../electron/orchestration/compaction-model-route";

const createdAt = "2026-10-28T12:00:00.000Z";
const lead = { provider: "frontier", modelId: "lead-1" };
const sidekick = { provider: "cheap", modelId: "sidekick-1" };

function evidence(status: OrchestrationEvidenceRecord["status"], id: string) {
  return {
    id,
    childThreadId: "child-1",
    kind: "command",
    source: "command",
    status,
    title: "pnpm test",
    createdAt,
  } satisfies OrchestrationEvidenceRecord;
}

function child(
  overrides: Partial<OrchestrationChildThread> & {
    readonly evidence?: readonly OrchestrationEvidenceRecord[];
  } = {},
): OrchestrationChildThread {
  return {
    id: "child-1",
    parentWorkspaceId: "ws",
    parentSessionId: "lead",
    childWorkspaceId: "ws",
    childSessionId: "child",
    title: "worker",
    goal: "fix it",
    mode: "worker",
    depth: 1,
    status: "running",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const twoFailures = [evidence("failed", "e1"), evidence("blocked", "e2")];

test("routing is off unless the flag is exactly 1", () => {
  expect(compactionModelRoutingEnabled({})).toBe(false);
  expect(compactionModelRoutingEnabled({ [COMPACTION_MODEL_ROUTING_ENV_VAR]: "true" })).toBe(false);
  expect(compactionModelRoutingEnabled({ [COMPACTION_MODEL_ROUTING_ENV_VAR]: "1" })).toBe(true);
});

test("a worker that failed twice escalates to the lead model", () => {
  expect(
    sidekickEscalationRoute({
      child: child({ evidence: twoFailures }),
      leadModel: lead,
      currentModel: sidekick,
    }),
  ).toEqual({ model: lead });
});

test("one failure, a scout, a non-child or a child already on the lead model keep their model", () => {
  expect(
    sidekickEscalationRoute({
      child: child({ evidence: [evidence("failed", "e1"), evidence("passed", "e2")] }),
      leadModel: lead,
      currentModel: sidekick,
    }),
  ).toBeUndefined();
  expect(
    sidekickEscalationRoute({
      child: child({ mode: "scout", evidence: twoFailures }),
      leadModel: lead,
      currentModel: sidekick,
    }),
  ).toBeUndefined();
  expect(
    sidekickEscalationRoute({ child: undefined, leadModel: lead, currentModel: sidekick }),
  ).toBeUndefined();
  expect(
    sidekickEscalationRoute({
      child: child({ evidence: twoFailures }),
      leadModel: lead,
      currentModel: lead,
    }),
  ).toBeUndefined();
  expect(
    sidekickEscalationRoute({
      child: child({ evidence: twoFailures }),
      leadModel: undefined,
      currentModel: sidekick,
    }),
  ).toBeUndefined();
});
