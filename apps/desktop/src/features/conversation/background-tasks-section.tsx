import { BackgroundTasksPanel } from "./background-tasks-panel";
import { useBackgroundTasks } from "./hooks/use-background-tasks";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { WorkspaceSessionTarget } from "../../../contracts/desktop-state";

interface BackgroundTasksSectionProps {
  readonly api: PiDesktopApi | undefined;
  readonly target: WorkspaceSessionTarget | null;
  readonly runningSince: string | undefined;
  readonly isRunning: boolean;
  readonly onStopRun: () => void;
}

/**
 * Thread-level background bash tasks, mounted above the composer. Owns the
 * polling hook so App.tsx stays out of the refresh cycle.
 */
export function BackgroundTasksSection({
  api,
  target,
  runningSince,
  isRunning,
  onStopRun,
}: BackgroundTasksSectionProps) {
  const { tasks, stoppingTaskId, stopTask, readOutput } = useBackgroundTasks(api, target);
  return (
    <BackgroundTasksPanel
      tasks={tasks}
      runningSince={runningSince}
      isRunning={isRunning}
      stoppingTaskId={stoppingTaskId}
      onStopTask={stopTask}
      onReadOutput={readOutput}
      onStopRun={onStopRun}
    />
  );
}
