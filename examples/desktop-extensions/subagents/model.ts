import type { AgentRun } from "./contract.ts";

/** Pure formatting shared by the browser view and tests. No Node, DOM or Chord access. */

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
export function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "27s" / "4m 03s" style duration from a tool result's durationMs. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

export function sortRuns(runs: readonly AgentRun[]): AgentRun[] {
  const rank = (run: AgentRun): number =>
    run.status === "running" ? 2 : run.status === "error" ? 1 : 0;
  return [...runs].sort(
    (a, b) =>
      rank(b) - rank(a) || (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0),
  );
}
