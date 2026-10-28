import type { DesktopAppState } from "../../contracts/desktop-state";

/**
 * Why the app keeps running after its last window closes: the main process
 * owns work that a quit would destroy. This answers only "is there any?" so the
 * window-all-closed handler can quit when the answer is no, instead of leaving
 * an idle process in the dock forever.
 *
 * Anything counted here must be something a quit would actually interrupt:
 * - a session mid-run (the turn dies and its transcript is left half-written);
 * - a background shell task, which outlives the turn that started it by design;
 * - an active scheduled task, which only fires while the app is open.
 *
 * Drafts are not included: the window close already flushes them before the
 * window goes away.
 */
export interface ActiveWorkInput {
  readonly workspaces: DesktopAppState["workspaces"];
  readonly scheduledTasks: DesktopAppState["scheduledTasks"];
  readonly runningBackgroundTasks: number;
}

export function hasActiveWork(input: ActiveWorkInput): boolean {
  if (input.runningBackgroundTasks > 0) return true;
  const runningSession = input.workspaces.some((workspace) =>
    workspace.sessions.some((session) => session.status === "running"),
  );
  if (runningSession) return true;
  return input.scheduledTasks.some((task) => task.status === "active");
}

/** Short reason for the log, or undefined when nothing is running. */
export function describeActiveWork(input: ActiveWorkInput): string | undefined {
  const parts: string[] = [];
  const running = input.workspaces.reduce(
    (count, workspace) =>
      count + workspace.sessions.filter((session) => session.status === "running").length,
    0,
  );
  if (running > 0) parts.push(`${running} running thread${running === 1 ? "" : "s"}`);
  if (input.runningBackgroundTasks > 0) {
    parts.push(
      `${input.runningBackgroundTasks} background task${input.runningBackgroundTasks === 1 ? "" : "s"}`,
    );
  }
  const scheduled = input.scheduledTasks.filter((task) => task.status === "active").length;
  if (scheduled > 0) parts.push(`${scheduled} scheduled task${scheduled === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}
