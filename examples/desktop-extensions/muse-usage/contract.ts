import { defineService, type Context, type ReplicatedState } from "@earendil-works/chord";

/** Token counts as pi records them on assistant messages; cost is the provider-reported USD total. */
export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** One provider's usage for one local calendar day, keyed by that day's local midnight (ms). */
export interface ProviderDay {
  dayStart: number;
  /** Keyed by provider id (e.g. "meta"). */
  providers: Record<string, UsageCounts>;
}

/** Totals for one provider/model pair across the scanned threads. */
export interface ModelUsage {
  provider: string;
  model: string;
  displayName: string | null;
  tokens: number;
  replies: number;
  /** True when billed to a subscription plan rather than per token. */
  subscription: boolean;
  cost: number;
}

export interface ThreadUsage {
  id: string;
  title: string;
  current: boolean;
  /** pi's last user/assistant activity for the session (ms). */
  lastActiveAt: number;
  /** Display name of the model that produced the most output, or null when none replied. */
  model: string | null;
  /** Total assistant replies with usage. */
  replies: number;
  /** Tokens burned on the meta (Muse) provider, all time in this thread. */
  metaTokens: number;
  totalTokens: number;
  /** True when every reply in this thread came from a subscription plan. */
  subscription: boolean;
  days: ProviderDay[];
  models: ThreadModel[];
}

export interface ThreadModel {
  provider: string;
  model: string;
  displayName: string | null;
  tokens: number;
  replies: number;
  cost: number;
}

/** One quota bucket from `muse usage` (usedPercent is 0-100). */
export interface QuotaLimit {
  usedPercent: number;
  /** Absolute reset time (epoch ms), or null when unknown. */
  resetsAtMs: number | null;
}

export interface QuotaData {
  tier: string | null;
  window: QuotaLimit | null;
  weekly: QuotaLimit | null;
  fetchedAt: number | null;
  /** Non-fatal fetch/parse problem; local consumption still shows. */
  error: string | null;
}

export interface MuseUsageState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  refreshedAt: number | null;
  folderName: string;
  threads: ThreadUsage[];
  /** Aggregated across threads, meta first, then by tokens. */
  models: ModelUsage[];
  quota: QuotaData;
  /** Session files considered, files that could not be read, and files left out by the cap. */
  scanned: number;
  unreadable: number;
  capped: number;
}

export interface MuseUsageService {
  state: ReplicatedState<MuseUsageState>;
  refresh(request: Record<string, never>, context: Context): Promise<void>;
}

export const MuseUsage = defineService<MuseUsageService>("pi-gui.example.muse-usage.v1");
