import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundTaskSnapshot } from "@pi-gui/pi-sdk-driver";
import type { PiDesktopApi } from "../../../contracts/ipc";

export interface SidebarActivityTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
}

export interface SidebarActivityTask {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly task: BackgroundTaskSnapshot;
}

const POLL_INTERVAL_MS = 3000;

function targetKey(target: SidebarActivityTarget): string {
  return `${target.workspaceId}:${target.sessionId}`;
}

/**
 * Polls background bash tasks for the given (usually running) sessions.
 * Renderer-only aggregation over the existing per-thread IPC — no new
 * main/preload surface. Retains keys that had running tasks so a task that
 * outlives its run still clears instead of going stale.
 */
export function useSidebarActivity(
  api: PiDesktopApi | undefined,
  targets: readonly SidebarActivityTarget[],
): {
  readonly runningTasks: readonly SidebarActivityTask[];
  readonly stoppingTaskId: string | undefined;
  readonly stopTask: (workspaceId: string, sessionId: string, taskId: string) => void;
  readonly refresh: () => void;
} {
  const [tasksByKey, setTasksByKey] = useState<ReadonlyMap<string, SidebarActivityTask[]>>(
    () => new Map(),
  );
  const [stoppingTaskId, setStoppingTaskId] = useState<string | undefined>(undefined);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const apiRef = useRef(api);
  apiRef.current = api;
  const pollKeysRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(() => {
    const desktopApi = apiRef.current;
    const current = targetsRef.current;
    if (!desktopApi || current.length === 0) {
      return;
    }
    const byTitle = new Map(current.map((target) => [targetKey(target), target]));
    // Keep polling sessions that had running tasks last round.
    for (const key of pollKeysRef.current) {
      if (!byTitle.has(key)) {
        const [workspaceId, sessionId] = key.split(":");
        if (workspaceId && sessionId) {
          byTitle.set(key, { workspaceId, sessionId, title: "" });
        }
      }
    }
    void Promise.all(
      [...byTitle.values()].map((target) =>
        desktopApi
          .listBackgroundTasks({ workspaceId: target.workspaceId, sessionId: target.sessionId })
          .then((tasks) => ({ target, tasks }))
          .catch(() => ({ target, tasks: [] as readonly BackgroundTaskSnapshot[] })),
      ),
    ).then(
      (results) => {
        // Drop if targets changed mid-flight; next tick repolls.
        const next = new Map<string, SidebarActivityTask[]>();
        const nextPollKeys = new Set<string>();
        for (const { target, tasks } of results) {
          const running = tasks.filter((task) => task.status === "running");
          if (running.length > 0) {
            const key = targetKey(target);
            nextPollKeys.add(key);
            next.set(
              key,
              running.map((task) => ({
                workspaceId: target.workspaceId,
                sessionId: target.sessionId,
                title: target.title,
                task,
              })),
            );
          }
        }
        pollKeysRef.current = nextPollKeys;
        setTasksByKey(next);
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    setTasksByKey(new Map());
    setStoppingTaskId(undefined);
    pollKeysRef.current = new Set();
    if (!api || targets.length === 0) {
      return undefined;
    }
    refresh();
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [api, targets, refresh]);

  const stopTask = useCallback((workspaceId: string, sessionId: string, taskId: string) => {
    const desktopApi = apiRef.current;
    if (!desktopApi) {
      return;
    }
    setStoppingTaskId(taskId);
    void desktopApi
      .stopBackgroundTask({ workspaceId, sessionId }, taskId)
      .then(() => {
        apiRef.current
          ?.listBackgroundTasks({ workspaceId, sessionId })
          .then((tasks) => {
            const key = `${workspaceId}:${sessionId}`;
            setTasksByKey((prev) => {
              const next = new Map(prev);
              const running = tasks.filter((task) => task.status === "running");
              if (running.length === 0) {
                next.delete(key);
                pollKeysRef.current.delete(key);
              } else {
                const title =
                  targetsRef.current.find(
                    (target) =>
                      target.workspaceId === workspaceId && target.sessionId === sessionId,
                  )?.title ?? "";
                next.set(
                  key,
                  running.map((task) => ({ workspaceId, sessionId, title, task })),
                );
              }
              return next;
            });
          })
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        console.error("[renderer] stopBackgroundTask failed", error);
      })
      .finally(() => {
        setStoppingTaskId((stopping) => (stopping === taskId ? undefined : stopping));
      });
  }, []);

  const runningTasks = [...tasksByKey.values()].flat();
  return { runningTasks, stoppingTaskId, stopTask, refresh };
}
