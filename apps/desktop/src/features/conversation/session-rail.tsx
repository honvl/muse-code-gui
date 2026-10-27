import { useState } from "react";
import type { BackgroundTaskOutput, BackgroundTaskSnapshot } from "@pi-gui/pi-sdk-driver";
import type { SessionRecord } from "../../../contracts/desktop-state";
import type { SessionUsageSnapshot } from "@pi-gui/session-driver";
import type { TurnChangeSummary } from "../../../contracts/review";
import { ContextMeter } from "./context-meter";
import { formatElapsed, truncateCommand } from "./session-task-format";

const LONG_RUN_MS = 5 * 60 * 1000;

interface SessionRailProps {
  readonly session: SessionRecord;
  readonly workspaceName: string;
  readonly workspacePath: string;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly usage: SessionUsageSnapshot | undefined;
  readonly tasks: readonly BackgroundTaskSnapshot[];
  readonly stoppingTaskId: string | undefined;
  readonly onStopTask: (taskId: string) => void;
  readonly onReadOutput: (taskId: string) => Promise<BackgroundTaskOutput>;
  readonly turns: readonly TurnChangeSummary[];
  readonly onOpenTurnChange: (turn: TurnChangeSummary, path: string) => void;
  readonly onStopRun: () => void;
}

/**
 * Session details rail inside the main chat column: where the thread runs,
 * what is running now (including background bash tasks with inspection and
 * Stop), what it changed, and context usage. Data is read-only projections
 * of renderer state; actions route through existing handlers.
 */
export function SessionRail({
  session,
  workspaceName,
  workspacePath,
  provider,
  modelId,
  thinkingLevel,
  usage,
  tasks,
  stoppingTaskId,
  onStopTask,
  onReadOutput,
  turns,
  onOpenTurnChange,
  onStopRun,
}: SessionRailProps) {
  const runningTasks = tasks.filter((task) => task.status === "running");
  const showLongRunBanner = session.status === "running" && isLongRun(session.runningSince);
  const changedFiles = recentChangedFiles(turns);

  return (
    <aside className="session-rail" data-testid="session-rail" aria-label="Session details">
      <div className="session-rail__header">
        <span className="session-rail__title">Session</span>
      </div>

      {showLongRunBanner ? (
        <div
          className="session-rail__banner"
          data-testid="session-rail-long-run-banner"
          role="status"
        >
          <span>
            Still working ({formatElapsed(session.runningSince)}) — long shell commands can run in
            the background via <code>bash_background</code>, and this thread stays responsive while
            they run.
          </span>
          <button
            className="button button--secondary session-rail__action"
            data-testid="session-rail-long-run-stop"
            type="button"
            onClick={onStopRun}
          >
            Stop run
          </button>
        </div>
      ) : null}

      <section className="session-rail__card" data-testid="session-rail-run">
        <h3 className="session-rail__card-title">Runs in</h3>
        <div className="session-rail__row" title={workspacePath}>
          {workspaceName}
        </div>
        <div
          className="session-rail__row session-rail__row--muted"
          data-testid="session-rail-model"
        >
          {provider && modelId ? `${provider} · ${modelId}` : "No model selected"}
          {thinkingLevel ? ` · ${thinkingLevel}` : null}
        </div>
      </section>

      <section className="session-rail__card" data-testid="session-rail-status">
        <h3 className="session-rail__card-title">Status</h3>
        <div className="session-rail__row">
          <span className={`session-rail__pip session-rail__pip--${session.status}`} />
          {session.status === "running"
            ? `Running · ${formatElapsed(session.runningSince)}`
            : session.status}
        </div>
        {session.status === "running" ? (
          <button
            className="button button--secondary session-rail__action"
            data-testid="session-rail-stop"
            type="button"
            onClick={onStopRun}
          >
            Stop run
          </button>
        ) : null}
        {tasks.length > 0 ? (
          <div className="session-rail__tasks">
            {tasks.map((task) => (
              <BackgroundTaskRow
                key={task.taskId}
                task={task}
                stopping={stoppingTaskId === task.taskId}
                onStop={() => onStopTask(task.taskId)}
                onReadOutput={() => onReadOutput(task.taskId)}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section className="session-rail__card" data-testid="session-rail-changes">
        <h3 className="session-rail__card-title">Changed</h3>
        {changedFiles.length === 0 ? (
          <div className="session-rail__row session-rail__row--muted">No file changes yet</div>
        ) : (
          <ul className="session-rail__files">
            {changedFiles.map((file) => (
              <li key={`${file.turn.checkpointId}:${file.path}`}>
                <button
                  className="session-rail__file"
                  data-testid={`session-rail-file-${file.turn.checkpointId}-${file.path}`}
                  type="button"
                  onClick={() => onOpenTurnChange(file.turn, file.path)}
                  title={file.path}
                >
                  {file.path}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="session-rail__card" data-testid="session-rail-context">
        <h3 className="session-rail__card-title">Context</h3>
        <ContextMeter usage={usage} />
      </section>
      {runningTasks.length > 0 ? (
        <div className="session-rail__hint">
          {runningTasks.length} background {runningTasks.length === 1 ? "task" : "tasks"} running —
          the thread stays free for steered turns.
        </div>
      ) : null}
    </aside>
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
      className={`session-rail__task session-rail__task--${task.status}`}
      data-testid={`session-rail-task-${task.taskId}`}
    >
      <span
        className={`session-rail__task-dot session-rail__task-dot--${task.status}`}
        aria-hidden="true"
      />
      <button
        className="session-rail__task-command"
        data-testid={`session-rail-task-output-${task.taskId}`}
        type="button"
        onClick={toggleOutput}
        aria-expanded={expanded}
        title={`${task.taskId} · ${task.command} — toggle output`}
      >
        {truncateCommand(task.command, 48)}
      </button>
      <span className="session-rail__task-meta">
        {formatElapsed(task.startedAt)}
        {task.exitCode !== undefined ? ` · exit ${task.exitCode}` : null}
      </span>
      {task.status === "running" ? (
        <button
          className="icon-button session-rail__task-stop"
          data-testid={`session-rail-task-stop-${task.taskId}`}
          disabled={stopping}
          type="button"
          onClick={onStop}
          aria-label={`Stop background task ${task.taskId}`}
        >
          ×
        </button>
      ) : null}
      {expanded ? (
        <div className="session-rail__output">
          {loadingOutput ? (
            <span className="session-rail__output-loading">Loading output…</span>
          ) : outputError ? (
            <span className="session-rail__output-error">{outputError}</span>
          ) : (
            <pre className="session-rail__output-pre">
              {output && output.output.length > 0 ? output.output : "(no output yet)"}
              {output?.truncated ? "\n…truncated to window…" : null}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
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

interface ChangedFileRef {
  readonly turn: TurnChangeSummary;
  readonly path: string;
}

/** Newest-first files across recent turns, deduplicated by path. */
function recentChangedFiles(
  turns: readonly TurnChangeSummary[],
  limit = 12,
): readonly ChangedFileRef[] {
  const seen = new Set<string>();
  const files: ChangedFileRef[] = [];
  for (let index = turns.length - 1; index >= 0 && files.length < limit; index--) {
    const turn = turns[index];
    if (!turn) continue;
    for (const file of turn.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push({ turn, path: file.path });
    }
  }
  return files;
}
