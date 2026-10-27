import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionQuota, SessionQuotaLimit } from "@pi-gui/session-driver";

/**
 * Subscription quota from the `muse` CLI (`muse usage --json`). The CLI owns
 * auth, so this only parses percentages. Mirrors the wire handling in
 * examples/desktop-extensions/muse-usage/quota.ts (which stays view-gated);
 * this copy feeds the shared usage snapshot on a slow TTL so the composer
 * ring can show quota without opening any view.
 */

const QUOTA_TTL_MS = 10 * 60 * 1000;
const SPAWN_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

let cached: { at: number; bin: string; quota: SessionQuota | undefined } | null = null;
let resolvedBin: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** MUSE_BIN wins (tests), then ~/.local/bin/muse, then PATH lookup. */
function resolveMuseBin(): string {
  if (resolvedBin) return resolvedBin;
  const override = process.env.MUSE_BIN?.trim();
  if (override) {
    resolvedBin = override;
    return resolvedBin;
  }
  const local = join(homedir(), ".local", "bin", "muse");
  resolvedBin = existsSync(local) ? local : "muse";
  return resolvedBin;
}

/** Test seam: resets the binary and quota caches. */
export function resetSessionQuotaCache(): void {
  cached = null;
  resolvedBin = null;
}

function toLimit(value: unknown): SessionQuotaLimit | null {
  if (!isRecord(value)) return null;
  if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return null;
  const resetsAtMs = typeof value.resetsAtMs === "number" ? value.resetsAtMs : null;
  return { usedPercent: value.usedPercent, resetsAtMs };
}

/** Parses `muse usage --json` stdout. Never throws; failures yield undefined. */
export function parseSessionQuotaOutput(stdout: string, now: number): SessionQuota | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const allowance = isRecord(parsed.allowance) ? parsed.allowance : null;
  if (!allowance) return undefined;
  const tier = typeof allowance.tier === "string" && allowance.tier ? allowance.tier : null;
  const window = toLimit(allowance.window);
  const weekly = toLimit(allowance.weekly);
  if (!window && !weekly) return undefined;
  return {
    tier,
    window,
    weekly,
    fetchedAt: now,
    error: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : null,
  };
}

async function fetchSessionQuota(now: number): Promise<SessionQuota | undefined> {
  const bin = resolveMuseBin();
  try {
    const { stdout } = await execFileAsync(bin, ["usage", "--json"], {
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    return parseSessionQuotaOutput(stdout, now);
  } catch {
    return undefined;
  }
}

/**
 * Last-known quota (user-global). Synchronous for turn-boundary snapshots;
 * call refreshSessionQuotaSoon alongside to keep it warm.
 */
export function currentSessionQuota(): SessionQuota | undefined {
  return cached?.quota;
}

/**
 * Refreshes the quota in the background when the TTL expired. Never throws
 * and never blocks the snapshot: the next turn boundary picks up the result,
 * mirroring how provider plan limits attach.
 */
export function refreshSessionQuotaSoon(now = Date.now()): void {
  const bin = resolveMuseBin();
  if (cached && now - cached.at < QUOTA_TTL_MS && cached.bin === bin) return;
  // Mark fetching so concurrent turns share one flight; cleared on settle.
  const pendingAt = now;
  cached = { at: pendingAt, bin, quota: cached?.bin === bin ? cached?.quota : undefined };
  void fetchSessionQuota(now)
    .then((quota) => {
      cached = { at: pendingAt, bin, quota };
    })
    .catch(() => {
      // Keep the previous value on failure; a later boundary retries after TTL.
    });
}
