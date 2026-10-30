import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { collectExportTurns, MuseCliDriver } from "../dist/index.js";

const turnFixture = fileURLToPath(
  new URL("./fixtures/turn-end-loaded-deltas.jsonl", import.meta.url),
);
const exportFixture = fileURLToPath(
  new URL("./fixtures/export-commentary-final.json", import.meta.url),
);

// Trimmed from a real `muse exec --json` stream (/tmp/muse-9a.jsonl): one turn
// with tool lifecycles first and every assistant delta, usage and the terminal
// record clustered at the end. The failing sidekick run (/tmp/muse-child-test.json,
// same binary family) has the same shape.
await test("one turn emits the pi-parity sequence with exactly one runCompleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-replay-"));
  const binaryPath = join(dir, "muse");
  writeFileSync(binaryPath, `#!/bin/sh\ncat '${turnFixture}'\n`, { mode: 0o755 });
  chmodSync(binaryPath, 0o755);
  const driver = new MuseCliDriver({ binaryPath });
  const snapshot = await driver.createSession({ workspaceId: "ws", path: tmpdir() });
  const events: SessionDriverEvent[] = [];
  const unsubscribe = driver.subscribe(snapshot.ref, (event) => {
    events.push(event);
  });
  try {
    await driver.sendUserMessage(snapshot.ref, { text: "Report back with: Result" });
    const terminal = await waitForTerminal(events);
    assert.equal(terminal.type, "runCompleted");
    if (terminal.type !== "runCompleted") {
      return;
    }

    const types = events.map((event) => event.type);
    // Pi parity: the run announces itself running before any response row,
    // so the child reads `running` (not `responded`/`complete`) mid-turn.
    assert.equal(types[0], "sessionUpdated");
    const first = events[0];
    assert.equal(first?.type, "sessionUpdated");
    if (first?.type === "sessionUpdated") {
      assert.equal(first.snapshot.status, "running");
      assert.ok(first.snapshot.runningRunId);
    }
    // Exactly one assistant bubble for the turn, opened when text starts.
    assert.equal(types.filter((type) => type === "assistantMessageStarted").length, 1);
    const startedAt = types.indexOf("assistantMessageStarted");
    const firstToolAt = types.findIndex(
      (type) => type === "toolStarted" || type === "toolFinished",
    );
    assert.ok(startedAt > firstToolAt);
    // One completion, carrying the final text; nothing failed.
    assert.equal(types.filter((type) => type === "runCompleted").length, 1);
    assert.ok(!types.includes("runFailed"));
    assert.match(terminal.snapshot.preview ?? "", /Two commits/);

    const deltas = events.filter((event) => event.type === "assistantDelta");
    assert.ok(deltas.length > 0);
    const streamed = deltas
      .map((event) => (event as Extract<SessionDriverEvent, { type: "assistantDelta" }>).text)
      .join("");
    const transcript = await driver.getTranscript(snapshot.ref);
    const assistant = transcript.filter(
      (item) => item.kind === "message" && item.role === "assistant",
    );
    assert.equal(assistant.length, 1);
    assert.equal(streamed, (assistant[0] as { text: string }).text);
    assert.match((assistant[0] as { text: string }).text, /Two commits/);
  } finally {
    unsubscribe();
    await driver.closeSession(snapshot.ref);
  }
});

// The failing sidekick's `muse export` (/tmp/muse-child-test.json), trimmed to
// the run plus its tool tasks: commentary and final assistant_message_committed
// rows plus the terminal record. The rebuild must keep every text row.
await test("export rebuild keeps commentary and final text with tool rows", async () => {
  const raw = readFileSync(exportFixture, "utf8");
  const turns = collectExportTurns(JSON.parse(raw) as Parameters<typeof collectExportTurns>[0]);
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.ok(turn);
  assert.match(turn.prompt, /sidekick-runtime/);
  assert.match(turn.text, /Routing rules for sidekick children/);
  assert.match(turn.text, /Result:/);
  assert.deepEqual(
    turn.tools.map((tool) => `${tool.toolName}:${tool.success}`),
    ["read_file:true", "search:true", "bash:true", "read_file:true", "bash:true", "bash:true"],
  );
  assert.equal(turn.terminal?.status, "completed");
  assert.ok(turn.usage.inputTokens > 0);
});

// The configured sidekick is `muse-spark-1.3-contributor`; the live
// `run_usage` echoes that id back while the export's `model_completed`
// reports the base `muse-spark-1.3`. The driver must pass --model through
// exactly and let Muse report whatever it reports.
await test("--model passes the configured id through exactly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-argv-"));
  const binaryPath = join(dir, "muse");
  const argvFile = join(dir, "argv");
  const terminalRecord = JSON.stringify({
    schema_version: 1,
    id: "t1",
    stream: { kind: "session", id: "s" },
    sequence: 1,
    recorded_at: 0,
    record_type: "event",
    durability: "durable",
    causation_id: "cmd-1",
    payload_type: "run.lifecycle.terminal",
    payload_schema_version: 1,
    payload: { kind: "run_terminal", command_id: "cmd-1", terminal: "completed", text: "ok" },
  });
  writeFileSync(
    binaryPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nprintf '%s\\n' '${terminalRecord}'\n`,
    { mode: 0o755 },
  );
  chmodSync(binaryPath, 0o755);
  const driver = new MuseCliDriver({ binaryPath });
  const snapshot = await driver.createSession({ workspaceId: "ws", path: tmpdir() });
  const events: SessionDriverEvent[] = [];
  const unsubscribe = driver.subscribe(snapshot.ref, (event) => {
    events.push(event);
  });
  try {
    await driver.setSessionModel(snapshot.ref, {
      provider: "meta",
      modelId: "muse-spark-1.3-contributor",
    });
    await driver.sendUserMessage(snapshot.ref, { text: "hi" });
    const terminal = await waitForTerminal(events);
    assert.equal(terminal.type, "runCompleted");
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    const modelAt = argv.indexOf("--model");
    assert.ok(modelAt >= 0);
    assert.equal(argv[modelAt + 1], "muse-spark-1.3-contributor");
  } finally {
    unsubscribe();
    await driver.closeSession(snapshot.ref);
  }
});

async function waitForTerminal(
  events: SessionDriverEvent[],
  timeoutMs = 30_000,
): Promise<SessionDriverEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const terminal = events.find(
      (event) => event.type === "runCompleted" || event.type === "runFailed",
    );
    if (terminal) {
      return terminal;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for run terminal; saw: ${events.map((event) => event.type).join(",")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
