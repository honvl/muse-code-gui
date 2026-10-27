import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { QuotaData, QuotaLimit } from "./contract.ts";

/**
 * Subscription allowance via the muse CLI (`muse usage --json`). The CLI owns
 * auth (same OAuth pi uses for the meta provider), so the extension never
 * handles credentials — it just parses percentages. Example wire shape:
 *
 *   {"schemaVersion":1,"allowance":{"tier":"Muse Code High Usage",
 *    "window":{"usedPercent":25,"resetsAtMs":1793050033000},
 *    "weekly":{"usedPercent":8,"resetsAtMs":1793577600000},
 *    "asOfMs":1793046994740,"source":"mint"},"reason":null,"hint":null}
 */

const QUOTA_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

let cached: { at: number; bin: string; data: QuotaData } | null = null;
let resolvedBin: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** MUSE_BIN wins (tests), then ~/.local/bin/muse, then PATH lookup. */
export function resolveMuseBin(): string {
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
export function resetQuotaCache(): void {
  cached = null;
  resolvedBin = null;
}

export function emptyQuota(): QuotaData {
  return { tier: null, window: null, weekly: null, fetchedAt: null, error: null };
}

function toLimit(value: unknown): QuotaLimit | null {
  if (!isRecord(value)) return null;
  if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return null;
  const resetsAtMs = typeof value.resetsAtMs === "number" ? value.resetsAtMs : null;
  return { usedPercent: value.usedPercent, resetsAtMs };
}

/** Parses `muse usage --json` stdout. Never throws; problems land in QuotaData.error. */
export function parseQuotaOutput(stdout: string, now: number): QuotaData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ...emptyQuota(), error: "Could not parse `muse usage --json` output." };
  }
  if (!isRecord(parsed))
    return { ...emptyQuota(), error: "Could not parse `muse usage --json` output." };
  const allowance = isRecord(parsed.allowance) ? parsed.allowance : null;
  if (!allowance) {
    const reason = typeof parsed.reason === "string" && parsed.reason ? parsed.reason : null;
    const hint = typeof parsed.hint === "string" && parsed.hint ? ` ${parsed.hint}` : "";
    return {
      ...emptyQuota(),
      error: reason ? `${reason}${hint}` : "No allowance in `muse usage` output.",
    };
  }
  const tier = typeof allowance.tier === "string" && allowance.tier ? allowance.tier : null;
  return {
    tier,
    window: toLimit(allowance.window),
    weekly: toLimit(allowance.weekly),
    fetchedAt: now,
    error: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : null,
  };
}

/** Fetches quota with a 60s cache. Never throws; failures land in QuotaData.error. */
export async function fetchQuota(now = Date.now()): Promise<QuotaData> {
  const bin = resolveMuseBin();
  if (cached && now - cached.at < QUOTA_TTL_MS && cached.bin === bin) return cached.data;
  let data: QuotaData;
  try {
    const { stdout } = await execFileAsync(bin, ["usage", "--json"], {
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    data = parseQuotaOutput(stdout, now);
  } catch (error) {
    data = {
      ...emptyQuota(),
      error: quotaErrorMessage(error, bin),
    };
  }
  cached = { at: now, bin, data };
  return data;
}

function quotaErrorMessage(error: unknown, bin: string): string {
  if (isRecord(error) && (error.code === "ENOENT" || error.errno === -2)) {
    return `muse CLI not found at ${bin} — install it or set MUSE_BIN.`;
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  if (/timed out|ETIMEDOUT/i.test(message)) return "`muse usage` timed out — retry Refresh.";
  const stderr =
    isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim().slice(0, 200) : "";
  return stderr ? `\`muse usage\` failed: ${stderr}` : `\`muse usage\` failed: ${message}`;
}
