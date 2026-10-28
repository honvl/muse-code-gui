import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackgroundTaskStore } from "../dist/background-tasks.js";
import {
  createBackgroundTaskRuntimeTools,
  bashBackgroundToolName,
  backgroundOutputToolName,
  backgroundStopToolName,
} from "../dist/background-task-extension.js";

async function withStore(fn: (store: BackgroundTaskStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-tasks-"));
  const store = new BackgroundTaskStore(join(dir, "logs"));
  try {
    await fn(store, dir);
  } finally {
    store.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, stepMs = 50): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

await test("start returns immediately while the command keeps running", async () => {
  await withStore(async (store, dir) => {
    const before = Date.now();
    const taskId = store.start("sleep 5; echo done-marker", { cwd: dir });
    const elapsed = Date.now() - before;
    assert.ok(taskId.startsWith("bg_"));
    // Returns without waiting for the 5s command.
    assert.ok(elapsed < 2000, `start blocked for ${elapsed}ms`);
    assert.equal(store.get(taskId)?.status, "running");
    await waitFor(() => store.get(taskId)?.status !== "running");
    assert.equal(store.get(taskId)?.status, "completed");
    const output = await store.read(taskId);
    assert.match(output.output, /done-marker/);
    assert.equal(output.exitCode, 0);
  });
});

await test("read returns a tail window and offset reads fetch new output", async () => {
  await withStore(async (store, dir) => {
    const taskId = store.start("echo first; sleep 1; echo second", { cwd: dir });
    await waitFor(() => store.get(taskId)?.status !== "running");
    const tail = await store.read(taskId, { limit: 1024 });
    assert.match(tail.output, /first/);
    assert.match(tail.output, /second/);
    const fromZero = await store.read(taskId, { offset: 0, limit: 5 });
    assert.equal(fromZero.outputOffset, 0);
    assert.ok(fromZero.output.length > 0);
  });
});

await test("stop kills a running task and reports stopped", async () => {
  await withStore(async (store, dir) => {
    const taskId = store.start("sleep 60", { cwd: dir });
    assert.equal(store.get(taskId)?.status, "running");
    const snapshot = store.stop(taskId);
    assert.equal(snapshot.status, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The close handler must not flip a stopped task back to failed/completed.
    assert.equal(store.get(taskId)?.status, "stopped");
  });
});

await test("stop on a finished task is a no-op reporting its status", async () => {
  await withStore(async (store, dir) => {
    const taskId = store.start("echo hi", { cwd: dir });
    await waitFor(() => store.get(taskId)?.status !== "running");
    const snapshot = store.stop(taskId);
    assert.equal(snapshot.status, "completed");
  });
});

await test("unknown task ids throw", async () => {
  await withStore(async (store) => {
    assert.throws(() => store.stop("bg_missing"), /Unknown background task/);
    await assert.rejects(store.read("bg_missing"), /Unknown background task/);
    assert.equal(store.get("bg_missing"), undefined);
  });
});

await test("empty commands are rejected", async () => {
  await withStore(async (store, dir) => {
    assert.throws(() => store.start("   ", { cwd: dir }), /non-empty command/);
  });
});

await test("list filters by session and running state", async () => {
  await withStore(async (store, dir) => {
    const a = store.start("sleep 30", { cwd: dir, sessionId: "s1" });
    const b = store.start("echo quick", { cwd: dir, sessionId: "s2" });
    await waitFor(() => store.get(b)?.status !== "running");
    assert.deepEqual(
      store.list({ sessionId: "s1" }).map((entry) => entry.taskId),
      [a],
    );
    assert.deepEqual(
      store.list({ includeFinished: false }).map((entry) => entry.taskId),
      [a],
    );
    assert.equal(store.list().length, 2);
    store.stop(a);
  });
});

await test("tool definitions expose background start/poll/stop tools", async () => {
  await withStore(async (store, dir) => {
    const tools = createBackgroundTaskRuntimeTools(store, () => ({
      workspaceId: "w1",
      sessionId: "s1",
    }));
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(
      names,
      [backgroundOutputToolName, backgroundStopToolName, bashBackgroundToolName].sort(),
    );
    const start = tools.find((tool) => tool.name === bashBackgroundToolName)!;
    const fakeCtx = { cwd: dir, sessionManager: { getSessionId: () => "s1" } };
    const started = await start.execute(
      "call-1",
      { command: "sleep 30" },
      undefined,
      undefined,
      fakeCtx as never,
    );
    const taskId = (started.details as { taskId?: string }).taskId;
    assert.ok(taskId?.startsWith("bg_"));
    assert.match((started.content[0] as { text: string }).text, new RegExp(taskId!));

    const poll = tools.find((tool) => tool.name === backgroundOutputToolName)!;
    const reading = await poll.execute(
      "call-2",
      { task_id: taskId },
      undefined,
      undefined,
      fakeCtx as never,
    );
    assert.equal((reading.details as { status?: string }).status, "running");

    const stop = tools.find((tool) => tool.name === backgroundStopToolName)!;
    const stopped = await stop.execute(
      "call-3",
      { task_id: taskId },
      undefined,
      undefined,
      fakeCtx as never,
    );
    assert.equal((stopped.details as { status?: string }).status, "stopped");

    const missing = await poll.execute(
      "call-4",
      { task_id: "bg_missing" },
      undefined,
      undefined,
      fakeCtx as never,
    );
    assert.match((missing.details as { error?: string }).error ?? "", /Unknown background task/);
  });
});

await test("tool start validates its input without spawning", async () => {
  await withStore(async (store) => {
    const tools = createBackgroundTaskRuntimeTools(store);
    const start = tools.find((tool) => tool.name === bashBackgroundToolName)!;
    const fakeCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "s1" } };
    const result = await start.execute("call-1", {}, undefined, undefined, fakeCtx as never);
    assert.match((result.details as { error?: string }).error ?? "", /non-empty command/);
    assert.equal(store.list().length, 0);
  });
});

await test("a task that finishes on its own is announced exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-settled-"));
  const settled: Array<{ taskId: string; status: string }> = [];
  const store = new BackgroundTaskStore(join(dir, "logs"), (task) =>
    settled.push({ taskId: task.taskId, status: task.status }),
  );
  try {
    const id = store.start("exit 0", { cwd: dir });
    await waitFor(() => settled.length > 0);
    assert.deepEqual(settled, [{ taskId: id, status: "completed" }]);
    // Settling is announced once: later reads must not re-announce.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled.length, 1);
  } finally {
    store.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("a stopped task is not announced, so Stop never wakes the thread", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-stopped-"));
  const settled: string[] = [];
  const store = new BackgroundTaskStore(join(dir, "logs"), (task) => settled.push(task.taskId));
  try {
    const id = store.start("sleep 30", { cwd: dir });
    await waitFor(() => store.get(id)?.status === "running");
    store.stop(id);
    await waitFor(() => store.get(id)?.status === "stopped");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(settled, []);
  } finally {
    store.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
