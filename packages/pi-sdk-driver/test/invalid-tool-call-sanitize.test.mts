import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sanitizeInvalidToolCallHistory } from "../dist/session-supervisor-utils.js";

const assistantBase = {
  role: "assistant" as const,
  api: "openai-responses" as const,
  provider: "meta",
  model: "muse-spark-1.3-contributor",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse" as const,
  timestamp: Date.now(),
};

await test("sanitize omits invalid bash toolCall pair but keeps valid sibling", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
  const assistantId = manager.appendMessage({
    ...assistantBase,
    content: [
      { type: "toolCall", id: "call-bad", name: "bash", arguments: {} },
      { type: "text", text: "tracing obsolete jobs" },
      {
        type: "toolCall",
        id: "call-good",
        name: "bash",
        arguments: { command: "echo hi" },
      },
    ],
  });
  const badResultId = manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-bad",
    toolName: "bash",
    content: [{ type: "text", text: 'Validation failed for tool "bash":\n  - command: must have required properties' }],
    isError: true,
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-good",
    toolName: "bash",
    content: [{ type: "text", text: "(no output)" }],
    isError: false,
    timestamp: Date.now(),
  });

  const edits = sanitizeInvalidToolCallHistory(manager);
  assert.ok(edits >= 2, `expected at least 2 edits, got ${edits}`);

  const projection = manager.buildSessionProjection();
  const projectedText = JSON.stringify(projection.messages);
  assert.doesNotMatch(projectedText, /call-bad/);
  assert.doesNotMatch(projectedText, /Validation failed for tool/);
  assert.match(projectedText, /call-good/);

  // Display projection keeps the original attempt visible.
  const display = manager.buildContextEntries();
  const displayText = JSON.stringify(display);
  assert.match(displayText, /call-bad/);

  // Idempotent: second run appends nothing.
  const second = sanitizeInvalidToolCallHistory(manager);
  assert.equal(second, 0);

  // Sanity on ids (unused vars guard against refactor drift).
  assert.ok(assistantId && badResultId);
});

await test("sanitize omits empty assistant error messages from 400s", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
  const errorId = manager.appendMessage({
    ...assistantBase,
    content: [],
    stopReason: "error" as const,
    errorMessage:
      'meta API error (400): {"code":null,"message":"The request contains invalid parameters."}',
  });

  const edits = sanitizeInvalidToolCallHistory(manager);
  assert.equal(edits, 1);

  const projection = manager.buildSessionProjection();
  const ids = projection.entries.map((entry) => entry.sourceEntry.id);
  // The error entry itself is still in the path, but projects to zero messages.
  const errorProjection = projection.entries.find((entry) => entry.sourceEntry.id === errorId);
  assert.ok(errorProjection);
  assert.equal(errorProjection.messages.length, 0);
  assert.ok(ids.length > 0);
});
