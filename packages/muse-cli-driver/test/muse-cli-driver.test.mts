import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import {
  MuseCliDriver,
  museBinaryAvailable,
  reasoningEffortOf,
  resolveMuseBinaryPath,
  worktreeExistingPathOf,
} from "../dist/index.js";

await test("reasoning effort maps pi thinking levels onto --reasoning-effort", () => {
  assert.equal(reasoningEffortOf(undefined), undefined);
  assert.equal(reasoningEffortOf("off"), "none");
  assert.equal(reasoningEffortOf("minimal"), "minimal");
  assert.equal(reasoningEffortOf("high"), "high");
  assert.equal(reasoningEffortOf("max"), "max");
  assert.equal(reasoningEffortOf("turbo"), undefined);
});

await test("only linked git worktrees take -w existing", () => {
  assert.equal(worktreeExistingPathOf(""), undefined);
  assert.equal(worktreeExistingPathOf(tmpdir()), undefined);
});

await test("binary resolution prefers PATH, then ~/.local/bin/muse", () => {
  assert.equal(resolveMuseBinaryPath("/custom/muse"), "/custom/muse");
  assert.equal(typeof resolveMuseBinaryPath(), "string");
  assert.equal(typeof museBinaryAvailable("definitely-not-a-binary-xyz"), "boolean");
});

await test("unsupported operations reject with a clear error", async () => {
  const driver = new MuseCliDriver({ provider: "echo" });
  const workspace = { workspaceId: "ws", path: tmpdir() };
  const snapshot = await driver.createSession(workspace, { title: "t" });
  await assert.rejects(driver.forkSession(snapshot.ref, { targetWorkspace: workspace }), /fork/);
  await assert.rejects(
    driver.validateForkSession(snapshot.ref, { targetWorkspace: workspace }),
    /fork/,
  );
  await assert.rejects(driver.compactSession(snapshot.ref), /compaction/);
  await assert.rejects(driver.getSessionTree(snapshot.ref), /tree navigation/);
  await assert.rejects(driver.navigateSessionTree(snapshot.ref, "x"), /tree navigation/);
  await assert.rejects(
    driver.respondToHostUiRequest(snapshot.ref, { requestId: "r", cancelled: true }),
    /approval/,
  );
  assert.deepEqual(await driver.getSessionCommands(snapshot.ref), []);
});

await test("cancel and rescue on an idle session settle immediately", async () => {
  const driver = new MuseCliDriver({ provider: "echo" });
  const snapshot = await driver.createSession({ workspaceId: "ws", path: tmpdir() });
  await driver.cancelCurrentRun(snapshot.ref);
  assert.deepEqual(await driver.rescueCurrentRun(snapshot.ref), { forced: false });
});

await test("cancel SIGTERMs the group and settles quietly to idle", async () => {
  const sleeper = stubBinary("sleep 30\n");
  const driver = new MuseCliDriver({ binaryPath: sleeper.binaryPath, killGraceMs: 200 });
  const workspace = { workspaceId: "ws", path: tmpdir() };
  const snapshot = await driver.createSession(workspace, { title: "sleeper" });
  const events: SessionDriverEvent[] = [];
  const unsubscribe = driver.subscribe(snapshot.ref, (event) => {
    events.push(event);
  });
  try {
    await driver.sendUserMessage(snapshot.ref, { text: "go to sleep" });
    await sleeper.ready();
    await driver.cancelCurrentRun(snapshot.ref);
    // Quiet like pi: a bare session update, no completion or failure.
    // Settling rides the exit event, so it lands just after cancel resolves.
    await waitForEvent(events, "sessionUpdated");
    assert.ok(!events.some((event) => event.type === "runFailed"));
    const transcript = await driver.getTranscript(snapshot.ref);
    assert.ok(transcript.some((item) => item.kind === "message"));
  } finally {
    unsubscribe();
    await driver.closeSession(snapshot.ref);
  }
});

await test("rescue SIGKILLs a TERM-ignoring tree and reports forced", async () => {
  const stub = stubBinary("trap '' TERM\nwhile true; do sleep 1; done\n");
  const driver = new MuseCliDriver({ binaryPath: stub.binaryPath, killGraceMs: 200 });
  const workspace = { workspaceId: "ws", path: tmpdir() };
  const snapshot = await driver.createSession(workspace, { title: "stubborn" });
  try {
    await driver.sendUserMessage(snapshot.ref, { text: "hang" });
    // Wait until the trap is installed; a TERM during startup would kill
    // the shell before it can ignore the signal.
    await stub.ready();
    const outcome = await driver.rescueCurrentRun(snapshot.ref, { abortTimeoutMs: 200 });
    assert.deepEqual(outcome, { forced: true });
  } finally {
    await driver.closeSession(snapshot.ref);
  }
});

await test("rescue rejects a non-positive abort timeout", async () => {
  const driver = new MuseCliDriver({ provider: "echo" });
  const snapshot = await driver.createSession({ workspaceId: "ws", path: tmpdir() });
  await assert.rejects(driver.rescueCurrentRun(snapshot.ref, { abortTimeoutMs: 0 }), /positive/);
});

function stubBinary(body: string): { binaryPath: string; ready(): Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "muse-stub-"));
  const binaryPath = join(dir, "muse");
  const readyFile = join(dir, "ready");
  writeFileSync(binaryPath, `#!/bin/sh\necho ready > ${readyFile}\n${body}`, { mode: 0o755 });
  chmodSync(binaryPath, 0o755);
  return {
    binaryPath,
    async ready(): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          readFileSync(readyFile, "utf8");
          return;
        } catch {
          if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for stub ${binaryPath} to start.`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    },
  };
}

async function waitForEvent(events: SessionDriverEvent[], type: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (events.some((event) => event.type === type)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${type}; saw: ${events.map((event) => event.type).join(",")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

await test("echo turn runs to completion and rebuilds via export", async (t) => {
  if (!museBinaryAvailable(resolveMuseBinaryPath())) {
    t.skip("muse binary not installed");
    return;
  }
  // Hermetic session store: the sandbox (and CI) may not let muse write home.
  const home = mkdtempSync(join(tmpdir(), "muse-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await runEchoTurns();
  } finally {
    process.env.HOME = previousHome;
  }
});

async function runEchoTurns(): Promise<void> {
  const workspacePath = mkdtempSync(join(tmpdir(), "muse-ws-"));
  const sessionFileDir = mkdtempSync(join(tmpdir(), "muse-sessions-"));
  const driver = new MuseCliDriver({ provider: "echo", sessionFileDir });
  const events: SessionDriverEvent[] = [];
  const snapshot = await driver.createSession(
    { workspaceId: "ws-echo", path: workspacePath },
    { title: "echo child" },
  );
  const unsubscribe = driver.subscribe(snapshot.ref, (event) => {
    events.push(event);
  });
  try {
    await driver.sendUserMessage(snapshot.ref, { text: "Reply with the single word ok." });
    const first = await waitForTerminal(events);
    assert.equal(first.type, "runCompleted");
    const completed = first as Extract<SessionDriverEvent, { type: "runCompleted" }>;
    assert.match(completed.snapshot.preview ?? "", /ok/);
    assert.equal(completed.snapshot.status, "idle");
    assert.ok(events.some((event) => event.type === "assistantDelta"));

    // Follow-up continues the same Muse session.
    events.length = 0;
    await driver.sendUserMessage(snapshot.ref, { text: "Say ok again." });
    const second = await waitForTerminal(events);
    assert.equal(second.type, "runCompleted");

    const transcript = await driver.getTranscript(snapshot.ref);
    const roles = transcript
      .filter((item) => item.kind === "message")
      .map((item) => (item as { role: string }).role);
    assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);

    // A fresh driver instance rebuilds the transcript via `muse export`.
    const reopened = new MuseCliDriver({ provider: "echo", sessionFileDir });
    const rebuilt = await reopened.openSession(snapshot.ref);
    assert.equal(rebuilt.status, "idle");
    const rebuiltTranscript = await reopened.getTranscript(snapshot.ref);
    assert.ok(rebuiltTranscript.length >= 4);
    const rebuiltText = rebuiltTranscript
      .filter((item) => item.kind === "message")
      .map((item) => (item as { text: string }).text)
      .join("\n");
    assert.match(rebuiltText, /Reply with the single word ok/);
  } finally {
    unsubscribe();
    await driver.closeSession(snapshot.ref);
  }
}

async function waitForTerminal(
  events: SessionDriverEvent[],
  timeoutMs = 120_000,
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
