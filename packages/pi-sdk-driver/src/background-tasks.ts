import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

/** Point-in-time view of one background shell task. */
export interface BackgroundTaskSnapshot {
  readonly taskId: string;
  readonly command: string;
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly startedAt: string;
  readonly status: BackgroundTaskStatus;
  /** Process exit code once the task finished. Signal kills report 128 + signo convention. */
  readonly exitCode?: number;
  readonly endAt?: string;
  readonly outputBytes: number;
  readonly truncated: boolean;
}

/** Slice of a task's combined stdout/stderr log. */
export interface BackgroundTaskOutput {
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
  readonly exitCode?: number;
  readonly output: string;
  /** Byte offset of `output` within the full log. */
  readonly outputOffset: number;
  readonly outputBytes: number;
  readonly truncated: boolean;
  readonly endAt?: string;
}

interface LiveTask {
  readonly taskId: string;
  readonly command: string;
  readonly cwd: string;
  readonly workspaceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly startedAt: string;
  readonly logPath: string;
  readonly child: ChildProcess;
  status: BackgroundTaskStatus;
  exitCode?: number | undefined;
  endAt?: string | undefined;
  outputBytes: number;
  settled: boolean;
  killTimer?: ReturnType<typeof setTimeout> | undefined;
}

const LOG_DIR_NAME = "pi-gui-background-tasks";
/** In-memory tail per task; the full log spills to a temp file. */
const TAIL_BYTES = 256 * 1024;
/** Default read window when the caller passes no offset. */
const DEFAULT_READ_BYTES = 32 * 1024;
/** Hard cap for a single read so a poll cannot OOM the caller. */
const MAX_READ_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function backgroundTaskDir(): string {
  return join(tmpdir(), LOG_DIR_NAME);
}

/**
 * Owns detached shell processes started by the `bash_background` tool.
 *
 * A task is intentionally decoupled from the agent run that started it: the
 * tool returns as soon as the process spawns, so the session is free to take
 * steered turns while the command runs. Stopping is explicit via `stop()`; an
 * aborted agent run does NOT kill its tasks. `shutdown()` kills everything
 * still running for app quit.
 */
export class BackgroundTaskStore {
  private readonly tasks = new Map<string, LiveTask>();
  private readonly tails = new Map<string, string>();
  private readonly logDir: string;

  constructor(logDir?: string) {
    this.logDir = logDir ?? backgroundTaskDir();
  }

  /** Spawn `command` in `cwd` and return its task id immediately. */
  start(
    command: string,
    options: { readonly cwd: string; readonly workspaceId?: string; readonly sessionId?: string },
  ): string {
    const trimmed = command.trim();
    if (!trimmed) {
      throw new Error("bash_background requires a non-empty command.");
    }
    if (!options.cwd) {
      throw new Error("bash_background requires a working directory.");
    }
    const taskId = `bg_${randomUUID().slice(0, 8)}`;
    const logPath = join(this.logDir, `${taskId}.log`);
    const child = spawn("bash", ["-lc", trimmed], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.pid) {
      throw new Error("Failed to spawn background bash process.");
    }
    const task: LiveTask = {
      taskId,
      command: trimmed,
      cwd: options.cwd,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      startedAt: new Date().toISOString(),
      logPath,
      child,
      status: "running",
      outputBytes: 0,
      settled: false,
    };
    this.tasks.set(taskId, task);
    this.tails.set(taskId, "");
    void mkdir(this.logDir, { recursive: true })
      .then(() => writeFile(logPath, "", "utf8"))
      .catch((error: unknown) => {
        console.warn(`[background-tasks] could not init log for ${taskId}:`, error);
      });
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      task.outputBytes += Buffer.byteLength(text, "utf8");
      const prev = this.tails.get(taskId) ?? "";
      const next = prev + text;
      this.tails.set(
        taskId,
        next.length > TAIL_BYTES ? next.slice(next.length - TAIL_BYTES) : next,
      );
      void appendFile(logPath, text, "utf8").catch((error: unknown) => {
        console.warn(`[background-tasks] could not append log for ${taskId}:`, error);
      });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error: unknown) => {
      if (task.settled) return;
      task.settled = true;
      task.status = "failed";
      task.endAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const prev = this.tails.get(taskId) ?? "";
      this.tails.set(taskId, `${prev}\n[background task failed to spawn: ${message}]\n`);
      void appendFile(logPath, `\n[background task failed to spawn: ${message}]\n`, "utf8").catch(
        () => undefined,
      );
    });
    child.on("close", (code: number | null, signal: string | null) => {
      if (task.settled) return;
      task.settled = true;
      const wasRunning = task.status === "running";
      if (wasRunning) {
        task.status = code === 0 ? "completed" : "failed";
      }
      task.exitCode = code ?? 128;
      task.endAt = new Date().toISOString();
      if (signal && wasRunning && task.status === "running") {
        task.status = "failed";
      }
      if (task.killTimer) {
        clearTimeout(task.killTimer);
        task.killTimer = undefined;
      }
    });
    return taskId;
  }

  get(taskId: string): BackgroundTaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return this.snapshot(task);
  }

  list(filter?: {
    readonly workspaceId?: string;
    readonly sessionId?: string;
    readonly includeFinished?: boolean;
  }): BackgroundTaskSnapshot[] {
    const includeFinished = filter?.includeFinished ?? true;
    return [...this.tasks.values()]
      .filter((task) => (filter?.workspaceId ? task.workspaceId === filter.workspaceId : true))
      .filter((task) => (filter?.sessionId ? task.sessionId === filter.sessionId : true))
      .filter((task) => (includeFinished ? true : task.status === "running"))
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
      .map((task) => this.snapshot(task));
  }

  async read(
    taskId: string,
    options?: { readonly offset?: number; readonly limit?: number },
  ): Promise<BackgroundTaskOutput> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown background task: ${taskId}.`);
    }
    const limit = Math.min(Math.max(options?.limit ?? DEFAULT_READ_BYTES, 1), MAX_READ_BYTES);
    try {
      const data = await readFile(task.logPath, "utf8");
      const totalBytes = Buffer.byteLength(data, "utf8");
      if (options?.offset !== undefined) {
        const slice = data.slice(options.offset, options.offset + limit);
        return {
          taskId,
          status: task.status,
          ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
          output: slice,
          outputOffset: options.offset,
          outputBytes: totalBytes,
          truncated: options.offset + limit < data.length,
          ...(task.endAt ? { endAt: task.endAt } : {}),
        };
      }
      const output = data.length > limit ? data.slice(data.length - limit) : data;
      return {
        taskId,
        status: task.status,
        ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
        output,
        outputOffset: Math.max(0, data.length - output.length),
        outputBytes: totalBytes,
        truncated: data.length > limit,
        ...(task.endAt ? { endAt: task.endAt } : {}),
      };
    } catch {
      // Log file missing (e.g. never flushed): fall back to the in-memory tail.
      const tail = this.tails.get(taskId) ?? "";
      const output = tail.length > limit ? tail.slice(tail.length - limit) : tail;
      return {
        taskId,
        status: task.status,
        ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
        output,
        outputOffset: Math.max(0, tail.length - output.length),
        outputBytes: task.outputBytes,
        truncated: tail.length > limit,
        ...(task.endAt ? { endAt: task.endAt } : {}),
      };
    }
  }

  /** Stop a running task. Already-finished tasks report their status unchanged. */
  stop(taskId: string): BackgroundTaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown background task: ${taskId}.`);
    }
    if (task.status !== "running") {
      return this.snapshot(task);
    }
    task.status = "stopped";
    task.endAt = new Date().toISOString();
    this.killTree(task);
    return this.snapshot(task);
  }

  /** Best-effort kill of every running task (app shutdown). */
  shutdown(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "stopped";
      task.endAt = new Date().toISOString();
      this.killTree(task);
    }
  }

  private snapshot(task: LiveTask): BackgroundTaskSnapshot {
    return {
      taskId: task.taskId,
      command: task.command,
      cwd: task.cwd,
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      startedAt: task.startedAt,
      status: task.status,
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.endAt ? { endAt: task.endAt } : {}),
      outputBytes: task.outputBytes,
      truncated: task.outputBytes > TAIL_BYTES,
    };
  }

  private killTree(task: LiveTask): void {
    const pid = task.child.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        task.child.kill("SIGTERM");
      } else {
        // Detached group leader: negative pid kills the whole tree.
        process.kill(-pid, "SIGTERM");
      }
    } catch {
      try {
        task.child.kill("SIGTERM");
      } catch {
        // Already exited; the close handler finalizes state.
      }
    }
    task.killTimer = setTimeout(() => {
      try {
        if (process.platform === "win32") {
          task.child.kill("SIGKILL");
        } else if (pid) {
          process.kill(-pid, "SIGKILL");
        }
      } catch {
        try {
          task.child.kill("SIGKILL");
        } catch {
          // Nothing left to kill.
        }
      }
    }, 3000);
    if (task.killTimer.unref) {
      task.killTimer.unref();
    }
  }
}

export function isBackgroundTaskOutput(value: unknown): value is BackgroundTaskOutput {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.status === "string" &&
    typeof value.output === "string"
  );
}

export async function backgroundTaskLogSize(taskId: string, logDir?: string): Promise<number> {
  try {
    const info = await stat(join(logDir ?? backgroundTaskDir(), `${taskId}.log`));
    return info.size;
  } catch {
    return 0;
  }
}
