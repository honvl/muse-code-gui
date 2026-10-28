import { sessionKey } from "@pi-gui/session-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";

/**
 * Trailing-edge interval for streaming transcript / sidebar publishes.
 * Hidden macOS CI windows coalesce Node timers past this delay, so Electron
 * proofs must poll for the flush instead of waiting interval+slack once.
 */
export const STREAMING_UI_PUBLISH_INTERVAL_MS = 50;

/**
 * Token-level `assistantDelta` always arrives with a redundant `sessionUpdated`
 * (preview/timestamp). Publishing full app state for each pair was the leftover
 * #93 CPU path after #114. Defer those two; flush immediately on discrete events.
 *
 * `toolUpdated` is deferred for the same reason: a long-running bash or code tool
 * reports partial output repeatedly, and each report used to trigger an immediate
 * full state publish. A busy tool turned that into a burst of publishes — the
 * intermittent spike to a full core. Progress still lands within one interval,
 * while `toolStarted`/`toolFinished` stay immediate because a row appearing or
 * settling is what the reader is waiting on.
 *
 * `trackedRunId` is the last observed `snapshot.runningRunId` for this session.
 * A new run id (Send after Stop) is not deferred. Do not pass
 * `runningSinceBySession.has` — user cancel never clears that map.
 */
export function shouldDeferStreamingUiPublish(
  event: SessionDriverEvent,
  trackedRunId: string | undefined,
): boolean {
  if (
    event.type === "assistantDelta" ||
    event.type === "assistantThinkingDelta" ||
    event.type === "toolUpdated"
  ) {
    return true;
  }
  if (event.type !== "sessionUpdated" || event.snapshot.status !== "running") {
    return false;
  }
  const runId = event.snapshot.runningRunId;
  return Boolean(runId) && runId === trackedRunId;
}

/**
 * At most one UI publish per interval across ALL sessions.
 *
 * A publish rebuilds and ships the whole app state, so the cost scales with the
 * flush rate, not with how many sessions are streaming. Per-session timers made
 * that N × (1000/interval) full publishes a second — five concurrently streaming
 * threads produced a hundred state publishes a second, which is what pinned a CPU
 * core and made the window sluggish. One shared timer flushes every pending
 * session once, so the rate stays fixed as concurrency grows.
 *
 * Also owns last-seen runningRunId so Stop→Send is immediate.
 */
export class StreamingUiPublisher {
  private readonly pending = new Map<string, SessionRef>();
  private readonly trackedRunId = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly publish: (sessionRefs: readonly SessionRef[]) => void,
    private readonly intervalMs: number = STREAMING_UI_PUBLISH_INTERVAL_MS,
  ) {}

  shouldDefer(event: SessionDriverEvent): boolean {
    return shouldDeferStreamingUiPublish(
      event,
      this.trackedRunId.get(sessionKey(event.sessionRef)),
    );
  }

  /**
   * Record the run id after the defer decision for this event so the first
   * running tick is not deferred by its own write.
   */
  observe(event: SessionDriverEvent): void {
    const key = sessionKey(event.sessionRef);
    if (event.type === "sessionClosed") {
      this.trackedRunId.delete(key);
      this.pending.delete(key);
      return;
    }
    if (
      event.type === "sessionUpdated" &&
      event.snapshot.status === "running" &&
      event.snapshot.runningRunId
    ) {
      this.trackedRunId.set(key, event.snapshot.runningRunId);
    }
  }

  schedule(sessionRef: SessionRef): void {
    this.pending.set(sessionKey(sessionRef), sessionRef);
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.intervalMs);
  }

  /**
   * Drop this session's pending flush. A discrete event publishes immediately
   * (covering every session's state), but other sessions keep their own pending
   * entry so their transcripts are not skipped.
   */
  cancel(sessionRef: SessionRef): void {
    this.pending.delete(sessionKey(sessionRef));
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
  }

  /** Pending session count; exposed so tests can assert coalescing. */
  pendingCount(): number {
    return this.pending.size;
  }

  private flush(): void {
    if (this.pending.size === 0) {
      return;
    }
    const sessionRefs = [...this.pending.values()];
    this.pending.clear();
    this.publish(sessionRefs);
  }
}
