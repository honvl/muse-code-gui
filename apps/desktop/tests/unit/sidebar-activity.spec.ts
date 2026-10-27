import { expect, test } from "@playwright/test";
import { runningAgentCallIds } from "../../src/features/threads/use-activity-auto-open";
import {
  formatBilledCost,
  formatCompactTokens,
  formatPlanWindow,
  summarizeSidebarUsage,
} from "../../src/features/threads/thread-groups";

function toolCall(callId: string, toolName: string, status: string) {
  return { kind: "tool", id: callId, callId, toolName, status, label: toolName };
}

test("runningAgentCallIds finds only running agent delegations", () => {
  const transcript = [
    { kind: "message", role: "user", content: "hi" },
    toolCall("call-1", "agent", "running"),
    toolCall("call-2", "bash", "running"),
    toolCall("call-3", "agent", "success"),
    toolCall("call-4", "agent", "error"),
  ];
  expect(runningAgentCallIds(transcript as never)).toEqual(["call-1"]);
});

test("runningAgentCallIds ignores pins and missing transcript", () => {
  expect(runningAgentCallIds(undefined)).toEqual([]);
  expect(runningAgentCallIds([])).toEqual([]);
  const transcript = [
    { kind: "pin", id: "pin-1" },
    { kind: "summary", id: "sum-1" },
  ];
  expect(runningAgentCallIds(transcript as never)).toEqual([]);
});

test("runningAgentCallIds skips malformed tool entries", () => {
  const transcript = [
    { kind: "tool", id: "x", status: "running" },
    toolCall("call-5", "agent", "running"),
  ];
  expect(runningAgentCallIds(transcript as never)).toEqual(["call-5"]);
});

function usageEntry(
  workspaceId: string,
  sessionId: string,
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
  subscription: boolean,
  planLimits?: { provider: string; limits: { windowMinutes: number; usedPercent: number }[] },
) {
  return {
    folderId: workspaceId,
    workspaceId,
    session: { id: sessionId },
    environment: { kind: "local", label: "" },
    contextLabel: "",
  };
}

function usageSnapshot(
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
  subscription: boolean,
  planLimits?: { provider: string; limits: { windowMinutes: number; usedPercent: number }[] },
) {
  return {
    cache: {},
    totals,
    subscription,
    planLimits: planLimits
      ? { provider: planLimits.provider, limits: planLimits.limits, reportedAt: 0 }
      : undefined,
  };
}

test("summarizeSidebarUsage splits billed cost from subscription tokens", () => {
  const summary = summarizeSidebarUsage(
    [
      usageEntry(
        "ws",
        "a",
        { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1.5 },
        false,
      ),
      usageEntry(
        "ws",
        "b",
        { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 99 },
        true,
      ),
    ] as never,
    {
      "ws:a": usageSnapshot(
        { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1.5 },
        false,
      ),
      "ws:b": usageSnapshot(
        { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 99 },
        true,
      ),
    } as never,
  );
  expect(summary.sessionCount).toBe(2);
  expect(summary.totalTokens).toBe(1650);
  expect(summary.billedCost).toBe(1.5);
  expect(summary.subscriptionTokens).toBe(1500);
});

test("summarizeSidebarUsage dedupes plan windows keeping the highest usage", () => {
  const summary = summarizeSidebarUsage(
    [
      usageEntry("ws", "a", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, false),
      usageEntry("ws", "b", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, false),
    ] as never,
    {
      "ws:a": usageSnapshot({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, false, {
        provider: "meta",
        limits: [{ windowMinutes: 300, usedPercent: 40 }],
      }),
      "ws:b": usageSnapshot({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, false, {
        provider: "meta",
        limits: [
          { windowMinutes: 300, usedPercent: 78 },
          { windowMinutes: 10080, usedPercent: 12 },
        ],
      }),
    } as never,
  );
  expect(summary.planLimits.map((limit) => [limit.windowMinutes, limit.usedPercent])).toEqual([
    [300, 78],
    [10080, 12],
  ]);
});

test("summarizeSidebarUsage is empty without snapshots", () => {
  expect(summarizeSidebarUsage([], undefined)).toEqual({
    sessionCount: 0,
    totalTokens: 0,
    billedCost: 0,
    subscriptionTokens: 0,
    planLimits: [],
  });
});

test("usage formatters compact tokens, cost and windows", () => {
  expect(formatCompactTokens(999)).toBe("999");
  expect(formatCompactTokens(1500)).toBe("1.5K");
  expect(formatCompactTokens(2_400_000)).toBe("2.4M");
  expect(formatBilledCost(0)).toBe("$0");
  expect(formatBilledCost(3.456)).toBe("$3.46");
  expect(formatPlanWindow(30)).toBe("30m");
  expect(formatPlanWindow(300)).toBe("5h");
  expect(formatPlanWindow(10080)).toBe("7d");
});
