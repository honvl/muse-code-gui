import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentId, scanAgentRuns, summarizeAgentEntries } from "../collect.ts";

const hour = 3_600_000;
const now = Date.parse("2026-10-26T12:00:00.000Z");

function callBlock(id: string, args: Record<string, unknown>, name = "agent"): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

function assistant(time: number, content: unknown[]): unknown {
  return {
    type: "message",
    timestamp: new Date(time).toISOString(),
    message: { role: "assistant", timestamp: time, provider: "meta", model: "m", content },
  };
}

function result(
  time: number,
  toolCallId: string,
  text: string,
  opts: { durationMs?: number; isError?: boolean } = {},
): unknown {
  return {
    type: "message",
    timestamp: new Date(time).toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "agent",
      content: [{ type: "text", text }],
      isError: opts.isError ?? false,
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      timestamp: time,
    },
  };
}

const ARGS = { description: "Find the file", prompt: "search", subagent_type: "explore" };

await test("pairs calls with results, extracting agentId and duration", async () => {
  const entries = [
    assistant(now - hour, [callBlock("call_1", ARGS)]),
    result(
      now - hour + 27_000,
      "call_1",
      "some output\n---\nagentId: 01a179d3-3639-7569-af89-48460908d6e3 (pass resume)",
      {
        durationMs: 27308,
      },
    ),
  ];
  const runs = scanAgentRuns("t1", "Thread", entries, false);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].description, "Find the file");
  assert.equal(runs[0].subagentType, "explore");
  assert.equal(runs[0].durationMs, 27308);
  assert.equal(runs[0].agentId, "01a179d3-3639-7569-af89-48460908d6e3");
  assert.equal(runs[0].endedAt, now - hour + 27_000);
});

await test("error results surface as errors", async () => {
  const entries = [
    assistant(now - hour, [callBlock("call_9", { description: "Doomed", prompt: "x" })]),
    result(now - hour + 1000, "call_9", "boom", { isError: true }),
  ];
  const runs = scanAgentRuns("t1", "Thread", entries, false);
  assert.equal(runs[0].status, "error");
});

await test("unpaired calls run in the current thread, rest as done", async () => {
  const entries = [assistant(now - 60_000, [callBlock("call_live", ARGS)])];
  const current = scanAgentRuns("t1", "Thread", entries, true);
  assert.equal(current[0].status, "running");
  const old = scanAgentRuns("t1", "Thread", entries, false);
  assert.equal(old[0].status, "done");
  assert.equal(old[0].durationMs, null);
});

await test("non-agent tools are ignored", async () => {
  const entries = [
    assistant(now - hour, [callBlock("call_b", { description: "x", prompt: "y" }, "bash")]),
    result(now - hour + 1000, "call_b", "ok"),
  ];
  assert.deepEqual(scanAgentRuns("t1", "Thread", entries, false), []);
});

await test("parseAgentId handles variants", async () => {
  assert.equal(
    parseAgentId("agentId: 01a179d3-3639-7569-af89-48460908d6e3 (pass"),
    "01a179d3-3639-7569-af89-48460908d6e3",
  );
  assert.equal(
    parseAgentId("AGENTID:ABCDEF12-3456-7890-ABCD-EF1234567890"),
    "ABCDEF12-3456-7890-ABCD-EF1234567890",
  );
  assert.equal(parseAgentId("no id here"), null);
  assert.equal(parseAgentId("agentId: not-a-uuid"), null);
});

await test("summarizeAgentEntries counts turns, tools, files and last message", async () => {
  const entries = [
    assistant(now - hour, [
      { type: "text", text: "Searching now" },
      { type: "toolCall", id: "a", name: "grep", arguments: { pattern: "foo" } },
      { type: "toolCall", id: "b", name: "read", arguments: { path: "/repo/src/a.ts" } },
    ]),
    {
      type: "message",
      timestamp: new Date(now - hour + 1000).toISOString(),
      message: {
        role: "assistant",
        timestamp: now - hour + 1000,
        content: [
          { type: "toolCall", id: "c", name: "read", arguments: { path: "/repo/src/b.ts" } },
        ],
        usage: { input: 10, output: 5 },
      },
    },
    assistant(now - hour + 2000, [{ type: "text", text: "Found it in a.ts" }]),
  ];
  const summary = summarizeAgentEntries(entries);
  assert.equal(summary.turns, 1);
  assert.equal(summary.toolCalls, 3);
  assert.deepEqual(summary.topTools[0], { name: "read", count: 2 });
  assert.deepEqual(summary.filesTouched, ["/repo/src/a.ts", "/repo/src/b.ts"]);
  assert.equal(summary.lastMessage, "Found it in a.ts");
});

await test("malformed entries never throw", async () => {
  assert.deepEqual(scanAgentRuns("t1", "T", [null, 42, "x"], false), []);
  assert.deepEqual(summarizeAgentEntries([null, { type: "message" }]), {
    turns: 0,
    toolCalls: 0,
    topTools: [],
    filesTouched: [],
    lastMessage: "",
  });
});
