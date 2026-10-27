/** Shared text formatting for background-task surfaces (panel + rail). */
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
