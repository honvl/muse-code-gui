import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundTaskOutput, BackgroundTaskSnapshot } from "@pi-gui/pi-sdk-driver";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import type { WorkspaceSessionTarget } from "../../../../contracts/desktop-state";

const POLL_INTERVAL_MS = 3000;

interface UseBackgroundTasksResult {
  readonly tasks: readonly BackgroundTaskSnapshot[];
  readonly stoppingTaskId: string | undefined;
  readonly stopTask: (taskId: string) => void;
  readonly readOutput: (taskId: string) => Promise<BackgroundTaskOutput>;
  readonly refresh: () => void;
}

/**
 * Polls the main process for this thread's background bash tasks while the
 * conversation view is mounted. Polling (not snapshot state) keeps the
 * 3s tick out of the global state revision cycle.
 */
export function useBackgroundTasks(
  api: PiDesktopApi | undefined,
  target: WorkspaceSessionTarget | null,
): UseBackgroundTasksResult {
  const [tasks, setTasks] = useState<readonly BackgroundTaskSnapshot[]>([]);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | undefined>(undefined);
  const targetKey = target ? `${target.workspaceId}:${target.sessionId}` : null;
  const targetRef = useRef(target);
  targetRef.current = target;

  const refresh = useCallback(() => {
    const current = targetRef.current;
    if (!api || !current) {
      return;
    }
    void api
      .listBackgroundTasks(current)
      .then((next) => {
        if (targetRef.current === current) {
          setTasks(next);
        }
      })
      .catch((error: unknown) => {
        console.error("[renderer] listBackgroundTasks failed", error);
      });
  }, [api]);

  useEffect(() => {
    setTasks([]);
    setStoppingTaskId(undefined);
    if (!api || !targetKey) {
      return undefined;
    }
    refresh();
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [api, targetKey, refresh]);

  const stopTask = useCallback(
    (taskId: string) => {
      const current = targetRef.current;
      if (!api || !current) {
        return;
      }
      setStoppingTaskId(taskId);
      void api
        .stopBackgroundTask(current, taskId)
        .then((next) => {
          if (targetRef.current === current) {
            setTasks(next);
          }
        })
        .catch((error: unknown) => {
          console.error("[renderer] stopBackgroundTask failed", error);
        })
        .finally(() => {
          setStoppingTaskId((stopping) => (stopping === taskId ? undefined : stopping));
        });
    },
    [api],
  );

  const readOutput = useCallback(
    (taskId: string): Promise<BackgroundTaskOutput> => {
      const current = targetRef.current;
      if (!api || !current) {
        return Promise.reject(new Error("No thread selected."));
      }
      return api.readBackgroundTask(current, taskId).then((output) => {
        refresh();
        return output;
      });
    },
    [api, refresh],
  );

  return { tasks, stoppingTaskId, stopTask, readOutput, refresh };
}
