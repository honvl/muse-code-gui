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
import type { AgentRun, AgentSummary, AgentStatus } from "./contract.ts";

/** Most recently active sessions read per refresh. Older ones are ignored. */
export const MAX_SESSIONS = 200;
/** Session files larger than this are skipped and counted as unreadable. */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
/** Agent session files larger than this get no inner summary (still listed). */
export const MAX_SUMMARY_BYTES = 8 * 1024 * 1024;
/** Recent runs surfaced per refresh; inner summaries resolve for the newest few. */
export const MAX_RUNS = 30;
export const MAX_SUMMARIES = 12;
/** Tools whose `path` argument counts as a touched file. */
const FILE_TOOLS = new Set(["read", "write", "edit"]);

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
  now?: number;
  signal?: AbortSignal;
}

export interface CollectedAgents {
  refreshedAt: number;
  folderName: string;
  runs: AgentRun[];
  scanned: number;
  unreadable: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function entryTime(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number | null {
  const timestamp = message.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  const entryTimestamp = entry.timestamp;
  if (typeof entryTimestamp === "string") {
    const parsed = Date.parse(entryTimestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `agentId: <uuid>` tail the pi-cc-subagent tool appends to its result. */
export function parseAgentId(text: string): string | null {
  const match = /agentId:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    text,
  );
  return match ? match[1] : null;
}

interface PendingCall {
  toolCallId: string;
  description: string;
  subagentType: string;
  background: boolean;
  model: string | null;
  isolation: string | null;
  startedAt: number | null;
}

interface CallResult {
  endedAt: number | null;
  durationMs: number | null;
  isError: boolean;
  agentId: string | null;
}

/**
 * Pairs `agent`-tool calls with their results in one thread's transcript. A call with a
 * result is done/error; without one it is running when the thread is current (its result
 * has not landed yet) and done-with-unknown-outcome otherwise. Entries are unknown values.
 */
export function scanAgentRuns(
  threadId: string,
  threadTitle: string,
  entries: unknown[],
  current: boolean,
): AgentRun[] {
  const calls = new Map<string, PendingCall & { order: number }>();
  const results = new Map<string, CallResult>();
  let order = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const at = entryTime(entry, message);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as unknown[]) {
        if (!isRecord(block) || block.type !== "toolCall" || block.name !== "agent") continue;
        const toolCallId = typeof block.id === "string" ? block.id : `call-${order}`;
        if (calls.has(toolCallId)) continue;
        const args = isRecord(block.arguments) ? block.arguments : undefined;
        const description =
          (args && typeof args.description === "string" && args.description.trim()) ||
          "Subagent task";
        calls.set(toolCallId, {
          toolCallId,
          description: truncate(description, 120),
          subagentType: strOr(args?.subagent_type, "general-purpose"),
          background: (args?.run_in_background ?? false) === true,
          model: typeof args?.model === "string" && args.model ? args.model : null,
          isolation: typeof args?.isolation === "string" && args.isolation ? args.isolation : null,
          startedAt: at,
          order: order++,
        });
      }
    } else if (message.role === "toolResult" && message.toolName === "agent") {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : null;
      if (!toolCallId || results.has(toolCallId)) continue;
      let text = "";
      if (Array.isArray(message.content)) {
        for (const block of message.content as unknown[]) {
          if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
            text += block.text;
          }
        }
      }
      results.set(toolCallId, {
        endedAt: at,
        durationMs:
          typeof message.durationMs === "number" && Number.isFinite(message.durationMs)
            ? message.durationMs
            : null,
        isError: message.isError === true,
        agentId: parseAgentId(text),
      });
    }
  }
  const runs: AgentRun[] = [];
  for (const call of [...calls.values()].sort((a, b) => a.order - b.order)) {
    const result = results.get(call.toolCallId);
    const status: AgentStatus = result
      ? result.isError
        ? "error"
        : "done"
      : current
        ? "running"
        : "done";
    runs.push({
      key: `${threadId}:${call.toolCallId}`,
      threadId,
      threadTitle,
      current,
      description: call.description,
      subagentType: call.subagentType,
      background: call.background,
      model: call.model,
      isolation: call.isolation,
      status,
      startedAt: call.startedAt,
      endedAt: result?.endedAt ?? null,
      durationMs: result?.durationMs ?? null,
      agentId: result?.agentId ?? null,
      summary: null,
    });
  }
  return runs;
}

/** Reads one subagent session file into an activity summary. Returns null when unreadable. */
export async function summarizeAgentSession(path: string): Promise<AgentSummary | null> {
  let info: { size: number };
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (info.size > MAX_SUMMARY_BYTES) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const entries: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
  }
  return summarizeAgentEntries(entries);
}

/** Pure inner-activity summary over unknown transcript entries. */
export function summarizeAgentEntries(entries: unknown[]): AgentSummary {
  let turns = 0;
  let toolCalls = 0;
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();
  let lastMessage = "";
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role === "assistant" && isRecord(message.usage)) turns += 1;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as unknown[]) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        lastMessage = truncate(block.text, 240);
      } else if (block.type === "toolCall" && typeof block.name === "string") {
        toolCalls += 1;
        toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
        if (FILE_TOOLS.has(block.name) && isRecord(block.arguments)) {
          const path = block.arguments.path;
          if (typeof path === "string" && path && files.size < 12) files.add(path);
        }
      }
    }
  }
  return {
    turns,
    toolCalls,
    topTools: [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => ({ name, count })),
    filesTouched: [...files],
    lastMessage,
  };
}

/**
 * Scans every saved pi session for `agent`-tool runs (newest first, bounded) and resolves
 * inner summaries for the newest runs via their subagent session files. Never throws for a
 * missing session dir; that yields zero runs.
 */
export async function collectAgentRuns(options: CollectOptions): Promise<CollectedAgents> {
  const now = options.now ?? Date.now();
  void now;
  const infos = await SessionManager.list(
    options.cwd,
    options.sessionDir,
    undefined,
    options.signal,
  );
  // Map every known session id to its file before slicing, so agent sessions resolve
  // even when an old parent thread fell outside the read cap.
  const pathById = new Map<string, string>();
  for (const info of infos) pathById.set(info.id, info.path);
  const selected = infos.slice(0, MAX_SESSIONS);
  const runs: AgentRun[] = [];
  let unreadable = 0;
  let sawCurrent = false;
  const readRunEntries = async (
    threadId: string,
    threadTitle: string,
    isCurrent: boolean,
    liveEntries?: SessionEntry[],
    path?: string,
  ): Promise<void> => {
    let entries: unknown[] | undefined;
    if (isCurrent && liveEntries) {
      sawCurrent = true;
      entries = liveEntries as unknown[];
    } else if (path) {
      entries = await readEntries(path);
      await nextTurn();
    }
    if (!entries) {
      unreadable += 1;
      return;
    }
    for (const run of scanAgentRuns(threadId, threadTitle, entries, isCurrent)) {
      if (runs.length < MAX_RUNS * 2) runs.push(run);
    }
  };
  for (const info of selected) {
    options.signal?.throwIfAborted();
    const isCurrent = info.id === options.current?.id;
    await readRunEntries(
      info.id,
      titleFromSessionInfo(info),
      isCurrent,
      isCurrent ? options.current?.entries : undefined,
      isCurrent ? undefined : info.path,
    );
  }
  const current = options.current;
  if (current && !sawCurrent && current.entries.some((entry) => entry.type === "message")) {
    await readRunEntries(
      current.id,
      current.name?.trim() || "This thread",
      true,
      current.entries,
      undefined,
    );
  }
  // Resolve inner summaries for the newest finished runs with an agent id.
  const withAgent = runs.filter((run) => run.status !== "running" && run.agentId);
  withAgent.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  let resolved = 0;
  for (const run of withAgent) {
    if (resolved >= MAX_SUMMARIES) break;
    const path = run.agentId ? pathById.get(run.agentId) : undefined;
    if (!path) continue;
    const summary = await summarizeAgentSession(path);
    await nextTurn();
    if (summary) {
      run.summary = summary;
      resolved += 1;
    }
  }
  withAgent.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  runs.sort((a, b) => {
    const rank = (run: AgentRun): number =>
      run.status === "running" ? 2 : run.status === "error" ? 1 : 0;
    return rank(b) - rank(a) || (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0);
  });
  return {
    refreshedAt: options.now ?? Date.now(),
    folderName: basename(options.cwd) || options.cwd,
    runs: runs.slice(0, MAX_RUNS),
    scanned: selected.length,
    unreadable,
  };
}

async function readEntries(path: string): Promise<unknown[] | undefined> {
  try {
    if ((await stat(path)).size > MAX_SESSION_BYTES) return undefined;
    const fileEntries = parseSessionEntries(await readFile(path, "utf8"));
    if (fileEntries[0]?.type !== "session") return undefined;
    migrateSessionEntries(fileEntries);
    return fileEntries.filter(
      (entry): entry is SessionEntry => entry.type !== "session",
    ) as unknown[];
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
