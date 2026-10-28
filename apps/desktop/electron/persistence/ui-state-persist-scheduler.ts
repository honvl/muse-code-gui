import type { SessionDriverEvent } from "@pi-gui/session-driver";

/** How a session event writes UI state: at once, coalesced, or not at all. */
export type SessionEventPersistence = "immediate" | "debounced" | "none";

/**
 * A closed session and the end of a top-level run write UI state at once. A
 * child run's end is coalesced: several children often finish together, and
 * each would otherwise write the full UI state. Quit flushes a pending write.
 */
export function sessionEventPersistence(
  eventType: SessionDriverEvent["type"],
  isOrchestrationChild: boolean,
): SessionEventPersistence {
  if (eventType === "sessionClosed") {
    return "immediate";
  }
  if (eventType === "runCompleted" || eventType === "runFailed") {
    return isOrchestrationChild ? "debounced" : "immediate";
  }
  return eventType === "hostUiRequest" ? "none" : "debounced";
}

export const UI_STATE_PERSIST_DELAY_MS = 250;

/** Trailing-edge debounce for one write; a newer schedule restarts the delay. */
export interface DebouncedPersist {
  schedule(): void;
  /** Drop a pending write; the caller is writing now or must not write. */
  cancel(): void;
  readonly pending: boolean;
}

export function createDebouncedPersist(
  persist: () => Promise<void>,
  onError: (error: unknown) => void,
  delayMs: number = UI_STATE_PERSIST_DELAY_MS,
): DebouncedPersist {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        void persist().catch(onError);
      }, delayMs);
    },
    cancel,
    get pending() {
      return timer !== undefined;
    },
  };
}
