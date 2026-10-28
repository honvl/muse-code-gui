import type { SelectedTranscriptRecord } from "../../contracts/desktop-state";

/**
 * Turn a fresh transcript record into the smallest payload that brings the
 * renderer up to date.
 *
 * Timeline rows are immutable once settled: appending a token or updating a tool
 * row copies the array and replaces only the affected item, so every unchanged
 * row keeps its identity. Comparing by identity therefore finds the first changed
 * row without hashing message text, and the payload becomes "everything from
 * here on" — usually just the actively streaming assistant row instead of the
 * whole multi-megabyte transcript.
 *
 * `previous` must be the record the renderer actually holds (every push and pull
 * is tracked for that reason). Without it, or across a session switch, the full
 * list is sent.
 */
export function toIncrementalTranscript(
  previous: SelectedTranscriptRecord | null | undefined,
  next: SelectedTranscriptRecord,
): SelectedTranscriptRecord {
  if (
    !previous ||
    previous.workspaceId !== next.workspaceId ||
    previous.sessionId !== next.sessionId
  ) {
    return next;
  }
  const before = previous.transcript;
  const after = next.transcript;
  let index = 0;
  while (index < before.length && index < after.length && before[index] === after[index]) {
    index += 1;
  }
  // Nothing after the shared prefix: the list only shrank (a row was removed),
  // which the comparison already implies, so the empty tail truncates correctly.
  return { ...next, transcript: after.slice(index), replacedFrom: index };
}
