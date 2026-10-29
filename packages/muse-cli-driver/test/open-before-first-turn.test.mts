import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseCliDriver } from "../dist/index.js";

// A stub `muse` whose export always fails, like a session Muse hasn't written yet.
function stubBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-stub-"));
  const bin = join(dir, "muse");
  writeFileSync(bin, "#!/bin/sh\necho 'no such session' >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  return bin;
}

test("openSession right after createSession returns the empty session instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-ws-"));
  const driver = new MuseCliDriver({ binaryPath: stubBinary() } as never);
  const workspace = { workspaceId: dir, path: dir, displayName: "ws" } as never;
  const created = await driver.createSession(workspace, { title: "child" } as never);
  const opened = await driver.openSession(created.ref);
  assert.equal(opened.ref.sessionId, created.ref.sessionId);
  assert.equal(opened.status, "idle");
});
