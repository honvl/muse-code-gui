import type {
  ExtensionFlagValues,
  HostUiRequest,
  SessionConfig,
  SessionModelSelection,
  SessionUsageSnapshot,
} from "@pi-gui/session-driver";
import type {
  ModelSettingsSnapshot,
  RuntimeCommandRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { SessionSchemaInfo } from "@pi-gui/session-driver";
export type { SessionSchemaInfo } from "@pi-gui/session-driver";
export type SessionStatus = "idle" | "running" | "failed";
export type { SessionRole, TimelineToolCall, TranscriptMessage } from "./timeline-types";
import type { TranscriptMessage } from "./timeline-types";
import type { ScheduledTaskRecord } from "./scheduled-tasks";
export type {
  CreateScheduledTaskInput,
  ScheduledTaskFilter,
  ScheduledTaskRecord,
  ScheduledTaskSchedule,
  ScheduledTaskStatus,
  ScheduledTaskTarget,
  UpdateScheduledTaskInput,
} from "./scheduled-tasks";

/** A reasoning effort pi accepts; pi clamps it to what the chosen model supports. */
export type ThinkingLevel = NonNullable<RuntimeSettingsSnapshot["defaultThinkingLevel"]>;

/** Reasoning effort lead-mode threads start with until the user picks another default. */
export const DEFAULT_LEAD_THINKING_LEVEL: ThinkingLevel = "high";
/** Reasoning effort sidekick children start with until the user picks another default. */
export const DEFAULT_SIDEKICK_THINKING_LEVEL: ThinkingLevel = "xhigh";

export type AppView = "threads" | "new-thread" | "scheduled" | "skills" | "extensions" | "settings";
export type WorkspaceKind = "primary" | "worktree";
export type WorktreeStatus = "ready" | "missing" | "error";
export type NewThreadEnvironment = "local" | "worktree";
export type ThemeMode = "system" | "light" | "dark";
export const themePresetIds = [
  "default",
  "catppuccin",
  "tokyo-night",
  "nord",
  "dracula",
  "gruvbox",
  "github",
  "vscode",
] as const;
export type ThemePresetId = (typeof themePresetIds)[number];
export type ModelSettingsScopeMode = "app-global" | "per-repo";
export type ThreadGrouping = "time" | "workspace";

export function isThreadGrouping(value: unknown): value is ThreadGrouping {
  return value === "time" || value === "workspace";
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function isThemePresetId(value: unknown): value is ThemePresetId {
  return typeof value === "string" && themePresetIds.includes(value as ThemePresetId);
}
export type ComposerDraftSyncSource =
  | "state"
  | "selection"
  | "persist"
  | "remote-persist"
  | "command"
  | "extension-editor-text"
  | "queued-message-edit";

export interface NotificationPreferences {
  readonly backgroundCompletion: boolean;
  readonly backgroundFailure: boolean;
  readonly attentionNeeded: boolean;
}

export interface ComposerImageAttachment {
  readonly id: string;
  readonly kind: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

export interface ComposerFileAttachment {
  readonly id: string;
  readonly kind: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly fsPath: string;
  readonly sizeBytes?: number;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;

export type QueuedComposerMessageMode = "steer" | "followUp";

export interface QueuedComposerMessage {
  readonly id: string;
  readonly mode: QueuedComposerMessageMode;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly lastViewedAt?: string;
  readonly lastInteractedAt?: string;
  readonly archivedAt?: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly runningSince?: string;
  readonly hasUnseenUpdate: boolean;
  readonly config?: SessionConfig;
  /** Grey ghost-text follow-up shown in the composer placeholder after a run. Tab accepts it. */
  readonly suggestedNextPrompt?: string;
}

export type OrchestrationChildThreadStatus =
  "queued" | "running" | "waiting" | "complete" | "failed";

export type OrchestrationEvidenceKind =
  | "worker_report"
  | "orchestrator_acceptance"
  | "orchestrator_observation"
  | "orchestrator_action"
  | "command"
  | "review_finding"
  | "blocker";
export type OrchestrationEvidenceSource =
  | "worker-reported"
  | "orchestrator-accepted"
  | "orchestrator-observed"
  | "orchestrator-action"
  | "command"
  | "review"
  | "blocker";
export type OrchestrationEvidenceStatus =
  "reported" | "accepted" | "running" | "passed" | "failed" | "blocked";

export interface OrchestrationEvidenceGitRef {
  readonly workspaceId: string;
  readonly branchName?: string;
  readonly headSha?: string;
}

export interface OrchestrationEvidenceRecord {
  readonly id: string;
  readonly childThreadId: string;
  readonly kind: OrchestrationEvidenceKind;
  readonly source: OrchestrationEvidenceSource;
  readonly status: OrchestrationEvidenceStatus;
  readonly title: string;
  readonly detail?: string;
  readonly command?: string;
  readonly toolName?: string;
  readonly severity?: "P0" | "P1" | "P2" | "P3";
  readonly parentSessionId?: string;
  readonly childSessionId?: string;
  readonly git?: OrchestrationEvidenceGitRef;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface OrchestrationChildTranscriptMessage {
  readonly id: string;
  readonly role: "parent" | "child" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export type OrchestrationChildMode = "scout" | "worker";

/** Which driver runs a child's session. Absent (every pre-v22 record) means pi. */
export type OrchestrationChildRuntime = "pi" | "muse-cli";

export interface OrchestrationChildThread {
  readonly id: string;
  readonly sourceToolCallId?: string;
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly childWorkspaceId: string;
  readonly childSessionId: string;
  readonly title: string;
  readonly goal: string;
  readonly mode?: OrchestrationChildMode;
  readonly depth?: number;
  /**
   * Normalized path prefixes a worker claimed through its brief's `scope`.
   * Missing or empty means the whole workspace. Scopes are advisory for
   * artifacts every checkout shares (build outputs, lockfiles, the Git index).
   */
  readonly writeScopes?: readonly string[];
  /**
   * Set for an `isolation: "worktree"` child: its own repo-local worktree
   * (the child session's cwd), the branch created for it, and the parent's
   * HEAD it started from. Such a child never takes the shared writer slot.
   * All three are present together or not at all.
   */
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly baseCommit?: string;
  /**
   * Driver for this child's session: "muse-cli" routes to the Muse CLI
   * driver, anything else (including absent) to pi-sdk-driver. Persisted so
   * restarts route the same way.
   */
  readonly runtime?: OrchestrationChildRuntime;
  readonly status: OrchestrationChildThreadStatus;
  readonly latestTranscript: string;
  readonly transcript: readonly OrchestrationChildTranscriptMessage[];
  readonly evidence: readonly OrchestrationEvidenceRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SendChildThreadFollowUpInput {
  readonly childThreadId: string;
  readonly text: string;
}

export interface SelectedTranscriptRecord {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly transcript: readonly TranscriptMessage[];
  /**
   * Present when `transcript` carries only the rows from this index on, to be
   * spliced onto what the renderer already holds. Timeline rows are immutable
   * once settled, so a streaming turn re-sends only its own row instead of a
   * multi-megabyte transcript on every publish. Absent means the full list.
   */
  readonly replacedFrom?: number;
  // Session-file schema-version skew, when known. `writtenByNewerRuntime` drives the version-skew
  // notice; undefined until the (async, static-per-session) header read resolves.
  readonly schemaInfo?: SessionSchemaInfo;
}

export interface SubagentTranscriptRequest {
  readonly workspaceId: string;
  /** Expected pi session name, e.g. `agent:explore: Explore auth flow`. */
  readonly sessionName: string;
  /** Isolated worktree dir from the tool result, when present. */
  readonly worktreeDir?: string;
  /** The subagent's pi session uuid, when the tool result reported one. */
  readonly agentId?: string;
}

export type SubagentTranscriptResult =
  | {
      readonly found: true;
      readonly sessionName: string;
      readonly sessionId: string;
      readonly transcript: readonly TranscriptMessage[];
      /** Rows omitted from the head when the transcript exceeded the cap. */
      readonly omittedRows: number;
    }
  | { readonly found: false; readonly sessionName: string };

export interface WorktreeRecord {
  readonly id: string;
  readonly rootWorkspaceId: string;
  readonly linkedWorkspaceId?: string;
  readonly name: string;
  readonly path: string;
  readonly status: WorktreeStatus;
  readonly branchName?: string;
  readonly updatedAt: string;
}

export interface SessionExtensionStatusRecord {
  readonly key: string;
  readonly text: string;
}

export interface SessionExtensionWidgetRecord {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "aboveComposer" | "belowComposer";
}

export type SessionExtensionDialogRecord = Extract<
  HostUiRequest,
  { readonly kind: "confirm" | "select" | "input" | "editor" }
>;

export interface SessionExtensionNoticeRecord {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly createdAt: string;
}

export interface SessionExtensionUiStateRecord {
  readonly instanceId: string;
  readonly statuses: readonly SessionExtensionStatusRecord[];
  readonly widgets: readonly SessionExtensionWidgetRecord[];
  readonly pendingDialogs: readonly SessionExtensionDialogRecord[];
  /** `ctx.ui.notify` toasts, newest last. Main caps and expires them; the renderer only draws them. */
  readonly notices: readonly SessionExtensionNoticeRecord[];
  readonly title?: string;
  readonly editorText?: string;
}

export type ExtensionCommandCompatibilityStatus = "supported" | "terminal-only";

export interface ExtensionCommandCompatibilityRecord {
  readonly commandName: string;
  readonly extensionPath: string;
  readonly status: ExtensionCommandCompatibilityStatus;
  readonly message: string;
  readonly capability: string;
  readonly updatedAt: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
  readonly kind: WorkspaceKind;
  readonly rootWorkspaceId?: string;
  readonly branchName?: string;
  readonly sessions: readonly SessionRecord[];
}

export interface CreateWorktreeInput {
  readonly workspaceId: string;
  readonly fromSessionWorkspaceId?: string;
  readonly fromSessionId?: string;
}

export type StartThreadInput = {
  readonly rootWorkspaceId: string;
  readonly environment: NewThreadEnvironment;
  readonly prompt?: string;
  readonly attachments?: readonly ComposerAttachment[];
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly orchestratorMode?: boolean;
  /**
   * The flag values chosen for this thread, `false` and empty strings included so
   * they are remembered as the workspace's next defaults. Main checks them against
   * the flags the workspace's extensions registered before pi sees them.
   */
  readonly extensionFlags?: ExtensionFlagValues;
};

export type ForkThreadPosition = "before" | "at" | "after";

export type ForkThreadInput = {
  readonly sourceWorkspaceId: string;
  readonly sourceSessionId: string;
  /** Root workspace used as the base when forking into a new worktree. */
  readonly rootWorkspaceId: string;
  /** "local" forks into the source workspace; "worktree" creates a new worktree. */
  readonly environment: NewThreadEnvironment;
  /** ID of the rendered transcript message selected as the fork point, when it maps to a session entry. */
  readonly sourceMessageId?: string;
  /** 0-based index of the rendered transcript message selected as the fork point. */
  readonly sourceMessageIndex?: number;
  /** 0-based rendered user-message index kept as a fallback for older callers. */
  readonly userMessageIndex?: number;
  readonly position?: ForkThreadPosition;
};

export interface RemoveWorktreeInput {
  readonly workspaceId: string;
  readonly worktreeId: string;
}

export interface StartupDiagnostic {
  readonly scope: "application" | "workspace";
  readonly message: string;
  readonly workspacePath?: string;
}

export interface DesktopAppState {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly worktreesByWorkspace: Readonly<Record<string, readonly WorktreeRecord[]>>;
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly composerDraft: string;
  readonly composerDraftSyncSource: ComposerDraftSyncSource;
  readonly composerDraftSyncNonce: number;
  readonly composerAttachments: readonly ComposerAttachment[];
  readonly queuedComposerMessages: readonly QueuedComposerMessage[];
  readonly editingQueuedMessageId?: string;
  readonly runtimeByWorkspace: Readonly<Record<string, RuntimeSnapshot>>;
  readonly sessionCommandsBySession: Readonly<Record<string, readonly RuntimeCommandRecord[]>>;
  /** Context, cache and usage for open sessions; absent until pi reports it. */
  readonly sessionUsageBySession: Readonly<Record<string, SessionUsageSnapshot>>;
  readonly sessionExtensionUiBySession: Readonly<Record<string, SessionExtensionUiStateRecord>>;
  readonly extensionCommandCompatibilityByWorkspace: Readonly<
    Record<string, readonly ExtensionCommandCompatibilityRecord[]>
  >;
  /** Flag values last chosen for a new thread in each root workspace: the next thread's defaults. */
  readonly extensionFlagsByWorkspace: Readonly<Record<string, ExtensionFlagValues>>;
  /** Flag values each thread's pi session started with (only the ones pi receives). */
  readonly extensionFlagsBySession: Readonly<Record<string, ExtensionFlagValues>>;
  readonly orchestrationChildren: readonly OrchestrationChildThread[];
  /**
   * Recent provider+model failures blocking child spawns, by
   * "provider:modelId" to refusal note. In-memory only, never persisted;
   * entries expire after PI_APP_PROVIDER_FAILURE_MEMORY_MS.
   */
  readonly providerFailureNotes?: Readonly<Record<string, string>>;
  readonly scheduledTasks: readonly ScheduledTaskRecord[];
  readonly notificationPreferences: NotificationPreferences;
  /** Whether the Muse Code GUI extension pack is ensured into pi's global setup on startup. */
  readonly extensionPackEnabled: boolean;
  readonly integratedTerminalShell: string;
  readonly lastViewedAtBySession: Readonly<Record<string, string>>;
  readonly lastInteractedAtBySession: Readonly<Record<string, string>>;
  readonly pinnedAtBySession: Readonly<Record<string, string>>;
  readonly pinnedSessionOrder: readonly string[];
  readonly workspaceOrder: readonly string[];
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly globalModelSettings: ModelSettingsSnapshot;
  /** App-global default model for new lead-mode threads; absent means no override. */
  readonly defaultLeadModel?: SessionModelSelection;
  /** App-global default model for read-only scout children; absent falls back to the thread sidekick. */
  readonly defaultScoutModel?: SessionModelSelection;
  /** App-global reasoning effort for lead-mode threads; absent means DEFAULT_LEAD_THINKING_LEVEL. */
  readonly defaultLeadThinkingLevel?: ThinkingLevel;
  /** Per-thread reasoning effort for sidekick children, by session key; absent uses the app default. */
  readonly sidekickThinkingBySession?: Readonly<Record<string, ThinkingLevel>>;
  /** App-global reasoning effort for sidekick children; absent means DEFAULT_SIDEKICK_THINKING_LEVEL. */
  readonly defaultSidekickThinkingLevel?: ThinkingLevel;
  /** App-global reasoning effort for scout children; absent falls back to the thread's sidekick effort. */
  readonly defaultScoutThinkingLevel?: ThinkingLevel;
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  readonly sidebarCollapsed: boolean;
  readonly threadGrouping: ThreadGrouping;
  /** Folder groups the user collapsed in the sidebar, by workspace id. */
  readonly collapsedWorkspaceIds: readonly string[];
  readonly enableTransparency: boolean;
  readonly startupDiagnostics: readonly StartupDiagnostic[];
  readonly revision: number;
  readonly lastError?: string;
}

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly title?: string;
}

export interface WorkspaceSessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export function createEmptyDesktopAppState(): DesktopAppState {
  return {
    workspaces: [],
    worktreesByWorkspace: {},
    selectedWorkspaceId: "",
    selectedSessionId: "",
    activeView: "threads",
    composerDraft: "",
    composerDraftSyncSource: "state",
    composerDraftSyncNonce: 0,
    composerAttachments: [],
    queuedComposerMessages: [],
    runtimeByWorkspace: {},
    sessionCommandsBySession: {},
    sessionUsageBySession: {},
    sessionExtensionUiBySession: {},
    extensionCommandCompatibilityByWorkspace: {},
    extensionFlagsByWorkspace: {},
    extensionFlagsBySession: {},
    orchestrationChildren: [],
    scheduledTasks: [],
    notificationPreferences: {
      backgroundCompletion: true,
      backgroundFailure: true,
      attentionNeeded: true,
    },
    extensionPackEnabled: true,
    integratedTerminalShell: "",
    lastViewedAtBySession: {},
    lastInteractedAtBySession: {},
    pinnedAtBySession: {},
    pinnedSessionOrder: [],
    workspaceOrder: [],
    modelSettingsScopeMode: "app-global",
    globalModelSettings: {
      enabledModelPatterns: [],
    },
    themeMode: "system",
    themePresetId: "default",
    sidebarCollapsed: false,
    threadGrouping: "time",
    collapsedWorkspaceIds: [],
    enableTransparency: false,
    startupDiagnostics: [],
    revision: 0,
  };
}

export function getSelectedWorkspace(state: DesktopAppState): WorkspaceRecord | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

export interface DesktopAppViewState {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly activeView?: AppView;
  readonly sidebarCollapsed?: boolean;
}

export function getSelectedSession(state: DesktopAppState): SessionRecord | undefined {
  return getSelectedWorkspace(state)?.sessions.find(
    (session) => session.id === state.selectedSessionId,
  );
}
