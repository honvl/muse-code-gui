import type { TurnChangeSummary } from "../../../contracts/review";
import type {
  DisplayTimelineItem,
  TimelineToolCall,
  TimelineTranscriptItem,
  TimelineTurnMarker,
} from "../../../contracts/timeline-types";

/** Consecutive tool calls collapse into one group row from this size up. */
export const MIN_TOOL_GROUP_SIZE = 2;

const MIN_WORKED_DURATION_MS = 1_000;

/** Local bookkeeping row, not agent work: opening a session must not mark a prompt as seen. */
const RESUMED_SESSION_LABEL = "Resumed session";

function isUserMessage(item: TimelineTranscriptItem | undefined): boolean {
  return item?.kind === "message" && item.role === "user";
}

/**
 * Insert "Worked for Ns" turn markers, derived purely from real message/tool
 * timestamps. A turn begins at a user message and runs until the next user
 * message; the marker sits directly above the turn's final assistant reply
 * (Codex-style), or at the end of the turn when it has no assistant reply, and
 * reports the elapsed time from the prompt to the last item of that turn.
 *
 * Durations are never fabricated: a marker is emitted only when the turn has
 * downstream work and both endpoints carry parseable timestamps spanning at
 * least one second. The turn still in progress gets no marker, since its final
 * reply is not known yet.
 *
 * Each captured turn that changed files gets a changes card at the end of that turn: after
 * the last transcript item of the turn and any rows that follow it, before the next user
 * message or extension message.
 */
export function buildDisplayTimelineItems(
  transcript: readonly TimelineTranscriptItem[],
  options: {
    readonly lastTurnRunning?: boolean;
    readonly turnChanges?: readonly TurnChangeSummary[];
  } = {},
): readonly DisplayTimelineItem[] {
  // Marker to emit immediately before the transcript item at that index.
  // Index `transcript.length` means "after the last item".
  const markersBefore = new Map<number, TimelineTurnMarker>();

  for (let start = 0; start < transcript.length; start += 1) {
    const prompt = transcript[start];
    if (!prompt || !isUserMessage(prompt)) {
      continue;
    }

    let end = start + 1;
    while (end < transcript.length && !isUserMessage(transcript[end])) {
      end += 1;
    }
    if (end === transcript.length && options.lastTurnRunning) {
      break;
    }

    const startMs = Date.parse(prompt.createdAt);
    if (Number.isNaN(startMs)) {
      continue;
    }

    let endMs: number | null = null;
    let finalReplyIndex: number | null = null;
    for (let index = start + 1; index < end; index += 1) {
      const item = transcript[index];
      if (!item) {
        continue;
      }
      if (item.kind === "message" && item.role === "assistant") {
        finalReplyIndex = index;
      }
      // An extension can post into the thread long after the run settled, and a keyed card
      // carries its latest write's time; a message steered into the run is already covered
      // by the reply that follows it.
      if (item.kind === "custom" || item.kind === "card") {
        continue;
      }
      const itemMs = Date.parse(item.createdAt);
      if (!Number.isNaN(itemMs)) {
        endMs = endMs == null ? itemMs : Math.max(endMs, itemMs);
      }
    }

    if (endMs == null || endMs - startMs < MIN_WORKED_DURATION_MS) {
      continue;
    }

    markersBefore.set(finalReplyIndex ?? end, {
      kind: "turn-marker",
      id: `turn-marker:${prompt.id}`,
      durationMs: endMs - startMs,
    });
  }

  const cardsAfter = turnChangeCardPositions(transcript, options.turnChanges ?? []);
  if (markersBefore.size === 0 && cardsAfter.size === 0) {
    return groupConsecutiveTools(transcript);
  }

  const result: DisplayTimelineItem[] = [];
  for (let index = 0; index <= transcript.length; index += 1) {
    const marker = markersBefore.get(index);
    if (marker) {
      result.push(marker);
    }
    const item = transcript[index];
    if (item) {
      result.push(item);
    }
    for (const turn of cardsAfter.get(index) ?? []) {
      result.push({ kind: "turn-changes", id: `turn-changes:${turn.checkpointId}`, turn });
    }
  }
  return groupConsecutiveTools(result);
}

/**
 * Collapse runs of consecutive tool calls into a single Claude Desktop-style
 * "Ran N tools" group row. Turn markers, assistant replies, activities,
 * summaries, extension messages, and change cards all break a run, so a group
 * never spans two turns. Single tools stay ungrouped to preserve the existing
 * one-line row and its tests.
 */
export function groupConsecutiveTools(
  items: readonly DisplayTimelineItem[],
): readonly DisplayTimelineItem[] {
  if (items.length < MIN_TOOL_GROUP_SIZE) return items;
  const result: DisplayTimelineItem[] = [];
  let run: TimelineToolCall[] = [];
  const flush = () => {
    if (run.length >= MIN_TOOL_GROUP_SIZE) {
      const first = run[0]!;
      result.push({
        kind: "tool-group",
        id: `tool-group:${first.id}`,
        tools: [...run],
        createdAt: first.createdAt,
      });
    } else {
      for (const tool of run) result.push(tool);
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      run.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}

/**
 * Claude Desktop-style read receipts: a user message counts as seen once the
 * agent has produced anything downstream of it (a reply, tool call, Working
 * row, summary, or extension output). A message still waiting for its turn -
 * the last prompt of an idle thread, or a prompt queued behind a running turn
 * - stays unread. The run's first downstream row (Working, the assistant
 * reply, a tool call) lands in the same event batch that starts the run, so
 * the check appears the moment the agent picks the prompt up.
 */
export function buildUserMessageReadReceipts(
  transcript: readonly TimelineTranscriptItem[],
): ReadonlyMap<string, boolean> {
  const receipts = new Map<string, boolean>();
  transcript.forEach((item, index) => {
    if (!isUserMessage(item)) {
      return;
    }
    let read = false;
    for (let next = index + 1; next < transcript.length; next += 1) {
      const later = transcript[next];
      if (!later || isUserMessage(later)) {
        continue;
      }
      if (later.kind === "activity" && later.label === RESUMED_SESSION_LABEL) {
        continue;
      }
      read = true;
      break;
    }
    receipts.set(item.id, read);
  });
  return receipts;
}

function turnChangeCardPositions(
  transcript: readonly TimelineTranscriptItem[],
  turnChanges: readonly TurnChangeSummary[],
): ReadonlyMap<number, TurnChangeSummary[]> {
  const positions = new Map<number, TurnChangeSummary[]>();
  if (turnChanges.length === 0) return positions;
  const turnByEntry = new Map<string, TurnChangeSummary>();
  for (const turn of turnChanges)
    for (const entryId of turn.entryIds) turnByEntry.set(entryId, turn);
  const lastIndex = new Map<TurnChangeSummary, number>();
  transcript.forEach((item, index) => {
    if (item.kind !== "message") return;
    const turn = turnByEntry.get(item.sourceMessageId ?? item.id);
    if (turn) lastIndex.set(turn, index);
  });
  // Cards keep the capture order when several turns end at the same row.
  for (const turn of turnChanges) {
    let index = lastIndex.get(turn);
    if (index === undefined) continue;
    while (index + 1 < transcript.length && !startsAnotherTurn(transcript[index + 1], turn)) {
      index += 1;
    }
    positions.set(index, [...(positions.get(index) ?? []), turn]);
  }
  return positions;

  function startsAnotherTurn(item: TimelineTranscriptItem | undefined, turn: TurnChangeSummary) {
    // A later extension message or card is not part of the turn's work, so the card stays above it.
    if (item?.kind === "custom" || item?.kind === "card") return true;
    if (item?.kind !== "message") return false;
    const owner = turnByEntry.get(item.sourceMessageId ?? item.id);
    return item.role === "user" || (owner !== undefined && owner !== turn);
  }
}
