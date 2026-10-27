import type { ProviderDay, ThreadUsage, UsageCounts } from "./contract.ts";

/** Pure aggregation shared by the browser view and tests. No Node, DOM or Chord access. */

export const META_PROVIDER = "meta";

export type Period = "today" | "7d" | "30d" | "all";

export const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

export function emptyCounts(): UsageCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addCounts(target: UsageCounts, usage: UsageCounts): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost;
}

/** pi's total: input + output + cache read + cache write. */
export function totalTokens(counts: UsageCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

/** Share of prompt tokens served from cache, or null when nothing was sent. */
export function cacheHitRate(counts: UsageCounts): number | null {
  const prompt = counts.input + counts.cacheRead + counts.cacheWrite;
  return prompt > 0 ? counts.cacheRead / prompt : null;
}

export function localDayStart(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Inclusive start of a period in local days, or null for all time. */
export function periodStart(period: Period, now: number): number | null {
  if (period === "all") return null;
  const days = period === "today" ? 0 : period === "7d" ? 6 : 29;
  const start = new Date(localDayStart(now));
  start.setDate(start.getDate() - days);
  return start.getTime();
}

/** Sum one provider's counts across a thread's days for a period. */
export function sumProvider(
  days: readonly ProviderDay[],
  provider: string,
  since: number | null,
): UsageCounts {
  const counts = emptyCounts();
  for (const day of days) {
    if (since !== null && day.dayStart < since) continue;
    const dayCounts = day.providers[provider];
    if (dayCounts) addCounts(counts, dayCounts);
  }
  return counts;
}

export function sumAll(days: readonly ProviderDay[], since: number | null): UsageCounts {
  const counts = emptyCounts();
  for (const day of days) {
    if (since !== null && day.dayStart < since) continue;
    for (const dayCounts of Object.values(day.providers)) addCounts(counts, dayCounts);
  }
  return counts;
}

export interface PeriodSummary {
  meta: UsageCounts;
  metaTokens: number;
  metaCacheHit: number | null;
  total: UsageCounts;
  totalTokens: number;
  subscription: boolean;
  threadCount: number;
}

export function summarizePeriod(
  threads: readonly ThreadUsage[],
  period: Period,
  now: number,
): PeriodSummary {
  const since = periodStart(period, now);
  const meta = emptyCounts();
  const total = emptyCounts();
  let threadCount = 0;
  for (const thread of threads) {
    const threadMeta = sumProvider(thread.days, META_PROVIDER, since);
    const threadTotal = sumAll(thread.days, since);
    if (totalTokens(threadTotal) === 0) continue;
    threadCount += 1;
    addCounts(meta, threadMeta);
    addCounts(total, threadTotal);
  }
  const metaTokens = totalTokens(meta);
  const totalTokensValue = totalTokens(total);
  return {
    meta,
    metaTokens,
    metaCacheHit: cacheHitRate(meta),
    total,
    totalTokens: totalTokensValue,
    subscription: totalTokensValue > 0 && total.cost === 0,
    threadCount,
  };
}

export function formatTokens(value: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
    }
  }
  return String(Math.round(value));
}

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  if (value > 0 && value < 0.01) return "<1%";
  return `${Math.round(value * 100)}%`;
}

export function formatCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(value >= 1000 ? 0 : 2)}`;
}

export function formatRelative(time: number | null, now: number): string {
  if (time === null || !Number.isFinite(time)) return "never";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "3m 12s" style elapsed time for running agents. */
export function quotaTone(usedPercent: number): "ok" | "warm" | "hot" {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warm";
  return "ok";
}

/** "resets in 50m" / "resets in 6d 3h" from an absolute epoch-ms reset time. */
export function formatResetMs(resetsAtMs: number | null, now: number): string {
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
