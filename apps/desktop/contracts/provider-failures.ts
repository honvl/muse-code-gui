/**
 * Provider-failure classification for child runs. Pure and renderer-safe (no
 * Node or Electron imports): the Electron orchestration owner, the timeline
 * failure row, and the renderer's Lead badge all share it.
 *
 * When a provider rejects a child's request, pi-gui says plainly what
 * happened and what to do instead of carrying the raw error up to the lead,
 * which otherwise wastes turns retrying or re-spawning a doomed child.
 */

/** How a child's provider rejection reads to the lead. */
export type ProviderFailureClass =
  "attestation-denied" | "auth" | "rate-limited" | "overloaded" | "quota" | "other";

/** Env var overriding how long a fail-fast provider failure blocks respawns. */
export const PROVIDER_FAILURE_MEMORY_ENV_VAR = "PI_APP_PROVIDER_FAILURE_MEMORY_MS";

/** Default fail-fast window: a failed sidekick model blocks respawns for 10 minutes. */
export const DEFAULT_PROVIDER_FAILURE_MEMORY_MS = 10 * 60 * 1_000;

/**
 * How long a recorded attestation/auth failure keeps refusing spawns on that
 * provider+model. Overridable with PI_APP_PROVIDER_FAILURE_MEMORY_MS
 * (non-negative integer ms; junk falls back to the default).
 */
export function resolveProviderFailureMemoryMs(
  env?: Readonly<Record<string, string | undefined>>,
): number {
  const fromEnv = env?.[PROVIDER_FAILURE_MEMORY_ENV_VAR]?.trim();
  const raw =
    fromEnv ??
    (typeof process !== "undefined"
      ? process.env[PROVIDER_FAILURE_MEMORY_ENV_VAR]?.trim()
      : undefined);
  if (raw !== undefined && raw !== "" && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return DEFAULT_PROVIDER_FAILURE_MEMORY_MS;
}

/**
 * Classify a provider rejection from the child's runFailed error plus the
 * last assistant message's errorMessage (joined by the caller; either may be
 * absent). First match wins: attestation before auth before transient before
 * quota, so a 403 attestation block never reads as a quota or auth problem.
 */
export function classifyProviderFailure(combinedText: string | undefined): ProviderFailureClass {
  const text = (combinedText ?? "").toLowerCase();
  if (!text.trim()) {
    return "other";
  }
  if (
    text.includes("client_attestation_denied") ||
    (text.includes("attestat") && (text.includes("403") || text.includes("forbidden")))
  ) {
    return "attestation-denied";
  }
  if (
    text.includes("401") ||
    text.includes("invalid_api_key") ||
    text.includes("invalid api key") ||
    text.includes("incorrect api key") ||
    text.includes("unauthorized") ||
    text.includes("authentication") ||
    text.includes("expired") ||
    text.includes("invalid key") ||
    text.includes("invalid token")
  ) {
    return "auth";
  }
  if (
    text.includes("429") ||
    text.includes("rate_limit") ||
    text.includes("rate limit") ||
    text.includes("too many requests")
  ) {
    return "rate-limited";
  }
  if (
    text.includes("503") ||
    text.includes("service_overloaded") ||
    text.includes("overloaded") ||
    text.includes("server is busy") ||
    text.includes("capacity")
  ) {
    return "overloaded";
  }
  if (
    text.includes("allowance") ||
    text.includes("quota") ||
    text.includes("insufficient") ||
    text.includes("billing") ||
    text.includes("payment") ||
    text.includes("exhausted")
  ) {
    return "quota";
  }
  return "other";
}

/**
 * Short actionable note per class for the child report, the child thread's
 * failure row, and the fail-fast refusal. Undefined for `other`: nothing
 * useful to say beyond the raw error. Keep every note under 300 characters.
 */
export function providerFailureNote(failureClass: ProviderFailureClass): string | undefined {
  switch (failureClass) {
    case "attestation-denied":
      return (
        "Meta rejected this subscription request outside Muse Code. " +
        "Set PI_APP_SIDEKICK_RUNTIME=auto (runs Meta sidekicks through the Muse Code CLI), " +
        "add a Meta pay-as-you-go key, or pick another sidekick in Settings › Models."
      );
    case "auth":
      return (
        "The provider rejected the credentials (401/expired key). " +
        "Reconnect or update the key in Settings › Models, then retry."
      );
    case "rate-limited":
      return (
        "The provider rate-limited the request (429) — transient. " +
        "Safe to re-send with send_message_to_thread; no settings change needed."
      );
    case "overloaded":
      return (
        "The provider is overloaded (503) — transient. " +
        "Safe to re-send with send_message_to_thread once it recovers."
      );
    case "quota":
      return (
        "The subscription allowance is exhausted. " +
        "Top up billing, add a pay-as-you-go key, or pick another sidekick in Settings › Models."
      );
    case "other":
      return undefined;
  }
}

/** Fail-fast classes: re-spawning on the same model will fail the same way. */
export function isFailFastFailureClass(failureClass: ProviderFailureClass): boolean {
  return failureClass === "attestation-denied" || failureClass === "auth";
}

export interface ProviderModelSelection {
  readonly provider: string;
  readonly modelId: string;
}

function providerFailureKey(model: ProviderModelSelection): string {
  return `${model.provider}:${model.modelId}`;
}

/** Exported for state projection; prefer activeProviderFailureNote otherwise. */
export function providerFailureStateKey(model: ProviderModelSelection): string {
  return providerFailureKey(model);
}

interface ProviderFailureMemoryEntry {
  readonly note: string;
  readonly recordedAt: number;
}

const providerFailureMemory = new Map<string, ProviderFailureMemoryEntry>();

function pruneProviderFailureMemory(nowMs: number, windowMs: number): void {
  for (const [key, entry] of providerFailureMemory) {
    if (nowMs - entry.recordedAt > windowMs) {
      providerFailureMemory.delete(key);
    }
  }
}

/** Remember a fail-fast failure so later spawns on that model refuse fast. */
export function recordProviderFailure(
  model: ProviderModelSelection | undefined,
  failureClass: ProviderFailureClass,
  nowMs: number = Date.now(),
): void {
  if (!model || !isFailFastFailureClass(failureClass)) {
    return;
  }
  const note = providerFailureNote(failureClass);
  if (!note) {
    return;
  }
  providerFailureMemory.set(providerFailureKey(model), { note, recordedAt: nowMs });
}

/** A success on the model clears the fail-fast memory. */
export function clearProviderFailure(
  model: ProviderModelSelection | undefined,
  nowMs: number = Date.now(),
): void {
  if (!model) {
    return;
  }
  void nowMs;
  providerFailureMemory.delete(providerFailureKey(model));
}

/** Test seam: drop all fail-fast memory regardless of age. */
export function clearAllProviderFailures(): void {
  providerFailureMemory.clear();
}

/**
 * The refusal note when the model is inside its fail-fast window, else
 * undefined. Expired entries are pruned on read so the Lead badge clears even
 * when no child runs to refresh it.
 */
export function activeProviderFailureNote(
  model: ProviderModelSelection | undefined,
  options?: {
    readonly nowMs?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): string | undefined {
  if (!model) {
    return undefined;
  }
  const nowMs = options?.nowMs ?? Date.now();
  const windowMs = resolveProviderFailureMemoryMs(options?.env);
  pruneProviderFailureMemory(nowMs, windowMs);
  const entry = providerFailureMemory.get(providerFailureKey(model));
  if (!entry || nowMs - entry.recordedAt > windowMs) {
    return undefined;
  }
  return entry.note;
}

/**
 * Pruned fail-fast memory for DesktopAppState projection (existing state
 * channel, no new IPC): state key to refusal note.
 */
export function providerFailureNotesSnapshot(
  nowMs: number = Date.now(),
  env?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const windowMs = resolveProviderFailureMemoryMs(env);
  pruneProviderFailureMemory(nowMs, windowMs);
  const snapshot: Record<string, string> = {};
  for (const [key, entry] of providerFailureMemory) {
    if (nowMs - entry.recordedAt <= windowMs) {
      snapshot[key] = entry.note;
    }
  }
  return snapshot;
}
