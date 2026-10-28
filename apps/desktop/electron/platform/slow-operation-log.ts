import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Slow-operation log for the main process.
 *
 * A packaged pi-gui runs with stdout/stderr on /dev/null, so a `console.warn`
 * about a stalled event handler is invisible — which is why an intermittent
 * "spike to 100% CPU" was impossible to attribute. This appends the offending
 * operation and its duration to a small file in the app data dir instead, so a
 * spike can be traced to the code path that caused it.
 *
 * Writes are fire-and-forget and coalesced: timing must never become the cost it
 * is measuring. Only operations over the threshold are recorded, so the file
 * stays near-empty when the app is healthy.
 */

/** A stall shorter than this is not perceptible as a freeze. */
export const SLOW_OPERATION_THRESHOLD_MS = 120;

const MAX_LOG_BYTES = 1_000_000;

let logFilePath: string | undefined;
let pendingWrite: Promise<void> | undefined;

export function configureSlowOperationLog(userDataDir: string): void {
  logFilePath = join(userDataDir, "slow-operations.log");
}

/**
 * Record `label` when it ran for at least the threshold. `startedAt` comes from
 * `Date.now()`, matching the wall clock used to size the stall.
 */
export function noteSlowOperation(
  label: string,
  startedAt: number,
  thresholdMs: number = SLOW_OPERATION_THRESHOLD_MS,
): void {
  const elapsed = Date.now() - startedAt;
  if (elapsed < thresholdMs || !logFilePath) {
    return;
  }
  // Chain so two slow paths cannot interleave partial lines.
  pendingWrite = (pendingWrite ?? Promise.resolve())
    .then(async () => {
      const path = logFilePath;
      if (!path) return;
      await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
      const { size } = await stat(path).catch(() => ({ size: 0 }));
      // Rotate by truncation: this is a diagnostic breadcrumb, not an audit log.
      if (size > MAX_LOG_BYTES) {
        await truncate(path, 0).catch(() => undefined);
      }
      const at = new Date().toISOString();
      await appendFile(path, `${at}  ${String(elapsed).padStart(6)}ms  ${label}\n`).catch(
        () => undefined,
      );
    })
    .catch(() => undefined);
}
