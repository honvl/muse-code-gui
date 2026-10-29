import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MspTurnCollector, collectExportTurns, toSessionUsageSnapshot } from "../dist/index.js";
import { parseMspLine } from "../dist/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function recordsOf(name: string) {
  return readFileSync(join(fixturesDir, name), "utf8")
    .split("\n")
    .map(parseMspLine)
    .filter((record) => record !== undefined);
}

function collect(name: string): MspTurnCollector {
  const collector = new MspTurnCollector();
  for (const record of recordsOf(name)) {
    collector.ingest(record);
  }
  return collector;
}

await test("turn1 fixture maps to one assistant delta, usage and completed terminal", () => {
  const collector = collect("turn1.jsonl");
  assert.equal(collector.mappedPrompt, "Reply with the single word ok.");
  assert.equal(collector.assistantText, "ok");
  assert.equal(collector.drainDelta(), "ok");
  assert.equal(collector.drainDelta(), "");

  // The fixture's tasks are reminder.* and model.* internals: no tool rows.
  assert.deepEqual([...collector.pendingToolEvents], []);

  const usage = collector.mappedUsage;
  assert.equal(usage.model, "muse-spark-1.3-contributor");
  assert.equal(usage.inputTokens, 27399);
  assert.equal(usage.cachedTokens, 8305);
  assert.equal(usage.outputTokens, 16);
  assert.equal(usage.reasoningTokens, 6);
  assert.equal(usage.allowance?.weekly?.used_percent, 92);

  assert.deepEqual(collector.mappedTerminal, { status: "completed", text: "ok", reason: null });

  const snapshot = toSessionUsageSnapshot(usage);
  assert.equal(snapshot.subscription, true);
  assert.deepEqual(snapshot.totals, {
    input: 27399,
    output: 16,
    cacheRead: 8305,
    cacheWrite: 0,
    cost: 0,
  });
  assert.equal(snapshot.quota?.weekly?.usedPercent, 92);
});

await test("turn2 follow-up recalls the first turn and shows cached tokens", () => {
  const collector = collect("turn2-followup.jsonl");
  assert.equal(
    collector.mappedPrompt,
    "What single word did you reply with in your previous turn? Answer with just that word.",
  );
  assert.equal(collector.assistantText, "ok");
  assert.deepEqual([...collector.pendingToolEvents], []);
  // Same session continued: the prefix is served from cache.
  assert.ok(collector.mappedUsage.cachedTokens > 10000);
  assert.deepEqual(collector.mappedTerminal, { status: "completed", text: "ok", reason: null });
});

await test("tool-kind lifecycles become toolStarted/toolFinished, reminders do not", () => {
  const collector = new MspTurnCollector();
  const lines = [
    // Reminder internals never become tool rows.
    lifecycle("task-1", "proposed", { task_kind: "reminder.agent.skill-reminder" }),
    lifecycle("task-1", "started", {}),
    lifecycle("task-1", "completed", {}),
    // A tool call: kind declared on proposed, finish carries only the task id.
    lifecycle("task-2", "proposed", { task_kind: "tool.read" }),
    lifecycle("task-2", "side_effect_intent", { operation: "tool.read" }),
    lifecycle("task-2", "started", {}),
    lifecycle("task-2", "completed", {}),
    // A failed tool call.
    lifecycle("task-3", "proposed", { task_kind: "tool.bash" }),
    lifecycle("task-3", "started", {}),
    lifecycle("task-3", "failed", { reason: "exit 1" }),
    // Model steps are not tool calls either.
    lifecycle("task-4", "proposed", { task_kind: "model.meta.response" }),
    lifecycle("task-4", "started", {}),
    lifecycle("task-4", "completed", {}),
  ];
  for (const line of lines) {
    const record = parseMspLine(line);
    assert.ok(record);
    collector.ingest(record);
  }
  assert.deepEqual(
    [...collector.pendingToolEvents],
    [
      { type: "toolStarted", toolName: "read", callId: "task-2" },
      { type: "toolFinished", toolName: "read", callId: "task-2", success: true },
      { type: "toolStarted", toolName: "bash", callId: "task-3" },
      { type: "toolFinished", toolName: "bash", callId: "task-3", success: false },
    ],
  );
});

await test("failed and cancelled terminals map without defaulting to completed", () => {
  const failed = new MspTurnCollector();
  failed.ingest(terminal("failed", "", "boom"));
  assert.deepEqual(failed.mappedTerminal, { status: "failed", text: "", reason: "boom" });

  const cancelled = new MspTurnCollector();
  cancelled.ingest(terminal("cancelled", "partial", null));
  assert.deepEqual(cancelled.mappedTerminal, {
    status: "cancelled",
    text: "partial",
    reason: null,
  });

  const unknown = new MspTurnCollector();
  unknown.ingest(terminal("weird", "done", null));
  assert.equal(unknown.mappedTerminal?.status, "completed");
});

await test("unparseable and foreign-schema lines are ignored", () => {
  assert.equal(parseMspLine(""), undefined);
  assert.equal(parseMspLine("not json"), undefined);
  assert.equal(parseMspLine('{"schema_version":2,"payload_type":"x"}'), undefined);
  const collector = new MspTurnCollector();
  collector.ingest({
    schema_version: 1,
    id: "x",
    stream: { kind: "session", id: "s" },
    sequence: 1,
    recorded_at: 0,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: "something.new",
    payload_schema_version: 1,
    payload: { kind: "something_new" },
  });
  assert.equal(collector.assistantText, "");
  assert.equal(collector.mappedTerminal, undefined);
});

await test("export documents rebuild per-turn prompts, texts, tools and usage", () => {
  const turns = collectExportTurns({
    events: [
      { envelope: runEnvelope("run-1", { kind: "started", prompt: "first" }) },
      {
        envelope: taskEnvelope("task-1", {
          kind: "proposed",
          task_id: "task-1",
          task_kind: "reminder.agent.skill-reminder",
        }),
      },
      {
        envelope: runEnvelope("run-1", { kind: "assistant_message_committed", text: "a" }),
      },
      {
        envelope: runEnvelope("run-1", {
          kind: "model_completed",
          usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 3, reasoning_tokens: 1 },
        }),
      },
      { envelope: runEnvelope("run-1", { kind: "terminal", terminal: "completed", reason: null }) },
      { envelope: runEnvelope("run-2", { kind: "started", prompt: "second" }) },
      {
        envelope: taskEnvelope("task-9", {
          kind: "proposed",
          task_id: "task-9",
          task_kind: "tool.read",
        }),
      },
      {
        envelope: taskEnvelope("task-9", { kind: "completed", task_id: "task-9" }),
      },
      { envelope: runEnvelope("run-2", { kind: "assistant_message_committed", text: "b1" }) },
      { envelope: runEnvelope("run-2", { kind: "assistant_message_committed", text: "b2" }) },
      { envelope: runEnvelope("run-2", { kind: "terminal", terminal: "completed", reason: null }) },
      { envelope: undefined },
    ],
  });
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => [turn.runId, turn.prompt, turn.text]),
    [
      ["run-1", "first", "a"],
      ["run-2", "second", "b1b2"],
    ],
  );
  assert.deepEqual(turns[0]?.usage, {
    model: null,
    inputTokens: 10,
    cachedTokens: 3,
    outputTokens: 2,
    reasoningTokens: 1,
    calls: 1,
    allowance: null,
  });
  // Reminder tasks are not tool rows; tool.* tasks are.
  assert.deepEqual(turns[0]?.tools, []);
  assert.deepEqual(turns[1]?.tools, [{ callId: "task-9", toolName: "read", success: true }]);
  assert.deepEqual(turns[1]?.terminal, { status: "completed", text: "b1b2", reason: null });
});

const OPEN_BASH_CALL_ID = "01a1864f-43d4-7c40-b90f-c5da3bd8ce98";
const FAILED_BASH_CALL_ID = "01a1864b-679e-7400-9507-50e5d1d1461f";

await test("real-tool fixture maps names and pairs every started call", () => {
  const collector = collect("turn-tools.jsonl");
  const events = [...collector.pendingToolEvents];
  const started = events.filter((event) => event.type === "toolStarted");
  const finished = events.filter((event) => event.type === "toolFinished");

  assert.equal(started.length, 5);
  assert.deepEqual(
    started.map((event) => event.toolName),
    ["read_file", "bash", "edit_file", "bash", "bash"],
  );

  // Every started call has exactly one finish.
  const finishByCall = new Map(finished.map((event) => [event.callId, event]));
  assert.equal(finishByCall.size, 5);
  for (const event of started) {
    assert.ok(finishByCall.has(event.callId), `missing finish for ${event.callId}`);
  }

  // The failed call finishes unsuccessfully without the interrupted mark.
  const failed = finishByCall.get(FAILED_BASH_CALL_ID);
  assert.equal(failed?.success, false);
  assert.equal(failed?.interrupted, undefined);

  // The live_process bash call never reached a terminal record; the run
  // terminal closes it as interrupted instead of leaving it running.
  const open = finishByCall.get(OPEN_BASH_CALL_ID);
  assert.equal(open?.toolName, "bash");
  assert.equal(open?.success, false);
  assert.equal(open?.interrupted, true);
  assert.deepEqual(events.at(-1), open);

  // A second drain finds nothing left open.
  assert.deepEqual(collector.drainOpenTools(), []);

  assert.equal(collector.assistantText, "Done");
  assert.equal(collector.mappedTerminal?.status, "completed");
  assert.match(collector.mappedTerminal?.text ?? "", /^Done\. Two commits/);

  const usage = collector.mappedUsage;
  assert.equal(usage.model, "muse-spark-1.3-contributor");
  assert.equal(usage.inputTokens, 62146321);
  assert.equal(usage.cachedTokens, 61862227);
  assert.equal(usage.outputTokens, 154427);
  assert.equal(usage.reasoningTokens, 68778);
  assert.equal(usage.calls, 260);
  assert.equal(usage.allowance?.weekly?.used_percent, 93);
  assert.equal(toSessionUsageSnapshot(usage).subscription, true);
});

function lifecycle(taskId: string, kind: string, event: Record<string, unknown>): string {
  return JSON.stringify({
    schema_version: 1,
    id: `id-${taskId}-${kind}`,
    stream: { kind: "session", id: "session-1" },
    sequence: 1,
    recorded_at: 0,
    record_type: "event",
    durability: "durable",
    causation_id: "cmd-1",
    payload_type: `task.lifecycle.${kind}`,
    payload_schema_version: 1,
    payload: {
      kind: "task_lifecycle",
      command_id: "cmd-1",
      task_id: taskId,
      event: { kind, task_id: taskId, ...event },
    },
  });
}

function terminal(
  status: string,
  text: string,
  reason: string | null,
): ReturnType<typeof parseMspLine> & object {
  const record = parseMspLine(
    JSON.stringify({
      schema_version: 1,
      id: "terminal-1",
      stream: { kind: "session", id: "session-1" },
      sequence: 99,
      recorded_at: 0,
      record_type: "event",
      durability: "durable",
      causation_id: "cmd-1",
      payload_type: "run.terminal.completed",
      payload_schema_version: 1,
      payload: { kind: "run_terminal", command_id: "cmd-1", terminal: status, text, reason },
    }),
  );
  assert.ok(record);
  return record;
}

function runEnvelope(runId: string, event: Record<string, unknown>): unknown {
  return {
    schema_version: 1,
    id: `id-${runId}-${String(event.kind)}`,
    stream: { kind: "session", id: "session-1" },
    sequence: 1,
    recorded_at: 0,
    record_type: "event",
    durability: "durable",
    causation_id: runId,
    payload_type: "runtime.session",
    payload_schema_version: 1,
    payload: { kind: "run", run_id: runId, event },
  };
}

function taskEnvelope(taskId: string, event: Record<string, unknown>): unknown {
  return {
    schema_version: 1,
    id: `id-${taskId}-${String(event.kind)}`,
    stream: { kind: "session", id: "session-1" },
    sequence: 1,
    recorded_at: 0,
    record_type: "event",
    durability: "durable",
    causation_id: "run-1",
    payload_type: "runtime.session",
    payload_schema_version: 1,
    payload: { kind: "task", event },
  };
}
