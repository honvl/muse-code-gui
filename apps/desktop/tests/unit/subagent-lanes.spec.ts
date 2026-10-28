import { expect, test } from "@playwright/test";
import {
  subagentLanesFromTranscript,
  subagentSessionName,
  SUBAGENT_TOOL_NAMES,
} from "../../src/features/threads/subagent-lanes";
import type { TranscriptMessage } from "../../contracts/timeline-types";

function toolRow(overrides: Record<string, unknown> = {}): TranscriptMessage {
  return {
    kind: "tool",
    id: "row-1",
    callId: "call-1",
    toolName: "agent",
    status: "success",
    label: "agent",
    createdAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  } as TranscriptMessage;
}

test("SUBAGENT_TOOL_NAMES covers the third-party agent tool", () => {
  expect([...SUBAGENT_TOOL_NAMES]).toEqual(["agent"]);
});

test("running agent rows become running lanes without detail text", () => {
  const lanes = subagentLanesFromTranscript([
    toolRow({
      status: "running",
      input: { subagent_type: "explore", description: "Explore auth flow", prompt: "look around" },
    }),
  ]);
  expect(lanes).toHaveLength(1);
  expect(lanes[0]).toMatchObject({
    key: "call-1",
    type: "explore",
    description: "Explore auth flow",
    status: "running",
    activity: [],
    sessionName: "agent:explore: Explore auth flow",
  });
  expect(lanes[0]?.detailText).toBeUndefined();
});

test("settled rows read status, activity and branch from tool result details", () => {
  const lanes = subagentLanesFromTranscript([
    toolRow({
      input: { subagent_type: "general-purpose", description: "Fix bug" },
      output: {
        content: [{ type: "text", text: "done" }],
        details: {
          id: "agent-1",
          type: "plan",
          description: "Fix bug",
          status: "done",
          agentId: "session-uuid-1",
          activity: ["read: src/a.ts", "bash: pnpm test"],
          finalText: "The fix is…",
          elapsedMs: 12000,
          worktree: {
            repo: "/repo",
            dir: "/tmp/pi-subagent-agent-general-purpose-1-abcd",
            branch: "agent/general-purpose-1-abcd",
            kept: true,
          },
        },
      },
    }),
  ]);
  expect(lanes).toHaveLength(1);
  expect(lanes[0]).toMatchObject({
    type: "plan",
    description: "Fix bug",
    status: "complete",
    activity: ["read: src/a.ts", "bash: pnpm test"],
    branch: "agent/general-purpose-1-abcd",
    worktreeDir: "/tmp/pi-subagent-agent-general-purpose-1-abcd",
    worktreeKept: true,
    agentId: "session-uuid-1",
    sessionName: "agent:general-purpose: Fix bug",
    detailText: "The fix is…",
  });
});

test("error and cancelled details map to failed lanes with the error preview", () => {
  const lanes = subagentLanesFromTranscript([
    toolRow({
      callId: "call-err",
      status: "error",
      input: { description: "Bad run" },
      output: { details: { status: "error", error: "pi exited with code 1" } },
    }),
    toolRow({
      callId: "call-cancel",
      status: "success",
      input: { description: "Stopped run" },
      output: { details: { status: "cancelled", error: "Aborted by parent" } },
    }),
  ]);
  expect(lanes.map((lane) => [lane.key, lane.status, lane.detailText])).toEqual([
    ["call-err", "failed", "pi exited with code 1"],
    ["call-cancel", "failed", "Aborted by parent"],
  ]);
});

test("non-agent tools, pins and malformed rows are ignored; later duplicates win", () => {
  const lanes = subagentLanesFromTranscript([
    toolRow({ callId: "other", toolName: "bash", status: "success" }),
    { kind: "pin", id: "pin-1" } as unknown as TranscriptMessage,
    toolRow({ callId: "bad" , toolName: 42 } as unknown as Record<string, unknown>),
    toolRow({ callId: "dup", status: "running", input: { description: "First" } }),
    toolRow({
      callId: "dup",
      status: "success",
      input: { description: "Second" },
      output: { details: { status: "done", finalText: "done" } },
    }),
  ]);
  expect(lanes.map((lane) => [lane.key, lane.status])).toEqual([["dup", "complete"]]);
  expect(lanes[0]?.description).toBe("Second");
});

test("missing input falls back to general-purpose defaults", () => {
  const lanes = subagentLanesFromTranscript([toolRow({ input: undefined, output: undefined })]);
  expect(lanes[0]).toMatchObject({
    type: "general-purpose",
    description: "Subagent run",
    status: "complete",
  });
  expect(lanes[0]?.sessionName).toBe("agent:general-purpose: Subagent run");
});

test("subagentSessionName mirrors the extension's 80-char truncation", () => {
  expect(subagentSessionName("explore", "short")).toBe("agent:explore: short");
  const long = subagentSessionName("general-purpose", "x".repeat(100));
  expect(long).toBe(`agent:general-purpose: ${"x".repeat(100)}`.slice(0, 80));
  expect(long).toHaveLength(80);
});

test("empty or missing transcripts produce no lanes", () => {
  expect(subagentLanesFromTranscript(undefined)).toEqual([]);
  expect(subagentLanesFromTranscript([])).toEqual([]);
});

