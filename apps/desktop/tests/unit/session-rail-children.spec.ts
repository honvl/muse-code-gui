import { expect, test } from "@playwright/test";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";
import {
  childOutputSnippet,
  runningChildrenForRail,
} from "../../src/features/conversation/session-rail";

function child(
  id: string,
  overrides: Partial<OrchestrationChildThread> = {},
): OrchestrationChildThread {
  return {
    id,
    parentWorkspaceId: "ws",
    parentSessionId: "lead",
    childWorkspaceId: "ws",
    childSessionId: `child-session-${id}`,
    title: `Child ${id}`,
    goal: "do work",
    mode: "worker",
    depth: 1,
    status: "running",
    latestTranscript: "working…",
    transcript: [],
    evidence: [],
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:01:00.000Z",
    ...overrides,
  };
}

test("runningChildrenForRail returns only running children of that parent", () => {
  const children = [
    child("a"),
    child("b", { status: "complete" }),
    child("c", { status: "failed" }),
    child("d", { status: "queued" }),
    child("e", { status: "waiting" }),
    child("f", { parentSessionId: "other-lead" }),
    child("g", { parentWorkspaceId: "other-ws" }),
  ];
  const result = runningChildrenForRail(children, { workspaceId: "ws", sessionId: "lead" });
  expect(result.map((entry) => entry.id)).toEqual(["a"]);
});

test("runningChildrenForRail caps at the limit", () => {
  const children = [child("a"), child("b"), child("c"), child("d")];
  expect(
    runningChildrenForRail(children, { sessionId: "lead" }, 3).map((entry) => entry.id),
  ).toEqual(["a", "b", "c"]);
  expect(
    runningChildrenForRail(children, { sessionId: "lead" }, 1).map((entry) => entry.id),
  ).toEqual(["a"]);
});

test("runningChildrenForRail ignores the workspace when the ref has none", () => {
  const children = [child("a", { parentWorkspaceId: "other-ws" })];
  expect(runningChildrenForRail(children, { sessionId: "lead" }).map((entry) => entry.id)).toEqual([
    "a",
  ]);
});

test("runningChildrenForRail returns an empty list when nothing runs", () => {
  expect(
    runningChildrenForRail([child("a", { status: "complete" })], { sessionId: "lead" }),
  ).toEqual([]);
  expect(runningChildrenForRail([], { sessionId: "lead" })).toEqual([]);
});

test("childOutputSnippet collapses blank runs and strips trailing whitespace", () => {
  expect(childOutputSnippet("  hello  \n\n\nworld   \n\n")).toBe("  hello\n\nworld");
});

test("childOutputSnippet truncates at maxLines", () => {
  expect(childOutputSnippet("one\ntwo\nthree\nfour", 2, 240)).toBe("one\ntwo");
});

test("childOutputSnippet truncates at maxChars", () => {
  const snippet = childOutputSnippet("abcdefghij", 3, 5);
  expect(snippet.length).toBeLessThanOrEqual(5);
  expect("abcdefghij".startsWith(snippet.replace(/…$/, ""))).toBe(true);
});

test("childOutputSnippet returns an empty string for blank input", () => {
  expect(childOutputSnippet("")).toBe("");
  expect(childOutputSnippet("   \n\n  \n")).toBe("");
});
