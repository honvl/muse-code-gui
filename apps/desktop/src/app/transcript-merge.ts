import type { SelectedTranscriptRecord } from "../../contracts/desktop-state";

/**
 * Apply a pushed transcript record to the rows a consumer already holds.
 *
 * Main only sends the rows from `replacedFrom` on (see
 * `electron/windows/transcript-incremental.ts`), so every renderer consumer of
 * `onSelectedTranscriptChanged` must splice rather than replace. Returning
 * `needsPull` means a tail arrived that does not line up with the held rows; the
 * caller should fetch the full transcript instead of showing a partial thread.
 */
export function mergePushedTranscript(
  previous: SelectedTranscriptRecord | null,
  next: SelectedTranscriptRecord | null,
): { readonly record: SelectedTranscriptRecord | null; readonly needsPull: boolean } {
  if (!next || next.replacedFrom === undefined) {
    return { record: next, needsPull: false };
  }
  const from = next.replacedFrom;
  if (
    !previous ||
    previous.workspaceId !== next.workspaceId ||
    previous.sessionId !== next.sessionId ||
    from > previous.transcript.length
  ) {
    return { record: previous, needsPull: true };
  }
  return {
    record: {
      ...next,
      transcript: [...previous.transcript.slice(0, from), ...next.transcript],
    },
    needsPull: false,
  };
}
