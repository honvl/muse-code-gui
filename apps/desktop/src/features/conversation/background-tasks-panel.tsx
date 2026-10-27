import { useState } from "react";
import type { BackgroundTaskOutput, BackgroundTaskSnapshot } from "@pi-gui/pi-sdk-driver";

const LONG_RUN_MS = 5 * 60 * 1000;

interface BackgroundTasksPanelProps {
  readonly tasks: readonly BackgroundTaskSnapshot[];
  readonly runningSince: string | undefined;
  readonly isRunning: boolean;
  readonly stoppingTaskId: string | undefined;
  readonly onStopTask: (taskId: string) => void;
  readonly onReadOutput: (taskId: string) => Promise<BackgroundTaskOutput>;
  readonly onStopRun: () => void;
}

/**
 * Background bash tasks for this thread, above the composer. Long shell work
 * started with `bash_background` keeps running here while the thread stays
 * free for steered turns; each task can be inspected and stopped. A separate
 * banner calls out runs past five minutes so a long foreground run can be
 * steered or stopped instead of stared at.
 */
export function BackgroundTasksPanel({
  tasks,
  runningSince,
  isRunning,
  stoppingTaskId,
  onStopTask,
  onReadOutput,
  onStopRun,
}: BackgroundTasksPanelProps) {
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const showLongRunBanner = isRunning && isLongRun(runningSince);
  if (tasks.length === 0 && !showLongRunBanner) {
    return null;
  }

  return (
    <div className="background-tasks" data-testid="background-tasks-panel">
      {showLongRunBanner ? (
        <div
          className="background-tasks__banner"
          data-testid="background-tasks-long-run-banner"
          role="status"
        >
          <span className="background-tasks__banner-text">
            Still working ({formatElapsed(runningSince)}) — long shell commands can run in the
            background via <code>bash_background</code>, and this thread stays responsive while they
            run. You can steer with a new message or stop the run.
          </span>
          <button
            className="button button--secondary background-tasks__banner-stop"
            data-testid="background-tasks-long-run-stop"
            type="button"
            onClick={onStopRun}
          >
            Stop run
          </button>
        </div>
      ) : null}
      {tasks.map((task) => (
        <BackgroundTaskRow
          key={task.taskId}
          task={task}
          stopping={stoppingTaskId === task.taskId}
          onStop={() => onStopTask(task.taskId)}
          onReadOutput={() => onReadOutput(task.taskId)}
        />
      ))}
      {runningCount > 0 ? (
        <div className="background-tasks__hint" data-testid="background-tasks-hint">
          {runningCount} background {runningCount === 1 ? "task" : "tasks"} running — the thread
          stays free for steered turns.
        </div>
      ) : null}
    </div>
  );
}

function BackgroundTaskRow({
  task,
  stopping,
  onStop,
  onReadOutput,
}: {
  readonly task: BackgroundTaskSnapshot;
  readonly stopping: boolean;
  readonly onStop: () => void;
  readonly onReadOutput: () => Promise<BackgroundTaskOutput>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState<BackgroundTaskOutput | undefined>(undefined);
  const [outputError, setOutputError] = useState<string | undefined>(undefined);
  const [loadingOutput, setLoadingOutput] = useState(false);

  const toggleOutput = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (output || loadingOutput) {
      return;
    }
    setLoadingOutput(true);
    setOutputError(undefined);
    onReadOutput()
      .then((next) => setOutput(next))
      .catch((error: unknown) => {
        setOutputError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoadingOutput(false));
  };

  return (
    <div
      className={`background-tasks__row background-tasks__row--${task.status}`}
      data-testid={`background-task-${task.taskId}`}
    >
      <span
        className={`background-tasks__status background-tasks__status--${task.status}`}
        data-testid={`background-task-status-${task.taskId}`}
      >
        {task.status}
      </span>
      <span className="background-tasks__command" title={task.command}>
        {task.taskId} · {truncateCommand(task.command)}
      </span>
      <span className="background-tasks__meta">
        {formatElapsed(task.startedAt)}
        {task.exitCode !== undefined ? ` · exit ${task.exitCode}` : null}
      </span>
      <button
        className="icon-button background-tasks__output-toggle"
        data-testid={`background-task-output-${task.taskId}`}
        type="button"
        onClick={toggleOutput}
        aria-expanded={expanded}
      >
        {expanded ? "Hide output" : "Output"}
      </button>
      {task.status === "running" ? (
        <button
          className="button button--secondary background-tasks__stop"
          data-testid={`background-task-stop-${task.taskId}`}
          disabled={stopping}
          type="button"
          onClick={onStop}
        >
          {stopping ? "Stopping…" : "Stop"}
        </button>
      ) : null}
      {expanded ? (
        <div className="background-tasks__output">
          {loadingOutput ? (
            <span className="background-tasks__output-loading">Loading output…</span>
          ) : outputError ? (
            <span className="background-tasks__output-error">{outputError}</span>
          ) : (
            <pre className="background-tasks__output-pre">
              {output && output.output.length > 0 ? output.output : "(no output yet)"}
              {output?.truncated ? "\n…truncated to window…" : null}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

function truncateCommand(command: string, limit = 80): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function isLongRun(runningSince: string | undefined): boolean {
  if (!runningSince) {
    return false;
  }
  const startedAt = Date.parse(runningSince);
  if (!Number.isFinite(startedAt)) {
    return false;
  }
  return Date.now() - startedAt >= LONG_RUN_MS;
}

function formatElapsed(since: string | undefined): string {
  if (!since) {
    return "";
  }
  const startedAt = Date.parse(since);
  if (!Number.isFinite(startedAt)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}
