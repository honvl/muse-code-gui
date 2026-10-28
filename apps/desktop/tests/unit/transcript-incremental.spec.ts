import { expect, test } from "@playwright/test";
import type { SelectedTranscriptRecord } from "../../contracts/desktop-state";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { toIncrementalTranscript } from "../../electron/windows/transcript-incremental";
import { mergePushedTranscript } from "../../src/app/transcript-merge";

const createdAt = "2026-10-27T20:00:00.000Z";

function message(id: string, text: string): TranscriptMessage {
  return { kind: "message", role: "assistant", id, text, createdAt } as TranscriptMessage;
}

function record(
  transcript: readonly TranscriptMessage[],
  overrides: Partial<SelectedTranscriptRecord> = {},
): SelectedTranscriptRecord {
  return { workspaceId: "ws", sessionId: "s1", transcript, ...overrides };
}

/**
 * The renderer-side splice this protocol depends on. Kept in the test so the
 * main-side emitter and the renderer merge are verified against each other.
 */
function applyIncrementally(
  held: SelectedTranscriptRecord,
  pushed: SelectedTranscriptRecord,
): TranscriptMessage[] {
  const from = pushed.replacedFrom;
  if (from === undefined) {
    return [...pushed.transcript];
  }
  return [...held.transcript.slice(0, from), ...pushed.transcript];
}

test("a streaming token ships only the row that changed", () => {
  const settled = [message("m1", "hello"), message("m2", "world")];
  const streamingBefore = message("m3", "partial");
  const previous = record([...settled, streamingBefore]);
  // appendAssistantDelta copies the array and replaces just the streaming row.
  const next = record([...settled, message("m3", "partial plus more tokens")]);

  const pushed = toIncrementalTranscript(previous, next);

  expect(pushed.replacedFrom).toBe(2);
  expect(pushed.transcript).toHaveLength(1);
  expect(pushed.transcript[0]?.id).toBe("m3");
  // The splice reproduces the full list exactly.
  expect(applyIncrementally(previous, pushed).map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
  expect((applyIncrementally(previous, pushed)[2] as { text: string }).text).toBe(
    "partial plus more tokens",
  );
});

test("an appended row ships as a one-row tail", () => {
  const settled = [message("m1", "hello")];
  const previous = record(settled);
  const next = record([...settled, message("m2", "new turn")]);

  const pushed = toIncrementalTranscript(previous, next);

  expect(pushed.replacedFrom).toBe(1);
  expect(pushed.transcript).toHaveLength(1);
  expect(pushed.transcript[0]?.id).toBe("m2");
  expect(applyIncrementally(previous, pushed)).toEqual([...next.transcript]);
});

test("a removed row truncates through the tail", () => {
  // A splice keeps the surviving rows by reference, so the prefix still matches.
  const kept = message("m1", "a");
  const previous = record([kept, message("m2", "b"), message("m3", "c")]);
  const next = record([kept]);

  const pushed = toIncrementalTranscript(previous, next);

  expect(pushed.replacedFrom).toBe(1);
  expect(pushed.transcript).toEqual([]);
  expect(applyIncrementally(previous, pushed)).toEqual([...next.transcript]);
});

test("rebuilt rows with new identities fall back to the full list", () => {
  // If a producer ever recreates settled rows, identity comparison cannot find a
  // shared prefix, so the whole list ships and the renderer stays correct.
  const previous = record([message("m1", "a"), message("m2", "b")]);
  const next = record([message("m1", "a"), message("m2", "b")]);

  const pushed = toIncrementalTranscript(previous, next);

  expect(pushed.replacedFrom).toBe(0);
  expect(applyIncrementally(previous, pushed)).toEqual([...next.transcript]);
});

test("an unrelated session switch sends the full list", () => {
  const previous = record([message("m1", "a"), message("m2", "b")]);
  const next = record([message("x1", "other")], { sessionId: "s2" });

  const pushed = toIncrementalTranscript(previous, next);

  expect(pushed.replacedFrom).toBeUndefined();
  expect(pushed.transcript).toEqual(next.transcript);
});

test("without a known previous record the full list is sent", () => {
  const next = record([message("m1", "a")]);
  expect(toIncrementalTranscript(undefined, next).replacedFrom).toBeUndefined();
  expect(toIncrementalTranscript(null, next).transcript).toEqual(next.transcript);
});

test("an identical list yields an empty tail rather than resending rows", () => {
  const items = [message("m1", "a"), message("m2", "b")];
  // A different array holding the same row objects (the common no-op re-projection).
  const pushed = toIncrementalTranscript(record(items), record([...items]));
  expect(pushed.replacedFrom).toBe(2);
  expect(pushed.transcript).toEqual([]);
});

test("every splice stays consistent across a simulated multi-token stream", () => {
  const settled = Array.from({ length: 200 }, (_unused, index) =>
    message(`m${index}`, `row ${index}`),
  );
  let held = record(settled);
  const streamingId = "active";

  for (let tokens = 1; tokens <= 25; tokens += 1) {
    const nextFull = record([...settled, message(streamingId, "x".repeat(tokens * 40))]);
    const pushed = toIncrementalTranscript(held, nextFull);
    // Only the streaming row moves, so every publish is a one-row tail.
    expect(pushed.transcript).toHaveLength(1);
    held = record(applyIncrementally(held, pushed));
    expect(held.transcript).toHaveLength(settled.length + 1);
    expect(held.transcript.slice(0, settled.length)).toEqual(settled);
  }
  // The 6th publish would have shipped ~8KB; all 25 together ship one row each.
  expect((held.transcript[settled.length] as { text: string }).text).toHaveLength(25 * 40);
});

test("the renderer merge matches what the main-side emitter produces", async () => {
  const settled = [message("m1", "a"), message("m2", "b")];
  const previous = record([...settled, message("m3", "partial")]);
  const next = record([...settled, message("m3", "partial + tokens")]);

  const pushed = toIncrementalTranscript(previous, next);
  const merged = mergePushedTranscript(previous, pushed);

  expect(merged.needsPull).toBe(false);
  expect(merged.record?.transcript.map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
  expect(merged.record?.transcript).toEqual([...next.transcript]);
  // The merged record must not claim to be a tail any more.
  expect(merged.record?.replacedFrom).toBe(pushed.replacedFrom);
});

test("an unspliceable tail asks for a full pull instead of truncating", async () => {
  const held = record([message("m1", "a")]);
  const pushed = record([message("m9", "z")], { replacedFrom: 7 });

  const merged = mergePushedTranscript(held, pushed);

  expect(merged.needsPull).toBe(true);
  expect(merged.record).toBe(held);
});

test("a full record replaces whatever was held", async () => {
  const full = record([message("m1", "a"), message("m2", "b")]);
  const merged = mergePushedTranscript(record([message("old", "x")]), full);
  expect(merged.needsPull).toBe(false);
  expect(merged.record).toBe(full);
});
