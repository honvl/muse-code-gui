import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchQuota, parseQuotaOutput, resetQuotaCache } from "../quota.ts";

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

await test("parses the real `muse usage --json` shape", async () => {
  const quota = parseQuotaOutput(REAL_SHAPE, now);
  assert.equal(quota.tier, "Muse Code High Usage");
  assert.equal(quota.window?.usedPercent, 25);
  assert.equal(quota.window?.resetsAtMs, 1793050033000);
  assert.equal(quota.weekly?.usedPercent, 8);
  assert.equal(quota.fetchedAt, now);
  assert.equal(quota.error, null);
});

await test("surfaces reason when allowance is missing", async () => {
  const quota = parseQuotaOutput(
    JSON.stringify({ allowance: null, reason: "logged out", hint: "run login" }),
    now,
  );
  assert.equal(quota.window, null);
  assert.match(quota.error ?? "", /logged out/);
});

await test("rejects malformed output and invalid buckets", async () => {
  assert.match(parseQuotaOutput("not json", now).error ?? "", /parse/i);
  assert.match(parseQuotaOutput("[1,2]", now).error ?? "", /allowance/i);
  const partial = parseQuotaOutput(
    JSON.stringify({ allowance: { tier: "T", window: { usedPercent: "x" } } }),
    now,
  );
  assert.equal(partial.tier, "T");
  assert.equal(partial.window, null);
});

async function scriptBin(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muse-bin-"));
  const path = join(dir, "muse");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

await test("fetchQuota spawns the CLI and caches", async () => {
  resetQuotaCache();
  const bin = await scriptBin(`process.stdout.write(${JSON.stringify(REAL_SHAPE)});`);
  const previous = process.env.MUSE_BIN;
  process.env.MUSE_BIN = bin;
  try {
    const first = await fetchQuota(now);
    assert.equal(first.tier, "Muse Code High Usage");
    assert.equal(first.window?.usedPercent, 25);
    // Second call within TTL returns the cached object without re-spawning.
    const second = await fetchQuota(now + 1000);
    assert.equal(second, first);
  } finally {
    if (previous === undefined) delete process.env.MUSE_BIN;
    else process.env.MUSE_BIN = previous;
    resetQuotaCache();
  }
});

await test("fetchQuota reports a missing binary without throwing", async () => {
  resetQuotaCache();
  const previous = process.env.MUSE_BIN;
  process.env.MUSE_BIN = `/nonexistent/muse-${Date.now()}`;
  try {
    const quota = await fetchQuota(now);
    assert.equal(quota.window, null);
    assert.match(quota.error ?? "", /not found/i);
  } finally {
    if (previous === undefined) delete process.env.MUSE_BIN;
    else process.env.MUSE_BIN = previous;
    resetQuotaCache();
  }
});

await test("fetchQuota surfaces CLI stderr on failure", async () => {
  resetQuotaCache();
  const bin = await scriptBin(`process.stderr.write("boom\\\\n"); process.exit(3);`);
  const previous = process.env.MUSE_BIN;
  process.env.MUSE_BIN = bin;
  try {
    const quota = await fetchQuota(now);
    assert.match(quota.error ?? "", /boom/);
  } finally {
    if (previous === undefined) delete process.env.MUSE_BIN;
    else process.env.MUSE_BIN = previous;
    resetQuotaCache();
  }
});
