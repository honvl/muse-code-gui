import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import type { BackgroundTaskOutput, BackgroundTaskSnapshot } from "@pi-gui/pi-sdk-driver";
import { createConversationOwner } from "../../electron/conversation/app-store-composer";

const sessionRef: SessionRef = { workspaceId: "ws", sessionId: "sess" };

function task(overrides: Partial<BackgroundTaskSnapshot> = {}): BackgroundTaskSnapshot {
  return {
    taskId: "bg_test",
    command: "sleep 30",
    cwd: "/tmp",
    workspaceId: "ws",
    sessionId: "sess",
    startedAt: new Date(0).toISOString(),
    status: "running",
    outputBytes: 0,
    truncated: false,
    ...overrides,
  };
}

function ownerHost(driver: Record<string, unknown>) {
  return {
    initialize: async () => undefined,
    driver,
  };
}

test("listBackgroundTasks returns the driver's tasks for the thread", async () => {
  const tasks = [task(), task({ taskId: "bg_done", status: "completed", exitCode: 0 })];
  const seen: SessionRef[] = [];
  const owner = createConversationOwner(
    ownerHost({
      listBackgroundTasks: async (ref: SessionRef) => {
        seen.push(ref);
        return tasks;
      },
    }) as never,
  );

  await expect(owner.listBackgroundTasks(sessionRef)).resolves.toEqual(tasks);
  expect(seen).toEqual([sessionRef]);
});

test("stopBackgroundTask stops then returns the refreshed list", async () => {
  const calls: Array<{ ref: SessionRef; taskId: string }> = [];
  const refreshed = [task({ status: "stopped" })];
  const owner = createConversationOwner(
    ownerHost({
      stopBackgroundTask: async (ref: SessionRef, taskId: string) => {
        calls.push({ ref, taskId });
      },
      listBackgroundTasks: async () => refreshed,
    }) as never,
  );

  await expect(owner.stopBackgroundTask(sessionRef, "bg_test")).resolves.toEqual(refreshed);
  expect(calls).toEqual([{ ref: sessionRef, taskId: "bg_test" }]);
});

test("readBackgroundTask forwards the id and window options", async () => {
  const output: BackgroundTaskOutput = {
    taskId: "bg_test",
    status: "running",
    output: "hello",
    outputOffset: 0,
    outputBytes: 5,
    truncated: false,
  };
  const seen: Array<{ taskId: string; options?: { offset?: number; limit?: number } }> = [];
  const owner = createConversationOwner(
    ownerHost({
      readBackgroundTask: async (
        _ref: SessionRef,
        taskId: string,
        options?: { offset?: number; limit?: number },
      ) => {
        seen.push({ taskId, options });
        return output;
      },
    }) as never,
  );

  await expect(
    owner.readBackgroundTask(sessionRef, "bg_test", { offset: 3, limit: 10 }),
  ).resolves.toEqual(output);
  expect(seen).toEqual([{ taskId: "bg_test", options: { offset: 3, limit: 10 } }]);
});

test("stopBackgroundTask surfaces unknown-task errors", async () => {
  const owner = createConversationOwner(
    ownerHost({
      stopBackgroundTask: async () => {
        throw new Error("Unknown background task: bg_missing.");
      },
      listBackgroundTasks: async () => [],
    }) as never,
  );

  await expect(owner.stopBackgroundTask(sessionRef, "bg_missing")).rejects.toThrow(
    /Unknown background task/,
  );
});
