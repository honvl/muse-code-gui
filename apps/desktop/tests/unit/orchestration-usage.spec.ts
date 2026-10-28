import { expect, test } from "@playwright/test";
import type { SessionUsageSnapshot } from "@pi-gui/session-driver";
import type { OrchestrationChildThread } from "../../src/contracts/desktop-state";
import { summarizeOrchestrationUsage } from "../../src/features/threads/orchestration-usage";

const createdAt = "2026-10-28T00:00:00.000Z";

function childRecord(overrides: Partial<OrchestrationChildThread> = {}): OrchestrationChildThread {
  return {
    id: "child-thread-1",
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: "child",
    title: "Child",
    goal: "Do work",
    status: "running",
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cost: number,
  subscription = false,
): SessionUsageSnapshot {
  return {
    cache: {},
    totals: { input, output, cacheRead, cacheWrite: 0, cost },
    subscription,
  };
}

const parentRef = { workspaceId: "ws", sessionId: "parent" };

test("lead-only: lead lane sums the parent, delegated lane is empty", () => {
  const result = summarizeOrchestrationUsage(parentRef, [], {
    "ws:parent": usage(1000, 500, 200, 0.03),
  });
  expect(result.lead).toEqual({
    sessions: 1,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cost: 0.03,
    billable: true,
    partial: false,
  });
  expect(result.delegated).toEqual({
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
    billable: false,
    partial: false,
  });
});

test("children-only: missing parent usage marks the lead partial", () => {
  const result = summarizeOrchestrationUsage(
    parentRef,
    [childRecord({ childSessionId: "child-a" })],
    { "ws:child-a": usage(2000, 1000, 0, 0.05) },
  );
  expect(result.lead.sessions).toBe(0);
  expect(result.lead.partial).toBe(true);
  expect(result.delegated.sessions).toBe(1);
  expect(result.delegated.inputTokens).toBe(2000);
  expect(result.delegated.partial).toBe(false);
});

test("grandchild usage is included in the delegated lane", () => {
  const result = summarizeOrchestrationUsage(
    parentRef,
    [
      childRecord({ id: "t1", childSessionId: "child-a" }),
      childRecord({
        id: "t2",
        parentWorkspaceId: "ws",
        parentSessionId: "child-a",
        childWorkspaceId: "ws",
        childSessionId: "grandchild",
      }),
    ],
    {
      "ws:parent": usage(100, 50, 0, 0.01),
      "ws:child-a": usage(1000, 500, 100, 0.02),
      "ws:grandchild": usage(3000, 1500, 300, 0.04),
    },
  );
  expect(result.lead.sessions).toBe(1);
  expect(result.delegated.sessions).toBe(2);
  expect(result.delegated.inputTokens).toBe(4000);
  expect(result.delegated.outputTokens).toBe(2000);
  expect(result.delegated.cacheReadTokens).toBe(400);
  expect(result.delegated.cost).toBeCloseTo(0.06, 10);
  expect(result.delegated.partial).toBe(false);
});

test("one child missing usage marks delegated partial and is excluded from sums", () => {
  const result = summarizeOrchestrationUsage(
    parentRef,
    [
      childRecord({ id: "t1", childSessionId: "child-a" }),
      childRecord({ id: "t2", childSessionId: "child-b" }),
    ],
    { "ws:child-a": usage(1000, 500, 0, 0.02) },
  );
  expect(result.delegated.sessions).toBe(1);
  expect(result.delegated.inputTokens).toBe(1000);
  expect(result.delegated.partial).toBe(true);
});

test("all-subscription lanes are not billable and cost nothing", () => {
  const result = summarizeOrchestrationUsage(
    parentRef,
    [childRecord({ childSessionId: "child-a" })],
    {
      "ws:parent": usage(1000, 500, 100, 1.25, true),
      "ws:child-a": usage(2000, 1000, 200, 2.5, true),
    },
  );
  expect(result.lead.billable).toBe(false);
  expect(result.lead.cost).toBe(0);
  expect(result.lead.sessions).toBe(1);
  expect(result.delegated.billable).toBe(false);
  expect(result.delegated.cost).toBe(0);
  expect(result.delegated.sessions).toBe(1);
});

test("mixed lanes bill only the non-subscription cost", () => {
  const result = summarizeOrchestrationUsage(
    parentRef,
    [
      childRecord({ id: "t1", childSessionId: "child-a" }),
      childRecord({ id: "t2", childSessionId: "child-b" }),
    ],
    {
      "ws:child-a": usage(2000, 1000, 0, 9.99, true),
      "ws:child-b": usage(4000, 2000, 0, 0.07),
    },
  );
  expect(result.delegated.billable).toBe(true);
  expect(result.delegated.cost).toBeCloseTo(0.07, 10);
  expect(result.delegated.inputTokens).toBe(6000);
  expect(result.delegated.sessions).toBe(2);
});

test("duplicate child records and a cycle back to the lead do not double count", () => {
  const result = summarizeOrchestrationUsage(
    parentRef,
    [
      childRecord({ id: "t1", childSessionId: "child-a" }),
      childRecord({ id: "t1-dup", childSessionId: "child-a" }),
      childRecord({
        id: "cycle",
        parentWorkspaceId: "ws",
        parentSessionId: "child-a",
        childWorkspaceId: "ws",
        childSessionId: "parent",
      }),
    ],
    {
      "ws:parent": usage(100, 50, 0, 0.01),
      "ws:child-a": usage(1000, 500, 0, 0.02),
    },
  );
  expect(result.lead.sessions).toBe(1);
  expect(result.lead.inputTokens).toBe(100);
  expect(result.delegated.sessions).toBe(1);
  expect(result.delegated.inputTokens).toBe(1000);
  expect(result.delegated.cost).toBeCloseTo(0.02, 10);
  expect(result.delegated.partial).toBe(false);
});

test("empty: both lanes report zero sessions and no partial", () => {
  const result = summarizeOrchestrationUsage(parentRef, [], {});
  expect(result.lead.sessions).toBe(0);
  expect(result.lead.partial).toBe(false);
  expect(result.delegated.sessions).toBe(0);
  expect(result.delegated.partial).toBe(false);
});
