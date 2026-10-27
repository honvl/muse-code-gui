import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  currentSessionQuota,
  parseSessionQuotaOutput,
  refreshSessionQuotaSoon,
  resetSessionQuotaCache,
} from "../dist/session-quota.js";

const now = 1793046994740;
const REAL_SHAPE = JSON.stringify({
  schemaVersion: 1,
  allowance: {
    tier: "Muse Code High Usage",
    window: { usedPercent: 25, resetsAtMs: 1793050033000 },
    weekly: { usedPercent: 8, resetsAtMs: 1793577600000 },
    asOfMs: 1793046994740,
    source: "mint",
  },
  reason: null,
  hint: null,
});

await test("parses the real `muse usage --json` shape", () => {
  const quota = parseSessionQuotaOutput(REAL_SHAPE, now);
  assert.equal(quota?.tier, "Muse Code High Usage");
  assert.equal(quota?.window?.usedPercent, 25);
  assert.equal(quota?.window?.resetsAtMs, 1793050033000);
  assert.equal(quota?.weekly?.usedPercent, 8);
  assert.equal(quota?.fetchedAt, now);
  assert.equal(quota?.error, null);
});

await test("rejects output without usable buckets", () => {
  assert.equal(parseSessionQuotaOutput("not json", now), undefined);
  assert.equal(parseSessionQuotaOutput("[1,2]", now), undefined);
  assert.equal(
    parseSessionQuotaOutput(JSON.stringify({ allowance: { tier: "T" } }), now),
    undefined,
  );
});

async function scriptBin(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muse-bin-"));
  const path = join(dir, "muse");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

await test("refresh populates the shared cache without throwing when the CLI is missing", async () => {
  resetSessionQuotaCache();
  const previous = process.env.MUSE_BIN;
  process.env.MUSE_BIN = join(tmpdir(), "definitely-not-a-muse-binary");
  try {
    refreshSessionQuotaSoon(now);
    // The spawn settles asynchronously; the snapshot simply omits quota meanwhile.
    assert.equal(currentSessionQuota(), undefined);
  } finally {
    if (previous === undefined) delete process.env.MUSE_BIN;
    else process.env.MUSE_BIN = previous;
    resetSessionQuotaCache();
  }
});

await test("refresh fetches through MUSE_BIN and caches within TTL", async () => {
  resetSessionQuotaCache();
  const bin = await scriptBin(`process.stdout.write(${JSON.stringify(REAL_SHAPE)});`);
  const previous = process.env.MUSE_BIN;
  process.env.MUSE_BIN = bin;
  try {
    refreshSessionQuotaSoon(now);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const first = currentSessionQuota();
    assert.equal(first?.window?.usedPercent, 25);
    // A second refresh inside the TTL keeps the cached value without re-spawning.
    refreshSessionQuotaSoon(now + 1000);
    assert.equal(currentSessionQuota(), first);
  } finally {
    if (previous === undefined) delete process.env.MUSE_BIN;
    else process.env.MUSE_BIN = previous;
    resetSessionQuotaCache();
  }
});
