import assert from "node:assert/strict";
import test from "node:test";
import { filterPoisonedProviderMessages } from "../dist/invalid-tool-call-guard.js";

const assistantBase = {
  role: "assistant",
  api: "openai-responses",
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
  stopReason: "toolUse",
  timestamp: Date.now(),
};

await test("guard strips truncated empty bash call and its not-executed result", () => {
  const messages = [
    { role: "system", content: "sys", timestamp: Date.now() },
    { role: "user", content: "hi", timestamp: Date.now() },
    {
      ...assistantBase,
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "toolCall", id: "call-bad", name: "bash", arguments: {} },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-bad",
      toolName: "bash",
      content: [
        {
          type: "text",
          text: 'Tool call "bash" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
        },
      ],
      isError: true,
      timestamp: Date.now(),
    },
    {
      ...assistantBase,
      content: [{ type: "text", text: "recovered" }],
      stopReason: "stop",
    },
  ];

  const filtered = filterPoisonedProviderMessages(messages as never);
  assert.ok(filtered, "expected a replacement payload");
  const text = JSON.stringify(filtered);
  assert.doesNotMatch(text, /call-bad/);
  assert.doesNotMatch(text, /was not executed/);
  assert.match(text, /recovered/);
  assert.match(text, /sys/);
});

await test("guard drops orphan outputs and keeps valid pairs", () => {
  const messages = [
    {
      ...assistantBase,
      content: [
        { type: "toolCall", id: "call-good", name: "bash", arguments: { command: "echo hi" } },
        { type: "toolCall", id: "call-empty", name: "bash", arguments: {} },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-good",
      toolName: "bash",
      content: [{ type: "text", text: "hi" }],
      isError: false,
      timestamp: Date.now(),
    },
    {
      role: "toolResult",
      toolCallId: "call-orphan",
      toolName: "bash",
      content: [{ type: "text", text: "stale" }],
      isError: false,
      timestamp: Date.now(),
    },
  ];

  const filtered = filterPoisonedProviderMessages(messages as never);
  assert.ok(filtered, "expected a replacement payload");
  const text = JSON.stringify(filtered);
  assert.match(text, /call-good/);
  assert.doesNotMatch(text, /call-empty/);
  assert.doesNotMatch(text, /call-orphan/);
});

await test("guard returns void when the payload is clean", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: Date.now() },
    {
      ...assistantBase,
      content: [
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "hi" }],
      isError: false,
      timestamp: Date.now(),
    },
  ];

  assert.equal(filterPoisonedProviderMessages(messages as never), undefined);
});

await test("guard preserves successful tool output containing diagnostic phrases", () => {
  const messages = [
    {
      ...assistantBase,
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "guard.ts" } }],
    },
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [
        { type: "text", text: 'source: "output token limit" and "validation failed for tool"' },
      ],
      isError: false,
      timestamp: Date.now(),
    },
  ];
  assert.equal(filterPoisonedProviderMessages(messages as never), undefined);
});

await test("guard preserves ordinary tool errors mentioning the output token limit", () => {
  const messages = [
    {
      ...assistantBase,
      content: [
        { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "run-tests" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "bash-1",
      toolName: "bash",
      content: [
        { type: "text", text: "Test failed: output token limit was not executed correctly" },
      ],
      isError: true,
      timestamp: Date.now(),
    },
  ];
  assert.equal(filterPoisonedProviderMessages(messages as never), undefined);
});
