import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { ModelUsage, ProviderDay, ThreadModel, ThreadUsage, UsageCounts } from "./contract.ts";
import { addCounts, emptyCounts, localDayStart, META_PROVIDER, totalTokens } from "./model.ts";

/** Most recently active sessions read per refresh. Older ones are counted as capped. */
export const MAX_SESSIONS = 200;
/** Session files larger than this are skipped and counted as unreadable. */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export interface CurrentThread {
  id: string;
  /** Live entries, including any not yet flushed to disk. */
  entries: SessionEntry[];
  name: string | undefined;
}

export interface CollectOptions {
  cwd: string;
  sessionDir?: string;
  current?: CurrentThread;
  modelName?: (provider: string, modelId: string) => string | undefined;
  /** Whether replies from this model are billed to a subscription plan rather than per token. */
  isSubscription?: (provider: string, modelId: string) => boolean;
  now?: number;
  signal?: AbortSignal;
}

export interface CollectedMuse {
  refreshedAt: number;
  folderName: string;
  threads: ThreadUsage[];
  models: ModelUsage[];
  scanned: number;
  unreadable: number;
  capped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toCounts(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
}): UsageCounts {
  return {
    input: usage.input || 0,
    output: usage.output || 0,
    cacheRead: usage.cacheRead || 0,
    cacheWrite: usage.cacheWrite || 0,
    cost: usage.cost?.total || 0,
  };
}

/**
 * Reads every saved pi session for the folder (newest first, bounded) and reduces each to
 * per-day, per-provider token usage. Entries are handled as unknown values so the
 * transcript shape is validated, not assumed.
 */
export async function collectMuseUsage(options: CollectOptions): Promise<CollectedMuse> {
  const infos = await SessionManager.list(
    options.cwd,
    options.sessionDir,
    undefined,
    options.signal,
  );
  const selected = infos.slice(0, MAX_SESSIONS);
  const threads: ThreadUsage[] = [];
  let unreadable = 0;
  let sawCurrent = false;
  for (const info of selected) {
    options.signal?.throwIfAborted();
    const isCurrent = info.id === options.current?.id;
    let entries: SessionEntry[] | undefined;
    if (isCurrent) {
      sawCurrent = true;
      entries = options.current!.entries;
    } else {
      entries = await readEntries(info.path);
      await nextTurn();
    }
    if (!entries) {
      unreadable += 1;
      continue;
    }
    const thread = reduceThread({
      id: info.id,
      title: titleFromSessionInfo(info),
      lastActiveAt: info.modified.getTime(),
      entries,
      current: isCurrent,
      modelName: options.modelName,
      isSubscription: options.isSubscription,
    });
    threads.push(thread);
  }
  // A new session is not on disk until its first message; its live entries still count.
  const current = options.current;
  if (current && !sawCurrent && current.entries.some((entry) => entry.type === "message")) {
    const live = current.entries as unknown[];
    const thread = reduceThread({
      id: current.id,
      title: current.name?.trim() || firstUserText(live) || "This thread",
      lastActiveAt: lastActivity(live) ?? options.now ?? Date.now(),
      entries: live,
      current: true,
      modelName: options.modelName,
      isSubscription: options.isSubscription,
    });
    threads.unshift(thread);
  }
  return {
    refreshedAt: options.now ?? Date.now(),
    folderName: basename(options.cwd) || options.cwd,
    threads,
    models: summarizeModels(threads, options.isSubscription),
    scanned: selected.length,
    unreadable,
    capped: infos.length - selected.length,
  };
}

async function readEntries(path: string): Promise<SessionEntry[] | undefined> {
  try {
    if ((await stat(path)).size > MAX_SESSION_BYTES) return undefined;
    const fileEntries = parseSessionEntries(await readFile(path, "utf8"));
    if (fileEntries[0]?.type !== "session") return undefined;
    migrateSessionEntries(fileEntries);
    return fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  } catch {
    return undefined;
  }
}

/** Matches pi-gui's `titleFromSessionInfo`: the session name, else the first user message. */
export function titleFromSessionInfo(info: SessionInfo): string {
  const name = info.name?.trim();
  if (name) return name;
  const first = truncate(info.firstMessage === "(no messages)" ? "" : info.firstMessage, 72);
  return first || basename(info.cwd || info.path);
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

interface ReduceInput {
  id: string;
  title: string;
  lastActiveAt: number;
  entries: unknown[];
  current: boolean;
  modelName: CollectOptions["modelName"];
  isSubscription?: CollectOptions["isSubscription"];
}

/**
 * Sums usage per provider per day, exactly as pi's `getSessionStats()` sums it (assistant,
 * tool-result, usage entries and compaction/branch-summary calls, all branches). Replies from
 * a subscription-backed provider keep their tokens but not pi's list-price cost.
 */
export function reduceThread(input: ReduceInput): ThreadUsage {
  const days = new Map<number, Map<string, UsageCounts>>();
  const byModel = new Map<string, { provider: string; model: string; output: number }>();
  const models = new Map<
    string,
    { provider: string; model: string; tokens: number; replies: number; cost: number }
  >();
  let replies = 0;
  const add = (time: number, usage: UsageCounts, provider: string) => {
    const dayStart = localDayStart(time);
    let day = days.get(dayStart);
    if (!day) {
      day = new Map<string, UsageCounts>();
      days.set(dayStart, day);
    }
    const counts = day.get(provider) ?? emptyCounts();
    addCounts(counts, usage);
    day.set(provider, counts);
  };
  const attribute = (
    time: number,
    raw: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost?: { total: number };
    },
    provider: string,
    model: string,
    isReply: boolean,
  ): void => {
    const subscription = input.isSubscription?.(provider, model) ?? false;
    const counts = toCounts(raw);
    if (subscription) counts.cost = 0;
    add(time, counts, provider);
    const key = `${provider}/${model}`;
    const tally = byModel.get(key) ?? { provider, model, output: 0 };
    tally.output += counts.output;
    byModel.set(key, tally);
    const modelTally = models.get(key) ?? { provider, model, tokens: 0, replies: 0, cost: 0 };
    modelTally.tokens += totalTokens(counts);
    if (isReply) modelTally.replies += 1;
    modelTally.cost += counts.cost;
    models.set(key, modelTally);
  };
  for (const entry of input.entries) {
    if (!isRecord(entry)) continue;
    const entryTime = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const type = entry.type;
    if (type === "usage" && isRecord(entry.usage)) {
      const usage = entry.usage;
      attribute(
        entryTime,
        {
          input: num(usage.input),
          output: num(usage.output),
          cacheRead: num(usage.cacheRead),
          cacheWrite: num(usage.cacheWrite),
          cost: isRecord(usage.cost) ? { total: num(usage.cost.total) } : undefined,
        },
        strOr(usage.provider, "unknown"),
        strOr(usage.model, "unknown"),
        false,
      );
      continue;
    }
    if ((type === "compaction" || type === "branch_summary") && isRecord(entry.usage)) {
      const usage = entry.usage;
      attribute(
        entryTime,
        {
          input: num(usage.input),
          output: num(usage.output),
          cacheRead: num(usage.cacheRead),
          cacheWrite: num(usage.cacheWrite),
          cost: isRecord(usage.cost) ? { total: num(usage.cost.total) } : undefined,
        },
        strOr(usage.provider, "unknown"),
        strOr(usage.model, "unknown"),
        false,
      );
      continue;
    }
    if (type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const time =
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : entryTime;
    if (!Number.isFinite(time)) continue;
    if (message.role === "toolResult" && isRecord(message.usage)) {
      const usage = message.usage;
      attribute(
        time,
        {
          input: num(usage.input),
          output: num(usage.output),
          cacheRead: num(usage.cacheRead),
          cacheWrite: num(usage.cacheWrite),
          cost: isRecord(usage.cost) ? { total: num(usage.cost.total) } : undefined,
        },
        strOr(message.provider, "unknown"),
        strOr(message.model, "unknown"),
        false,
      );
      continue;
    }
    if (message.role !== "assistant" || !isRecord(message.usage)) continue;
    const usage = message.usage;
    const provider = strOr(message.provider, "unknown");
    const model = strOr(message.model, "unknown");
    attribute(
      time,
      {
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        cacheWrite: num(usage.cacheWrite),
        cost: isRecord(usage.cost) ? { total: num(usage.cost.total) } : undefined,
      },
      provider,
      model,
      true,
    );
    replies += 1;
  }
  const top = [...byModel.values()].sort((a, b) => b.output - a.output)[0];
  const providerDays: ProviderDay[] = [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayStart, providers]) => ({ dayStart, providers: Object.fromEntries(providers) }));
  const threadModels: ThreadModel[] = [...models.values()].map((value) => ({
    provider: value.provider,
    model: value.model,
    displayName: input.modelName?.(value.provider, value.model) ?? value.model,
    tokens: value.tokens,
    replies: value.replies,
    cost: value.cost,
  }));
  const metaTokens = threadModels
    .filter((value) => value.provider === META_PROVIDER)
    .reduce((sum, value) => sum + value.tokens, 0);
  const total = threadModels.reduce((sum, value) => sum + value.tokens, 0);
  return {
    id: input.id,
    title: input.title,
    current: input.current,
    lastActiveAt: input.lastActiveAt,
    model: top ? (input.modelName?.(top.provider, top.model) ?? top.model) : null,
    replies,
    metaTokens,
    totalTokens: total,
    subscription:
      total > 0 &&
      threadModels.length > 0 &&
      threadModels.every((value) => input.isSubscription?.(value.provider, value.model) ?? false),
    days: providerDays,
    models: threadModels.sort((a, b) => b.tokens - a.tokens),
  };
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

/** Aggregate per-model usage across threads; meta first, then by tokens. */
export function summarizeModels(
  threads: readonly ThreadUsage[],
  isSubscription?: CollectOptions["isSubscription"],
): ModelUsage[] {
  const byKey = new Map<string, ModelUsage>();
  for (const thread of threads) {
    for (const value of thread.models) {
      const key = `${value.provider}/${value.model}`;
      const tally = byKey.get(key) ?? {
        provider: value.provider,
        model: value.model,
        displayName: value.displayName,
        tokens: 0,
        replies: 0,
        subscription: isSubscription?.(value.provider, value.model) ?? false,
        cost: 0,
      };
      tally.tokens += value.tokens;
      tally.replies += value.replies;
      tally.cost += value.cost;
      byKey.set(key, tally);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.provider === META_PROVIDER && b.provider !== META_PROVIDER
      ? -1
      : b.provider === META_PROVIDER && a.provider !== META_PROVIDER
        ? 1
        : b.tokens - a.tokens,
  );
}

function firstUserText(entries: unknown[]): string {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "user") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as unknown[])
              .filter((block) => isRecord(block) && block.type === "text")
              .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
              .join(" ")
          : "";
    if (text.trim()) return truncate(text, 72);
  }
  return "";
}

function lastActivity(entries: unknown[]): number | undefined {
  let latest: number | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const timestamp = message.timestamp;
    const time =
      typeof timestamp === "number" && Number.isFinite(timestamp)
        ? timestamp
        : typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : NaN;
    if (Number.isFinite(time)) latest = Math.max(latest ?? 0, time);
  }
  return latest;
}
