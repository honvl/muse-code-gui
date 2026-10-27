import type { Timestamp } from "./types.js";

/** Token counts in one of pi's usage buckets. */
export interface SessionTokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface SessionContextUsage {
  /** Tokens the next request will carry; null right after compaction until the model replies. */
  readonly tokens: number | null;
  readonly contextWindow: number;
  /** Token count at which pi compacts automatically; absent when auto-compaction is off. */
  readonly compactAtTokens?: number;
}

/**
 * What is known about the provider's prompt cache for the current model. Both
 * times are absolute so readers can count down without new snapshots; pi can
 * stop warming without an event, so a past `nextRefreshAt` means no refresh is
 * coming and `expiresAt` applies.
 */
export interface SessionPromptCache {
  /** Cache lifetime the model declares; absent when it declares none, so expiry is unknowable. */
  readonly lifetimeSeconds?: number;
  /** When the entry lapses unless touched; absent when the model declares no cache lifetime. */
  readonly expiresAt?: Timestamp;
  /** When pi's cache warmer plans its next refresh; absent when warming is not scheduled. */
  readonly nextRefreshAt?: Timestamp;
}

/** One provider-reported plan limit window, such as a 5-hour or weekly limit. */
export interface SessionPlanLimit {
  readonly windowMinutes: number;
  readonly usedPercent: number;
  readonly resetsAt?: Timestamp;
}

export interface SessionPlanLimits {
  readonly provider: string;
  readonly limits: readonly SessionPlanLimit[];
  readonly reportedAt: Timestamp;
}

/** One `muse usage` allowance bucket, such as the 5-hour window or weekly limit. */
export interface SessionQuotaLimit {
  /** Allowance consumed, 0-100. */
  readonly usedPercent: number;
  /** Absolute reset time (epoch ms), or null when unknown. */
  readonly resetsAtMs: number | null;
}

/** Subscription quota from the `muse` CLI: user-global, not per-session. */
export interface SessionQuota {
  readonly tier: string | null;
  readonly window: SessionQuotaLimit | null;
  readonly weekly: SessionQuotaLimit | null;
  /** When the CLI output was read (epoch ms), or null when never fetched. */
  readonly fetchedAt: number | null;
  /** Non-fatal fetch/parse problem; limits may still be present. */
  readonly error: string | null;
}

/** Context, cache and usage for one session, read from pi at turn boundaries. */
export interface SessionUsageSnapshot {
  readonly context?: SessionContextUsage;
  /** Prompt tokens of the latest reply, for the cache hit rate. */
  readonly lastTurn?: SessionTokenCounts;
  readonly cache: SessionPromptCache;
  /** Totals for the whole session, including compaction and cache-warming requests. */
  readonly totals: SessionTokenCounts & { readonly cost: number };
  /** True when the provider bills through a subscription, so `totals.cost` is not money spent. */
  readonly subscription: boolean;
  /** CLI subscription quota (user-global). Absent until fetched; never blocks usage. */
  readonly quota?: SessionQuota;
  readonly planLimits?: SessionPlanLimits;
}
