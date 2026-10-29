import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionCatalogEntry } from "@pi-gui/catalogs";
import type {
  CreateSessionOptions,
  ForkSessionOptions,
  ForkSessionResult,
  HostUiResponse,
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  RescueCurrentRunOptions,
  RescueCurrentRunResult,
  RuntimeCommandRecord,
  SendCustomMessageOptions,
  SessionAttachment,
  SessionConfig,
  SessionCustomMessageInput,
  SessionDriver,
  SessionDriverEvent,
  SessionEventListener,
  SessionMessageInput,
  SessionModelSelection,
  SessionQueuedMessage,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  SessionTranscriptItem,
  SessionTreeSnapshot,
  Timestamp,
  Unsubscribe,
  WorkspaceRef,
} from "@pi-gui/session-driver";
import { resolveMuseBinaryPath } from "./binary.js";
import { MspTurnCollector, collectExportTurns, toSessionUsageSnapshot } from "./msp-mapping.js";
import type { ExportTurn, MappedToolEvent, MappedUsage } from "./msp-mapping.js";
import { parseMspLine } from "./msp.js";

/**
 * SessionDriver for child sessions backed by the official Muse Code CLI.
 *
 * Each session keeps one fixed Muse session id (`--session-id <uuid>`, minted
 * at `createSession` and reused as the pi session id so restarts can find it).
 * Every turn spawns one `muse exec --json` process in its own process group;
 * follow-ups reuse the session id, so context and the warm cache carry over.
 * It only shells out to the official binary and never talks to Meta's API.
 */

export interface MuseCliDriverOptions {
  /** Explicit `muse` binary path. Defaults to `muse` on PATH, then `~/.local/bin/muse`. */
  readonly binaryPath?: string;
  /**
   * Passed as `--provider`. Omit for the binary default (meta). Tests use
   * `"echo"`, which is deterministic and offline.
   */
  readonly provider?: string;
  /** Shared catalog; sessions are upserted so the desktop lists them. */
  readonly catalogStorage?: {
    readonly sessions: {
      upsertSession(entry: SessionCatalogEntry): Promise<void>;
      getSession(sessionRef: SessionRef): Promise<SessionCatalogEntry | undefined>;
    };
    readonly workspaces: {
      getWorkspace(workspaceId: string): Promise<{ path: string } | undefined>;
    };
  };
  /**
   * Directory for `<sessionId>.json` marker files. A workspace sync only
   * preserves catalog sessions whose session file still exists, so without
   * these the pi driver's reconcile would drop Muse sessions.
   */
  readonly sessionFileDir?: string;
  /** SIGTERM-to-SIGKILL grace for cancel/rescue. Defaults to 3000 ms. */
  readonly killGraceMs?: number;
  /** Timeout for `muse export`. Defaults to 60_000 ms. */
  readonly exportTimeoutMs?: number;
  /**
   * Optional per-turn wall clock; the process group is killed past it. Defaults to
   * 0 (disabled), matching pi children: long turns are normal for a sidekick, and a
   * genuinely hung tool is caught by the host's stuck-tool detection and rescue.
   */
  readonly maxTurnMs?: number;
}

interface RunningTurn {
  readonly proc: ChildProcess;
  readonly runId: RunId;
  readonly prompt: string;
  readonly collector: MspTurnCollector;
  /** Set by cancel/rescue: the exit must settle quietly to idle. */
  cancelledByUs: boolean;
  settled: boolean;
  emittedToolCount: number;
  /** Usage already folded into the record, so terminal sync adds only the rest. */
  reportedUsage: MappedUsage;
  /** assistantMessageStarted fired once text actually streams (pi message_start parity). */
  emittedAssistantStart: boolean;
  stdoutRemainder: string;
  stderrTail: string;
  timeout: NodeJS.Timeout | undefined;
}

type RunId = string;

interface MuseSessionRecord {
  readonly ref: SessionRef;
  workspace: WorkspaceRef;
  title: string;
  model: SessionModelSelection | undefined;
  thinkingLevel: string | undefined;
  scout: boolean;
  isolationWorkspacePath: string | undefined;
  status: SessionStatus;
  transcript: SessionTranscriptItem[];
  usage: MappedUsage;
  queuedMessages: SessionQueuedMessage[];
  running: RunningTurn | undefined;
  archived: boolean;
  readonly listeners: Set<SessionEventListener>;
  updatedAt: Timestamp;
}

const UNSUPPORTED = "Muse CLI driver does not support";
const DEFAULT_KILL_GRACE_MS = 3000;
const DEFAULT_EXPORT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TURN_MS = 0;

export class MuseCliDriver implements SessionDriver {
  private readonly binaryPath: string;
  private readonly provider: string | undefined;
  private readonly catalogStorage: MuseCliDriverOptions["catalogStorage"];
  private readonly sessionFileDir: string | undefined;
  private readonly killGraceMs: number;
  private readonly exportTimeoutMs: number;
  private readonly maxTurnMs: number;
  private readonly records = new Map<string, MuseSessionRecord>();

  constructor(options: MuseCliDriverOptions = {}) {
    this.binaryPath = resolveMuseBinaryPath(options.binaryPath);
    this.provider = options.provider;
    this.catalogStorage = options.catalogStorage;
    this.sessionFileDir = options.sessionFileDir;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.exportTimeoutMs = options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
    this.maxTurnMs = options.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
  }

  /** The resolved binary path (explicit, PATH, or ~/.local/bin/muse). */
  get resolvedBinaryPath(): string {
    return this.binaryPath;
  }

  async createSession(
    workspace: WorkspaceRef,
    options?: CreateSessionOptions,
  ): Promise<SessionSnapshot> {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const record: MuseSessionRecord = {
      ref: { workspaceId: workspace.workspaceId, sessionId },
      workspace,
      title: options?.title?.trim() || workspace.displayName || "Muse sidekick",
      model: options?.initialModel,
      thinkingLevel: options?.initialThinkingLevel,
      scout: false,
      isolationWorkspacePath: undefined,
      status: "idle",
      transcript: [],
      usage: emptyUsage(),
      queuedMessages: [],
      running: undefined,
      archived: false,
      listeners: new Set(),
      updatedAt: now,
    };
    this.records.set(keyOf(record.ref), record);
    await this.persistSession(record);
    const snapshot = this.snapshotOf(record);
    this.emit(record, { type: "sessionOpened", sessionRef: record.ref, timestamp: now, snapshot });
    return snapshot;
  }

  async validateForkSession(_sourceRef: SessionRef, _options: ForkSessionOptions): Promise<void> {
    throw new Error(`${UNSUPPORTED} forking; continue the session with a follow-up instead.`);
  }

  async forkSession(
    _sourceRef: SessionRef,
    _options: ForkSessionOptions,
  ): Promise<ForkSessionResult> {
    throw new Error(`${UNSUPPORTED} forking; continue the session with a follow-up instead.`);
  }

  /**
   * Rebuild the transcript after a restart via
   * `muse export --session <id> --out <tmpfile>`. The pi session id and the
   * Muse session id are the same uuid, so the ref alone locates the export.
   */
  async openSession(sessionRef: SessionRef): Promise<SessionSnapshot> {
    let record = this.records.get(keyOf(sessionRef));
    if (!record) {
      record = await this.createShellRecord(sessionRef);
    }
    if (record.transcript.length > 0 || record.running) {
      return this.snapshotOf(record);
    }
    const turns = await this.exportTurns(sessionRef.sessionId);
    if (turns === undefined) {
      // Muse writes nothing until the first turn runs, so a session that was
      // just created (or never prompted before a restart) has no export yet.
      // That is an empty session, not an error: opening must never fail here,
      // or every new child dies before its first prompt.
      return this.snapshotOf(record);
    }
    record.transcript = [];
    let usage = emptyUsage();
    for (const turn of turns) {
      usage = addUsage(usage, turn.usage);
      if (turn.prompt) {
        record.transcript.push({
          kind: "message",
          role: "user",
          text: turn.prompt,
          createdAt: record.updatedAt,
          id: `muse-${turn.runId}-user`,
        });
      }
      for (const tool of turn.tools) {
        record.transcript.push({
          kind: "tool",
          id: `muse-${tool.callId}`,
          callId: tool.callId,
          toolName: tool.toolName,
          status: tool.success ? "success" : "error",
          createdAt: record.updatedAt,
          finishedAt: record.updatedAt,
        });
      }
      if (turn.text) {
        record.transcript.push({
          kind: "message",
          role: "assistant",
          text: turn.text,
          createdAt: record.updatedAt,
          id: `muse-${turn.runId}-assistant`,
        });
      }
    }
    record.usage = usage;
    record.updatedAt = new Date().toISOString();
    await this.persistSession(record);
    return this.snapshotOf(record);
  }

  async archiveSession(sessionRef: SessionRef): Promise<void> {
    const record = this.requireRecord(sessionRef);
    record.archived = true;
    record.updatedAt = new Date().toISOString();
    await this.persistSession(record);
  }

  async unarchiveSession(sessionRef: SessionRef): Promise<void> {
    const record = this.requireRecord(sessionRef);
    record.archived = false;
    record.updatedAt = new Date().toISOString();
    await this.persistSession(record);
  }

  async sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput): Promise<void> {
    const record = this.requireRecord(sessionRef);
    const text = input.text;
    if (!text.trim()) {
      throw new Error("Cannot send an empty message to a Muse session.");
    }
    const images = await imagesOf(input.attachments);
    if (record.running) {
      if (input.deliverAs === "steer") {
        await this.killRun(record, this.killGraceMs);
      } else {
        record.queuedMessages = [
          ...record.queuedMessages,
          {
            id: randomUUID(),
            mode: "followUp",
            text,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
        return;
      }
    }
    await this.startTurn(record, text, images);
  }

  async sendCustomMessage(
    sessionRef: SessionRef,
    input: SessionCustomMessageInput,
    options?: SendCustomMessageOptions,
  ): Promise<void> {
    const record = this.requireRecord(sessionRef);
    const now = new Date().toISOString();
    record.transcript = [
      ...record.transcript,
      {
        kind: "custom",
        id: `muse-custom-${randomUUID()}`,
        createdAt: now,
        customType: input.customType,
        text: input.text,
      },
    ];
    if (record.running) {
      if (options?.deliverAs === "steer") {
        await this.killRun(record, this.killGraceMs);
      } else {
        record.queuedMessages = [
          ...record.queuedMessages,
          {
            id: randomUUID(),
            mode: "followUp",
            text: input.text,
            createdAt: now,
            updatedAt: now,
          },
        ];
        return;
      }
    } else if (options?.triggerTurn !== true) {
      // A note without triggerTurn is recorded but starts no turn.
      return;
    }
    await this.startTurn(record, input.text, []);
  }

  async replaceQueuedMessages(
    sessionRef: SessionRef,
    messages: readonly SessionQueuedMessage[],
  ): Promise<void> {
    const record = this.requireRecord(sessionRef);
    record.queuedMessages = [...messages];
  }

  async cancelCurrentRun(sessionRef: SessionRef): Promise<void> {
    const record = this.requireRecord(sessionRef);
    if (!record.running) {
      return;
    }
    await this.killRun(record, this.killGraceMs);
  }

  async rescueCurrentRun(
    sessionRef: SessionRef,
    options?: RescueCurrentRunOptions,
  ): Promise<RescueCurrentRunResult> {
    const record = this.requireRecord(sessionRef);
    const grace = options?.abortTimeoutMs ?? this.killGraceMs;
    if (!Number.isFinite(grace) || grace <= 0) {
      throw new Error("rescueCurrentRun abortTimeoutMs must be positive.");
    }
    if (!record.running) {
      return { forced: false };
    }
    const forced = await this.killRun(record, grace);
    return { forced };
  }

  /** Model and thinking level apply to the next turn's flags. */
  async setSessionModel(sessionRef: SessionRef, selection: SessionModelSelection): Promise<void> {
    const record = this.requireRecord(sessionRef);
    record.model = selection;
    record.updatedAt = new Date().toISOString();
  }

  async setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string): Promise<void> {
    const record = this.requireRecord(sessionRef);
    record.thinkingLevel = thinkingLevel;
    record.updatedAt = new Date().toISOString();
  }

  async setSessionOrchestratorMode(_sessionRef: SessionRef, _enabled: boolean): Promise<void> {
    // No pi runtime underneath; orchestration state lives in the desktop.
  }

  async setSessionSidekickModel(
    _sessionRef: SessionRef,
    _selection: SessionModelSelection | undefined,
  ): Promise<void> {
    // Sidekick routing lives in the desktop; nothing to configure on the CLI.
  }

  async renameSession(sessionRef: SessionRef, title: string): Promise<void> {
    const record = this.requireRecord(sessionRef);
    record.title = title.trim() || record.title;
    record.updatedAt = new Date().toISOString();
    await this.persistSession(record);
  }

  async compactSession(_sessionRef: SessionRef, _customInstructions?: string): Promise<void> {
    throw new Error(`${UNSUPPORTED} compaction; start a fresh session instead.`);
  }

  async reloadSession(sessionRef: SessionRef): Promise<void> {
    const record = this.requireRecord(sessionRef);
    if (record.running) {
      return;
    }
    record.transcript = [];
    record.usage = emptyUsage();
    record.updatedAt = new Date().toISOString();
    await this.openSession(sessionRef);
    this.emit(record, {
      type: "sessionUpdated",
      sessionRef: record.ref,
      timestamp: record.updatedAt,
      snapshot: this.snapshotOf(record),
    });
  }

  /** Rebuilds now, or reports deferred while a turn is running. */
  async reloadSessionWhenIdle(sessionRef: SessionRef): Promise<"reloaded" | "deferred"> {
    const record = this.requireRecord(sessionRef);
    if (record.running) {
      return "deferred";
    }
    await this.reloadSession(sessionRef);
    return "reloaded";
  }

  async getSessionTree(_sessionRef: SessionRef): Promise<SessionTreeSnapshot> {
    throw new Error(`${UNSUPPORTED} tree navigation; the transcript is linear.`);
  }

  async navigateSessionTree(
    _sessionRef: SessionRef,
    _targetId: string,
    _options?: NavigateSessionTreeOptions,
  ): Promise<NavigateSessionTreeResult> {
    throw new Error(`${UNSUPPORTED} tree navigation; the transcript is linear.`);
  }

  async getSessionCommands(_sessionRef: SessionRef): Promise<readonly RuntimeCommandRecord[]> {
    return [];
  }

  async respondToHostUiRequest(_sessionRef: SessionRef, _response: HostUiResponse): Promise<void> {
    throw new Error(`${UNSUPPORTED} host UI requests; children run with --approval-mode never.`);
  }

  subscribe(sessionRef: SessionRef, listener: SessionEventListener): Unsubscribe {
    const record = this.records.get(keyOf(sessionRef)) ?? this.createShellRecordSync(sessionRef);
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  async closeSession(sessionRef: SessionRef): Promise<void> {
    const record = this.records.get(keyOf(sessionRef));
    if (!record) {
      return;
    }
    if (record.running) {
      await this.killRun(record, this.killGraceMs).catch(() => undefined);
    }
    record.listeners.clear();
  }

  /** Transcript synthesized from prompts, tool rows and replies (plus export rebuilds). */
  async getTranscript(sessionRef: SessionRef): Promise<SessionTranscriptItem[]> {
    const cached = this.records.get(keyOf(sessionRef));
    if (cached && (cached.transcript.length > 0 || cached.running)) {
      return [...cached.transcript];
    }
    await this.openSession(sessionRef);
    return [...this.requireRecord(sessionRef).transcript];
  }

  /** Marker file path written by persistSession; undefined when unconfigured. */
  getSessionFilePathSync(sessionRef: SessionRef): string | undefined {
    if (!this.sessionFileDir) {
      return undefined;
    }
    return join(this.sessionFileDir, `${sessionRef.sessionId}.json`);
  }

  async getSessionFilePath(sessionRef: SessionRef): Promise<string | undefined> {
    return this.getSessionFilePathSync(sessionRef);
  }

  /**
   * Child isolation from the desktop: scout mode turns into `--disable-write`;
   * the workspace path is a fallback cwd. Otherwise a no-op (no pi runtime).
   */
  setChildIsolation(
    sessionRef: SessionRef,
    info: {
      readonly mode: "scout" | "worker";
      readonly workspacePath: string;
      readonly depth: number;
    },
  ): void {
    const record = this.records.get(keyOf(sessionRef)) ?? this.createShellRecordSync(sessionRef);
    record.scout = info.mode === "scout";
    record.isolationWorkspacePath = info.workspacePath;
    void info.depth;
  }

  // ── turns ──────────────────────────────────────────────────────────

  private async startTurn(
    record: MuseSessionRecord,
    text: string,
    images: readonly string[],
  ): Promise<void> {
    const cwd = record.workspace.path || record.isolationWorkspacePath || "";
    if (!cwd) {
      throw new Error(
        `Cannot start a Muse turn: session ${record.ref.sessionId} has no workspace path.`,
      );
    }
    const runId = randomUUID();
    const now = new Date().toISOString();
    record.transcript = [
      ...record.transcript,
      { kind: "message", role: "user", text, createdAt: now, id: `muse-${runId}-user` },
    ];
    record.status = "running";
    record.updatedAt = now;

    const promptFile = join(tmpdir(), `muse-cli-driver-${runId}.prompt`);
    await fs.writeFile(promptFile, text, "utf8");
    const args = this.execArgs(record, promptFile, images);
    let proc: ChildProcess;
    try {
      proc = spawn(this.binaryPath, args, {
        detached: true,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      throw new Error(
        `Failed to spawn ${this.binaryPath}: ${errorMessage(error)} Install Muse Code or configure the binary path.`,
      );
    }
    const collector = new MspTurnCollector();
    const turn: RunningTurn = {
      proc,
      runId,
      prompt: text,
      collector,
      cancelledByUs: false,
      settled: false,
      emittedToolCount: 0,
      reportedUsage: emptyUsage(),
      emittedAssistantStart: false,
      stdoutRemainder: "",
      stderrTail: "",
      timeout: undefined,
    };
    record.running = turn;
    if (this.maxTurnMs > 0) {
      turn.timeout = setTimeout(() => {
        this.failTurn(record, turn, `Muse turn timed out after ${this.maxTurnMs} ms.`).catch(
          () => undefined,
        );
      }, this.maxTurnMs);
      turn.timeout.unref?.();
    }
    // Pi parity: agent_start announces the run as running before the first
    // model output. The desktop derives the child status from this snapshot,
    // so it must lead every response row (tool or text).
    this.emit(record, {
      type: "sessionUpdated",
      sessionRef: record.ref,
      timestamp: now,
      snapshot: this.snapshotOf(record),
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      this.ingestOutput(record, turn, chunk.toString("utf8"));
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      turn.stderrTail = `${turn.stderrTail}${chunk.toString("utf8")}`.slice(-4096);
    });
    proc.on("error", (error: Error) => {
      this.failTurn(
        record,
        turn,
        `Failed to spawn ${this.binaryPath}: ${error.message} Install Muse Code or configure the binary path.`,
      ).catch(() => undefined);
    });
    // `close`, not `exit`: deltas, usage and the terminal record cluster at
    // the end of the stream, and `exit` can fire before the final pipe bytes
    // are ingested. Settling on `close` guarantees the terminal record was
    // seen, so a finished run cannot degrade into a phantom failure.
    proc.on("close", (code: number | null, signal: string | null) => {
      this.finishTurn(record, turn, promptFile, code, signal).catch(() => undefined);
    });
  }

  private execArgs(
    record: MuseSessionRecord,
    promptFile: string,
    images: readonly string[],
  ): string[] {
    const workspacePath = record.workspace.path || record.isolationWorkspacePath || "";
    const args = [
      "exec",
      "--json",
      "--session-id",
      record.ref.sessionId,
      "--prompt-file",
      promptFile,
      "--approval-mode",
      "never",
      "--trust-workspace",
      "--workspace",
      workspacePath,
    ];
    if (this.provider) {
      args.push("--provider", this.provider);
    }
    const modelId = record.model?.modelId?.trim();
    if (modelId) {
      args.push("--model", modelId);
    }
    const effort = reasoningEffortOf(record.thinkingLevel);
    if (effort) {
      args.push("--reasoning-effort", effort);
    }
    if (record.scout) {
      args.push("--disable-write");
    }
    const worktreePath = worktreeExistingPathOf(workspacePath);
    if (worktreePath) {
      args.push("-w", "existing", "--worktree-existing", worktreePath);
    }
    for (const image of images) {
      args.push("--image", image);
    }
    return args;
  }

  private ingestOutput(record: MuseSessionRecord, turn: RunningTurn, chunk: string): void {
    if (turn.settled) {
      return;
    }
    turn.stdoutRemainder += chunk;
    const lines = turn.stdoutRemainder.split("\n");
    turn.stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseMspLine(line);
      if (!parsed) {
        continue;
      }
      turn.collector.ingest(parsed);
      this.emitRecord(record, turn, parsed.payload.kind);
      const fresh = turn.collector.pendingToolEvents.slice(turn.emittedToolCount);
      turn.emittedToolCount = turn.collector.pendingToolEvents.length;
      for (const tool of fresh) {
        this.emitToolEvent(record, turn, tool);
      }
    }
  }

  private emitRecord(record: MuseSessionRecord, turn: RunningTurn, payloadKind: string): void {
    const now = new Date().toISOString();
    if (payloadKind === "run_started") {
      // Run acceptance carries no model output; the assistant bubble opens
      // with the first streamed text (pi message_start parity), so a slow
      // start never fakes a response.
      return;
    }
    if (payloadKind === "run_output_delta") {
      const text = turn.collector.drainDelta();
      if (!text) {
        return;
      }
      if (!turn.emittedAssistantStart) {
        turn.emittedAssistantStart = true;
        this.emit(record, {
          type: "assistantMessageStarted",
          sessionRef: record.ref,
          timestamp: now,
          runId: turn.runId,
        });
      }
      this.emit(record, {
        type: "assistantDelta",
        sessionRef: record.ref,
        timestamp: now,
        runId: turn.runId,
        text,
      });
      return;
    }
    if (payloadKind === "run_usage") {
      this.syncUsage(record, turn);
      record.updatedAt = now;
      this.emit(record, {
        type: "sessionUpdated",
        sessionRef: record.ref,
        timestamp: now,
        runId: turn.runId,
        snapshot: this.snapshotOf(record),
      });
    }
  }

  private emitToolEvent(record: MuseSessionRecord, turn: RunningTurn, tool: MappedToolEvent): void {
    const now = new Date().toISOString();
    if (tool.type === "toolStarted") {
      this.emit(record, {
        type: "toolStarted",
        sessionRef: record.ref,
        timestamp: now,
        runId: turn.runId,
        toolName: tool.toolName,
        callId: tool.callId,
      });
      return;
    }
    record.transcript = [
      ...record.transcript,
      {
        kind: "tool",
        id: `muse-${tool.callId}`,
        callId: tool.callId,
        toolName: tool.toolName,
        status: tool.success === true ? "success" : "error",
        createdAt: now,
        finishedAt: now,
      },
    ];
    this.emit(record, {
      type: "toolFinished",
      sessionRef: record.ref,
      timestamp: now,
      runId: turn.runId,
      callId: tool.callId,
      success: tool.success === true,
    });
  }

  private async finishTurn(
    record: MuseSessionRecord,
    turn: RunningTurn,
    promptFile: string,
    code: number | null,
    signal: string | null,
  ): Promise<void> {
    await fs.rm(promptFile, { force: true }).catch(() => undefined);
    if (turn.settled || record.running !== turn) {
      return;
    }
    // Flush any final buffered line.
    if (turn.stdoutRemainder.trim()) {
      this.ingestOutput(record, turn, "\n");
    }
    turn.settled = true;
    if (turn.timeout) {
      clearTimeout(turn.timeout);
    }
    record.running = undefined;
    const now = new Date().toISOString();
    const terminal = turn.collector.mappedTerminal;

    if (turn.cancelledByUs || terminal?.status === "cancelled") {
      // User-requested aborts settle quietly to idle like pi's: a bare
      // session update, no completion or failure notification.
      record.status = "idle";
      record.updatedAt = now;
      this.emitAssistantEnd(record, turn, now);
      this.closeInterruptedTools(record, turn);
      this.emit(record, {
        type: "sessionUpdated",
        sessionRef: record.ref,
        timestamp: now,
        snapshot: this.snapshotOf(record),
      });
      await this.persistSession(record);
      await this.drainQueue(record);
      return;
    }

    if (terminal) {
      this.syncUsage(record, turn);
      const text = terminal.text || turn.collector.assistantText;
      if (text && !turn.emittedAssistantStart) {
        // A turn whose text arrived only in the terminal record (no streamed
        // deltas) still opens a bubble, so the desktop transcript and the
        // child report carry the final text.
        turn.emittedAssistantStart = true;
        this.emit(record, {
          type: "assistantMessageStarted",
          sessionRef: record.ref,
          timestamp: now,
          runId: turn.runId,
        });
        this.emit(record, {
          type: "assistantDelta",
          sessionRef: record.ref,
          timestamp: now,
          runId: turn.runId,
          text,
        });
      }
      record.transcript = [
        ...record.transcript,
        {
          kind: "message",
          role: "assistant",
          text,
          createdAt: now,
          id: `muse-${turn.runId}-assistant`,
        },
      ];
      record.updatedAt = now;
      this.emitAssistantEnd(record, turn, now);
      if (terminal.status === "completed") {
        record.status = "idle";
        const snapshot = this.snapshotOf(record);
        this.emit(record, {
          type: "runCompleted",
          sessionRef: record.ref,
          timestamp: now,
          runId: turn.runId,
          snapshot,
        });
        await this.persistSession(record);
        await this.drainQueue(record);
        return;
      }
      record.status = "failed";
      const reason = terminal.reason || text || "Muse run failed.";
      this.emit(record, {
        type: "runFailed",
        sessionRef: record.ref,
        timestamp: now,
        runId: turn.runId,
        error: { message: reason },
      });
      await this.persistSession(record);
      return;
    }

    // The process is gone with no terminal record: a real failure, unless we
    // already settled the turn through cancel/rescue/timeout.
    this.syncUsage(record, turn);
    record.status = "failed";
    record.updatedAt = now;
    this.emitAssistantEnd(record, turn, now);
    this.closeInterruptedTools(record, turn);
    const detail =
      turn.stderrTail.trim() || (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
    this.emit(record, {
      type: "runFailed",
      sessionRef: record.ref,
      timestamp: now,
      runId: turn.runId,
      error: { message: `Muse turn exited without a terminal record (${detail}).` },
    });
    await this.persistSession(record);
  }

  private async failTurn(
    record: MuseSessionRecord,
    turn: RunningTurn,
    message: string,
  ): Promise<void> {
    if (turn.settled || record.running !== turn) {
      return;
    }
    turn.settled = true;
    if (turn.timeout) {
      clearTimeout(turn.timeout);
    }
    killProcessGroup(turn.proc);
    await waitForExit(turn.proc, 2000);
    killProcessGroup(turn.proc, "SIGKILL");
    record.running = undefined;
    record.status = "failed";
    const now = new Date().toISOString();
    record.updatedAt = now;
    this.emitAssistantEnd(record, turn, now);
    this.closeInterruptedTools(record, turn);
    this.emit(record, {
      type: "runFailed",
      sessionRef: record.ref,
      timestamp: now,
      runId: turn.runId,
      error: { message },
    });
    await this.persistSession(record);
  }

  /**
   * Emit an interrupted finish for every started-but-unfinished tool so the
   * UI stops showing it as running. The collector dedupes against calls that
   * already reached a terminal record.
   */
  private closeInterruptedTools(record: MuseSessionRecord, turn: RunningTurn): void {
    for (const tool of turn.collector.drainOpenTools()) {
      this.emitToolEvent(record, turn, tool);
    }
  }

  /**
   * Fold the turn's usage delta into the session totals. The collector
   * accumulates monotonically, so only the not-yet-reported part is added;
   * counters never go backwards.
   */
  private syncUsage(record: MuseSessionRecord, turn: RunningTurn): void {
    const current = turn.collector.mappedUsage;
    const reported = turn.reportedUsage;
    const delta: MappedUsage = {
      model: current.model,
      inputTokens: Math.max(0, current.inputTokens - reported.inputTokens),
      cachedTokens: Math.max(0, current.cachedTokens - reported.cachedTokens),
      outputTokens: Math.max(0, current.outputTokens - reported.outputTokens),
      reasoningTokens: Math.max(0, current.reasoningTokens - reported.reasoningTokens),
      calls: Math.max(0, current.calls - reported.calls),
      allowance: current.allowance ?? reported.allowance,
    };
    turn.reportedUsage = { ...current, allowance: delta.allowance };
    record.usage = addUsage(record.usage, delta);
  }

  private emitAssistantEnd(record: MuseSessionRecord, turn: RunningTurn, timestamp: string): void {
    this.emit(record, {
      type: "assistantMessageEnded",
      sessionRef: record.ref,
      timestamp,
      runId: turn.runId,
    });
  }

  private async drainQueue(record: MuseSessionRecord): Promise<void> {
    if (record.running || record.status !== "idle") {
      return;
    }
    const next = record.queuedMessages[0];
    if (!next) {
      return;
    }
    record.queuedMessages = record.queuedMessages.slice(1);
    const now = new Date().toISOString();
    this.emit(record, {
      type: "queuedMessageStarted",
      sessionRef: record.ref,
      timestamp: now,
      message: next,
    });
    await this.startTurn(record, next.text, []);
  }

  /**
   * SIGTERM the process group, then SIGKILL after `graceMs`. Returns true when
   * the SIGKILL path was needed (rescue reports it as forced).
   */
  private async killRun(record: MuseSessionRecord, graceMs: number): Promise<boolean> {
    const turn = record.running;
    if (!turn || turn.settled) {
      return false;
    }
    turn.cancelledByUs = true;
    if (turn.timeout) {
      clearTimeout(turn.timeout);
      turn.timeout = undefined;
    }
    killProcessGroup(turn.proc, "SIGTERM");
    const exited = await waitForExit(turn.proc, graceMs);
    if (!exited && !turn.settled) {
      killProcessGroup(turn.proc, "SIGKILL");
      await waitForExit(turn.proc, 2000);
      // finishTurn settles from the exit event; if the platform never
      // delivers it, settle here so the session cannot wedge busy.
      if (!turn.settled && record.running === turn) {
        turn.settled = true;
        record.running = undefined;
        record.status = "idle";
        const now = new Date().toISOString();
        record.updatedAt = now;
        this.emitAssistantEnd(record, turn, now);
        this.closeInterruptedTools(record, turn);
        this.emit(record, {
          type: "sessionUpdated",
          sessionRef: record.ref,
          timestamp: now,
          snapshot: this.snapshotOf(record),
        });
        await this.persistSession(record);
        await this.drainQueue(record);
      }
      return true;
    }
    return false;
  }

  // ── export / persistence ───────────────────────────────────────────

  private async exportTurns(museSessionId: string): Promise<ExportTurn[] | undefined> {
    const outFile = join(tmpdir(), `muse-cli-driver-export-${randomUUID()}.json`);
    try {
      await runBounded(
        this.binaryPath,
        ["export", "--session", museSessionId, "--out", outFile],
        this.exportTimeoutMs,
      );
      const raw = await fs.readFile(outFile, "utf8");
      const document = JSON.parse(raw) as {
        readonly events?: readonly { readonly envelope?: unknown }[];
      };
      return collectExportTurns(document);
    } catch {
      return undefined;
    } finally {
      await fs.rm(outFile, { force: true }).catch(() => undefined);
    }
  }

  private async createShellRecord(sessionRef: SessionRef): Promise<MuseSessionRecord> {
    const record = this.createShellRecordSync(sessionRef);
    const stored = await this.catalogStorage?.sessions
      .getSession(sessionRef)
      .catch(() => undefined);
    const workspacePath =
      (
        await this.catalogStorage?.workspaces
          .getWorkspace(sessionRef.workspaceId)
          .catch(() => undefined)
      )?.path ?? "";
    if (stored) {
      record.title = stored.title || record.title;
      record.archived = stored.archivedAt !== undefined;
    }
    if (workspacePath) {
      record.workspace = { workspaceId: sessionRef.workspaceId, path: workspacePath };
    }
    return record;
  }

  private createShellRecordSync(sessionRef: SessionRef): MuseSessionRecord {
    const existing = this.records.get(keyOf(sessionRef));
    if (existing) {
      return existing;
    }
    const record: MuseSessionRecord = {
      ref: { ...sessionRef },
      workspace: { workspaceId: sessionRef.workspaceId, path: "" },
      title: "",
      model: undefined,
      thinkingLevel: undefined,
      scout: false,
      isolationWorkspacePath: undefined,
      status: "idle",
      transcript: [],
      usage: emptyUsage(),
      queuedMessages: [],
      running: undefined,
      archived: false,
      listeners: new Set(),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(keyOf(sessionRef), record);
    return record;
  }

  private requireRecord(sessionRef: SessionRef): MuseSessionRecord {
    const record = this.records.get(keyOf(sessionRef));
    if (!record) {
      throw new Error(`Unknown Muse session ${sessionRef.sessionId}; create or open it first.`);
    }
    return record;
  }

  private snapshotOf(record: MuseSessionRecord): SessionSnapshot {
    const config: SessionConfig | undefined = record.model
      ? {
          provider: record.model.provider,
          modelId: record.model.modelId,
          ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
        }
      : undefined;
    return {
      ref: { ...record.ref },
      workspace: { ...record.workspace },
      title: record.title,
      status: record.status,
      updatedAt: record.updatedAt,
      ...(record.archived ? { archivedAt: record.updatedAt } : {}),
      preview: previewOf(record),
      ...(config ? { config } : {}),
      ...(record.running ? { runningRunId: record.running.runId } : {}),
      ...(record.queuedMessages.length > 0 ? { queuedMessages: [...record.queuedMessages] } : {}),
      usage: toSessionUsageSnapshot(record.usage),
    };
  }

  private async persistSession(record: MuseSessionRecord): Promise<void> {
    const filePath = this.getSessionFilePathSync(record.ref);
    if (filePath && this.sessionFileDir) {
      const payload = JSON.stringify({
        version: 1,
        museSessionId: record.ref.sessionId,
        title: record.title,
        updatedAt: record.updatedAt,
      });
      try {
        await fs.mkdir(this.sessionFileDir, { recursive: true });
        await fs.writeFile(filePath, payload, "utf8");
      } catch {
        // Marker files are a best-effort shield against catalog reconcile;
        // a failure here must not fail the turn.
      }
    }
    if (this.catalogStorage) {
      const preview = previewOf(record);
      const entry: SessionCatalogEntry = {
        sessionRef: { ...record.ref },
        workspaceId: record.ref.workspaceId,
        title: record.title,
        updatedAt: record.updatedAt,
        ...(record.archived ? { archivedAt: record.updatedAt } : {}),
        ...(preview ? { previewSnippet: preview } : {}),
        ...(filePath ? { sessionFilePath: filePath } : {}),
        status: record.status,
      };
      await this.catalogStorage.sessions.upsertSession(entry).catch(() => undefined);
    }
  }

  private emit(record: MuseSessionRecord, event: SessionDriverEvent): void {
    for (const listener of [...record.listeners]) {
      try {
        const result = listener(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // One bad listener must not break delivery to the rest.
      }
    }
  }
}

/** Pi thinking levels map onto Muse `--reasoning-effort`; unknown levels are omitted. */
export function reasoningEffortOf(thinkingLevel: string | undefined): string | undefined {
  if (!thinkingLevel) {
    return undefined;
  }
  const normalized = thinkingLevel.trim().toLowerCase();
  if (normalized === "off" || normalized === "none") {
    return "none";
  }
  if (
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max" ||
    normalized === "ultra"
  ) {
    return normalized;
  }
  return undefined;
}

/**
 * Linked git worktrees check out with `.git` as a pointer file. Only those
 * get `-w existing --worktree-existing`; the main checkout scopes via
 * `--workspace` alone.
 */
export function worktreeExistingPathOf(workspacePath: string): string | undefined {
  if (!workspacePath) {
    return undefined;
  }
  try {
    // Sync read at spawn time: one tiny stat, once per turn.
    const dotGit = join(workspacePath, ".git");
    if (!statSync(dotGit, { throwIfNoEntry: false })?.isFile()) {
      return undefined;
    }
    const pointer = readFileSync(dotGit, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/.exec(pointer);
    if (match?.[1]?.includes("worktrees")) {
      return workspacePath;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Image attachments are base64 data, but `muse exec --image` takes a file
 * path, so each image is staged to a temp file. File attachments have no
 * CLI equivalent and are rejected rather than silently dropped.
 */
async function imagesOf(attachments: readonly SessionAttachment[] | undefined): Promise<string[]> {
  const images: string[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== "image") {
      throw new Error("Muse CLI driver cannot send file attachments; attach images only.");
    }
    const extension = extensionOfMimeType(attachment.mimeType);
    const staged = join(tmpdir(), `muse-cli-driver-${randomUUID()}${extension}`);
    await fs.writeFile(staged, Buffer.from(attachment.data, "base64"));
    images.push(staged);
  }
  return images;
}

function extensionOfMimeType(mimeType: string): string {
  const match = /^image\/([a-z0-9]+)/.exec(mimeType.trim().toLowerCase());
  const subtype = match?.[1] ?? "";
  if (subtype === "jpeg") {
    return ".jpg";
  }
  if (subtype === "png" || subtype === "gif" || subtype === "webp") {
    return `.${subtype}`;
  }
  return ".img";
}

function previewOf(record: MuseSessionRecord): string {
  for (let index = record.transcript.length - 1; index >= 0; index -= 1) {
    const item = record.transcript[index];
    if (item?.kind === "message" && item.role === "assistant" && item.text.trim()) {
      return item.text.slice(0, 500);
    }
  }
  for (let index = record.transcript.length - 1; index >= 0; index -= 1) {
    const item = record.transcript[index];
    if (item?.kind === "message" && item.text.trim()) {
      return item.text.slice(0, 500);
    }
  }
  return record.title;
}

function emptyUsage(): MappedUsage {
  return {
    model: null,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    allowance: null,
  };
}

function addUsage(left: MappedUsage, right: MappedUsage): MappedUsage {
  return {
    model: right.model ?? left.model,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    calls: left.calls + right.calls,
    allowance: right.allowance ?? left.allowance,
  };
}

function keyOf(ref: SessionRef): string {
  return `${ref.workspaceId}:${ref.sessionId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = proc.pid;
  if (!pid) {
    try {
      proc.kill(signal);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    // Own process group (detached: true): a negative pid signals the tree.
    process.kill(-pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      proc.off("exit", onExit);
    };
    proc.on("exit", onExit);
  });
}

function runBounded(binary: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(binary, [...args], { stdio: "ignore", env: process.env });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      killProcessGroup(proc, "SIGKILL");
      reject(new Error(`Timed out after ${timeoutMs} ms: ${binary} ${args[0]}`));
    }, timeoutMs);
    timer.unref?.();
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${binary} ${args[0]} exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}
