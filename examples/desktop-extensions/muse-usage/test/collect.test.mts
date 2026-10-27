import assert from "node:assert/strict";
import test from "node:test";
import { reduceThread, summarizeModels, type CollectOptions } from "../collect.ts";
import { META_PROVIDER, summarizePeriod } from "../model.ts";

const hour = 3_600_000;
const now = Date.parse("2026-10-26T12:00:00.000Z");

function assistant(
  time: number,
  provider: string,
  model: string,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number },
  content: unknown[] = [{ type: "text", text: "done" }],
): unknown {
  return {
    type: "message",
    timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant",
      timestamp: time,
      provider,
      model,
      content,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        ...(usage.cost !== undefined ? { cost: { total: usage.cost } } : {}),
      },
    },
  };
}

const isSubscription: CollectOptions["isSubscription"] = (provider) => provider === "meta";
const modelName: CollectOptions["modelName"] = (_provider, model) => model;

await test("attributes usage per provider and zeroes subscription cost", async () => {
  const thread = reduceThread({
    id: "t1",
    title: "Thread",
    lastActiveAt: now,
    entries: [
      assistant(now - hour, "meta", "muse-spark-1.3", { input: 100, output: 50, cost: 3.5 }),
      assistant(now - hour, "other", "other-model", { input: 10, output: 10, cost: 1.25 }),
    ],
    current: false,
    modelName,
    isSubscription,
  });
  assert.equal(thread.metaTokens, 150);
  assert.equal(thread.totalTokens, 170);
  assert.equal(thread.subscription, false);
  // Meta cost zeroed, other provider keeps list-price cost.
  const metaDay = thread.days[0].providers[META_PROVIDER];
  assert.equal(metaDay.cost, 0);
  assert.equal(thread.days[0].providers["other"].cost, 1.25);
  assert.equal(thread.replies, 2);
  assert.equal(thread.models.length, 2);
});

await test("subscription is true when every model is subscription-backed", async () => {
  const thread = reduceThread({
    id: "t1",
    title: "Thread",
    lastActiveAt: now,
    entries: [assistant(now - hour, "meta", "muse-spark-1.3", { input: 100, output: 50 })],
    current: false,
    modelName,
    isSubscription,
  });
  assert.equal(thread.subscription, true);
});

await test("summarizeModels puts meta first, then by tokens", async () => {
  const a = reduceThread({
    id: "a",
    title: "A",
    lastActiveAt: now,
    entries: [
      assistant(now - hour, "other", "big-model", { input: 10000, output: 100 }),
      assistant(now - hour, "meta", "muse-wonder-1.0", { input: 10, output: 10 }),
    ],
    current: false,
    modelName,
    isSubscription: () => false,
  });
  const models = summarizeModels([a], () => false);
  assert.equal(models[0].provider, META_PROVIDER);
  assert.equal(models[0].model, "muse-wonder-1.0");
  assert.equal(models[1].model, "big-model");
});

await test("summarizePeriod buckets by period", async () => {
  const thread = reduceThread({
    id: "t1",
    title: "Thread",
    lastActiveAt: now,
    entries: [
      assistant(now - hour, "meta", "muse-spark-1.3", { input: 100, output: 50 }),
      assistant(now - 10 * 24 * hour, "meta", "muse-spark-1.3", { input: 1000, output: 500 }),
    ],
    current: false,
    modelName,
    isSubscription,
  });
  const today = summarizePeriod([thread], "today", now);
  assert.equal(today.metaTokens, 150);
  const all = summarizePeriod([thread], "all", now);
  assert.equal(all.metaTokens, 1650);
  assert.equal(all.threadCount, 1);
});

await test("summarizePeriod discriminates input, output and cache", async () => {
  const thread = reduceThread({
    id: "t1",
    title: "Thread",
    lastActiveAt: now,
    entries: [
      assistant(now - hour, "meta", "muse-spark-1.3", {
        input: 100,
        output: 50,
        cacheRead: 1000,
        cacheWrite: 200,
      }),
      assistant(now - hour, "other", "other-model", {
        input: 10,
        output: 10,
        cacheRead: 5,
        cacheWrite: 5,
      }),
    ],
    current: false,
    modelName,
    isSubscription,
  });
  const summary = summarizePeriod([thread], "all", now);
  // Meta only: the other provider's tokens land in the totals, not the split.
  assert.deepEqual(
    { ...summary.meta },
    {
      input: 100,
      output: 50,
      cacheRead: 1000,
      cacheWrite: 200,
      cost: 0,
    },
  );
  assert.equal(summary.totalTokens, 1380);
});

await test("malformed entries never throw", async () => {
  const thread = reduceThread({
    id: "t1",
    title: "Thread",
    lastActiveAt: now,
    entries: [null, 42, "nope", { type: "message" }, { type: "message", message: null }],
    current: false,
    modelName,
    isSubscription,
  });
  assert.equal(thread.replies, 0);
  assert.equal(thread.totalTokens, 0);
});
