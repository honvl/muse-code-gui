import type { SessionQuota, SessionQuotaLimit } from "@pi-gui/session-driver";

/** Shared text formatting for background-task and usage surfaces. */
/** Elapsed time after which a run counts as long-running everywhere. */
export const LONG_RUN_MS = 5 * 60 * 1000;

export function truncateCommand(command: string, limit = 80): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

export function formatElapsed(since: string | undefined, now: number = Date.now()): string {
  if (!since) {
    return "";
  }
  const startedAt = Date.parse(since);
  if (!Number.isFinite(startedAt)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

/** Quota tone shared by the composer ring glyph and usage surfaces. */
export function quotaTone(usedPercent: number): "ok" | "warm" | "hot" {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warm";
  return "ok";
}

/** Tightest CLI quota bucket (window vs weekly) for the ring glyph. */
export function tightestQuotaLimit(quota: SessionQuota | undefined): SessionQuotaLimit | null {
  if (!quota) return null;
  const buckets = [quota.window, quota.weekly].filter(
    (bucket): bucket is SessionQuotaLimit => bucket !== null,
  );
  if (buckets.length === 0) return null;
  return buckets.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
}

/** "resets in 50m" / "resetting now" / "reset time unknown" for quota resets. */
export function formatQuotaResetMs(resetsAtMs: number | null, now: number = Date.now()): string {
  if (resetsAtMs === null || !Number.isFinite(resetsAtMs)) return "reset time unknown";
  const diff = resetsAtMs - now;
  if (diff <= 0) return "resetting now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `resets in ${days}d` : `resets in ${days}d ${hours % 24}h`;
}
