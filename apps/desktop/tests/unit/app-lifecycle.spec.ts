import { expect, test } from "@playwright/test";
import type { DesktopAppState } from "../../contracts/desktop-state";
import { describeActiveWork, hasActiveWork } from "../../electron/application/app-lifecycle";

type Sessions = DesktopAppState["workspaces"][number]["sessions"];
type Tasks = DesktopAppState["scheduledTasks"];

function sessions(...statuses: Array<"idle" | "running" | "failed">): Sessions {
  return statuses.map(
    (status, index) => ({ id: `s${index}`, title: `t${index}`, status }) as never,
  );
}

function workspaces(...statusGroups: Array<Array<"idle" | "running" | "failed">>) {
  return statusGroups.map((statuses, index) => ({
    id: `ws${index}`,
    sessions: sessions(...statuses),
  })) as unknown as DesktopAppState["workspaces"];
}

const activeTask = [{ id: "task-1", status: "active" }] as unknown as Tasks;
const pausedTask = [{ id: "task-2", status: "paused" }] as unknown as Tasks;

test("an idle app has no active work, so closing the last window quits", () => {
  expect(
    hasActiveWork({
      workspaces: workspaces(["idle", "failed"]),
      scheduledTasks: pausedTask,
      runningBackgroundTasks: 0,
    }),
  ).toBe(false);
});

test("a streaming thread keeps the app alive", () => {
  expect(
    hasActiveWork({
      workspaces: workspaces(["idle"], ["running"]),
      scheduledTasks: [],
      runningBackgroundTasks: 0,
    }),
  ).toBe(true);
});

test("a background shell task keeps the app alive", () => {
  expect(
    hasActiveWork({
      workspaces: workspaces(["idle"]),
      scheduledTasks: [],
      runningBackgroundTasks: 1,
    }),
  ).toBe(true);
});

test("an active scheduled task keeps the app alive", () => {
  expect(
    hasActiveWork({
      workspaces: workspaces(["idle"]),
      scheduledTasks: activeTask,
      runningBackgroundTasks: 0,
    }),
  ).toBe(true);
});

test("the log summary names what is still running", () => {
  expect(
    describeActiveWork({
      workspaces: workspaces(["running", "running"], ["idle"]),
      scheduledTasks: activeTask,
      runningBackgroundTasks: 2,
    }),
  ).toBe("2 running threads, 2 background tasks, 1 scheduled task");
  expect(
    describeActiveWork({
      workspaces: workspaces(["idle"]),
      scheduledTasks: [],
      runningBackgroundTasks: 0,
    }),
  ).toBeUndefined();
});
