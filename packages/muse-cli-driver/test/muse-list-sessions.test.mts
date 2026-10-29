import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MuseCliDriver } from "../dist/index.js";

function stubSleepBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-stub-"));
  const binaryPath = join(dir, "muse");
  writeFileSync(binaryPath, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

await test("listSessions reports live records with authoritative status", async () => {
  const driver = new MuseCliDriver({
    binaryPath: stubSleepBinary(),
    sessionFileDir: mkdtempSync(join(tmpdir(), "muse-markers-")),
  });
  const workspace = { workspaceId: "ws", path: mkdtempSync(join(tmpdir(), "muse-ws-")) };
  const snapshot = await driver.createSession(workspace, { title: "sidekick" });
  try {
    const created = await driver.listSessions();
    assert.equal(created.sessions.length, 1);
    assert.equal(created.sessions[0]?.status, "idle");
    assert.equal(created.sessions[0]?.workspaceId, "ws");
    assert.ok(created.sessions[0]?.sessionFilePath);

    await driver.sendUserMessage(snapshot.ref, { text: "work" });
    const running = await driver.listSessions();
    assert.equal(running.sessions[0]?.status, "running");

    const filtered = await driver.listSessions("other-workspace");
    assert.equal(filtered.sessions.length, 0);
  } finally {
    await driver.closeSession(snapshot.ref);
  }
});

await test("listSessions falls back to marker files after a restart", async () => {
  const sessionFileDir = mkdtempSync(join(tmpdir(), "muse-markers-"));
  const first = new MuseCliDriver({ provider: "echo", sessionFileDir });
  const workspace = { workspaceId: "ws", path: mkdtempSync(join(tmpdir(), "muse-ws-")) };
  const snapshot = await first.createSession(workspace, { title: "sidekick" });
  await first.closeSession(snapshot.ref);

  const marker = JSON.parse(
    readFileSync(join(sessionFileDir, `${snapshot.ref.sessionId}.json`), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(marker.workspaceId, "ws");

  const reopened = new MuseCliDriver({ provider: "echo", sessionFileDir });
  const listed = await reopened.listSessions();
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0]?.workspaceId, "ws");
  assert.equal(listed.sessions[0]?.status, "idle");
});

await test("listSessions skips version-1 markers and junk files", async () => {
  const sessionFileDir = mkdtempSync(join(tmpdir(), "muse-markers-"));
  writeFileSync(
    join(sessionFileDir, "old.json"),
    JSON.stringify({ version: 1, museSessionId: "old", title: "old", updatedAt: "t" }),
    "utf8",
  );
  writeFileSync(join(sessionFileDir, "junk.json"), "not json", "utf8");
  writeFileSync(join(sessionFileDir, "notes.txt"), "hello", "utf8");
  const driver = new MuseCliDriver({ provider: "echo", sessionFileDir });
  const listed = await driver.listSessions();
  assert.equal(listed.sessions.length, 0);
});

await test("listSessions on a missing marker dir is empty", async () => {
  const driver = new MuseCliDriver({
    provider: "echo",
    sessionFileDir: join(mkdtempSync(join(tmpdir(), "muse-parent-")), "missing"),
  });
  const listed = await driver.listSessions();
  assert.equal(listed.sessions.length, 0);
});
