import type { SessionCatalogSnapshot } from "@pi-gui/catalogs";
import type { MuseCliDriver } from "@pi-gui/muse-cli-driver";
import type { ChildIsolationInfo, PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type {
  CreateSessionOptions,
  ForkSessionOptions,
  HostUiResponse,
  NavigateSessionTreeOptions,
  RescueCurrentRunOptions,
  SendCustomMessageOptions,
  SessionCustomMessageInput,
  SessionDriver,
  SessionEventListener,
  SessionMessageInput,
  SessionModelSelection,
  SessionQueuedMessage,
  SessionRef,
  SessionSchemaInfo,
  SessionTranscriptItem,
  WorkspaceRef,
} from "@pi-gui/session-driver";

/**
 * The desktop driver becomes a router: sessions tagged `muse-cli` (sidekick
 * children on Meta-subscription models) go to the Muse CLI driver, everything
 * else to pi-sdk-driver. Tag lookup is caller-owned so the router itself
 * holds no app state; an explicit per-session registration covers the window
 * between child creation and the child record landing in state.
 */
export class SessionDriverRouter {
  private readonly notedMuseKeys = new Set<string>();

  constructor(
    private readonly pi: PiSdkDriver,
    private readonly muse: MuseCliDriver,
    private readonly isMuseSessionRef: (sessionRef: SessionRef) => boolean,
    /**
     * pi's session-file schema version, reported alongside muse-cli sessions
     * (which have no pi file, so skew is always absent). Injected because the
     * constant lives in pi-sdk-driver; the app passes RUNTIME_SCHEMA_VERSION.
     */
    private readonly runtimeSchemaVersion: number,
  ) {}

  /** Remember a muse-cli session before its child record exists in state. */
  noteMuseSession(sessionRef: SessionRef): void {
    this.notedMuseKeys.add(sessionKeyOf(sessionRef));
  }

  /**
   * Sessions the Muse CLI driver knows about (live records plus restart
   * markers). The store merges these over pi's listing so a Muse child
   * survives refreshState with authoritative running status.
   */
  listMuseSessions(workspaceId?: string): Promise<SessionCatalogSnapshot> {
    return this.muse.listSessions(workspaceId);
  }

  private targetFor(sessionRef: SessionRef): SessionDriver {
    return this.isMuse(sessionRef) ? this.muse : this.pi;
  }

  private capableTargetFor(sessionRef: SessionRef): ChildCapableDriver {
    return this.isMuse(sessionRef) ? this.muse : this.pi;
  }

  private isMuse(sessionRef: SessionRef): boolean {
    return this.notedMuseKeys.has(sessionKeyOf(sessionRef)) || this.isMuseSessionRef(sessionRef);
  }

  // ── SessionDriver surface (session-scoped calls route by tag) ──

  createSession(workspace: WorkspaceRef, options?: CreateSessionOptions) {
    // Creation predates any tag; children use createChildSession instead.
    return this.pi.createSession(workspace, options);
  }

  validateForkSession(sessionRef: SessionRef, options: ForkSessionOptions) {
    return this.targetFor(sessionRef).validateForkSession(sessionRef, options);
  }

  forkSession(sessionRef: SessionRef, options: ForkSessionOptions) {
    return this.targetFor(sessionRef).forkSession(sessionRef, options);
  }

  openSession(sessionRef: SessionRef) {
    return this.targetFor(sessionRef).openSession(sessionRef);
  }

  archiveSession(sessionRef: SessionRef) {
    return this.targetFor(sessionRef).archiveSession(sessionRef);
  }

  unarchiveSession(sessionRef: SessionRef) {
    return this.targetFor(sessionRef).unarchiveSession(sessionRef);
  }

  sendUserMessage(sessionRef: SessionRef, input: SessionMessageInput) {
    return this.targetFor(sessionRef).sendUserMessage(sessionRef, input);
  }

  sendCustomMessage(
    sessionRef: SessionRef,
    input: SessionCustomMessageInput,
    options?: SendCustomMessageOptions,
  ) {
    return this.targetFor(sessionRef).sendCustomMessage(sessionRef, input, options);
  }

  replaceQueuedMessages(sessionRef: SessionRef, messages: readonly SessionQueuedMessage[]) {
    return this.targetFor(sessionRef).replaceQueuedMessages(sessionRef, messages);
  }

  cancelCurrentRun(sessionRef: SessionRef) {
    return this.targetFor(sessionRef).cancelCurrentRun(sessionRef);
  }

  rescueCurrentRun(sessionRef: SessionRef, options?: RescueCurrentRunOptions) {
    return this.targetFor(sessionRef).rescueCurrentRun(sessionRef, options);
  }

  setSessionModel(sessionRef: SessionRef, selection: SessionModelSelection) {
    return this.targetFor(sessionRef).setSessionModel(sessionRef, selection);
  }

  setSessionThinkingLevel(sessionRef: SessionRef, thinkingLevel: string) {
    return this.targetFor(sessionRef).setSessionThinkingLevel(sessionRef, thinkingLevel);
  }

  setSessionOrchestratorMode(sessionRef: SessionRef, enabled: boolean) {
    return this.targetFor(sessionRef).setSessionOrchestratorMode(sessionRef, enabled);
  }

  setSessionSidekickModel(sessionRef: SessionRef, selection: SessionModelSelection | undefined) {
    return this.targetFor(sessionRef).setSessionSidekickModel(sessionRef, selection);
  }

  renameSession(sessionRef: SessionRef, title: string) {
    return this.targetFor(sessionRef).renameSession(sessionRef, title);
  }

  compactSession(sessionRef: SessionRef, customInstructions?: string) {
    return this.targetFor(sessionRef).compactSession(sessionRef, customInstructions);
  }

  reloadSession(sessionRef: SessionRef) {
    return this.targetFor(sessionRef).reloadSession(sessionRef);
  }

  getSessionTree(sessionRef: SessionRef) {
    return this.targetFor(sessionRef).getSessionTree(sessionRef);
  }

  navigateSessionTree(
    sessionRef: SessionRef,
    targetId: string,
    options?: NavigateSessionTreeOptions,
  ) {
    return this.targetFor(sessionRef).navigateSessionTree(sessionRef, targetId, options);
  }

  getSessionCommands(sessionRef: SessionRef) {
    return this.targetFor(sessionRef).getSessionCommands(sessionRef);
  }

  respondToHostUiRequest(sessionRef: SessionRef, response: HostUiResponse) {
    return this.targetFor(sessionRef).respondToHostUiRequest(sessionRef, response);
  }

  subscribe(sessionRef: SessionRef, listener: SessionEventListener) {
    return this.targetFor(sessionRef).subscribe(sessionRef, listener);
  }

  closeSession(sessionRef: SessionRef) {
    return this.targetFor(sessionRef).closeSession(sessionRef);
  }

  // ── Pi-driver extras used with child sessions ──

  setChildIsolation(sessionRef: SessionRef, info: ChildIsolationInfo): void {
    this.capableTargetFor(sessionRef).setChildIsolation(sessionRef, info);
  }

  getTranscript(sessionRef: SessionRef): Promise<SessionTranscriptItem[]> {
    return this.capableTargetFor(sessionRef).getTranscript(sessionRef);
  }

  getSessionFilePath(sessionRef: SessionRef): Promise<string | undefined> {
    return this.capableTargetFor(sessionRef).getSessionFilePath(sessionRef);
  }

  reloadSessionWhenIdle(sessionRef: SessionRef): Promise<"reloaded" | "deferred"> {
    return this.capableTargetFor(sessionRef).reloadSessionWhenIdle(sessionRef);
  }

  async getSessionSchemaInfo(sessionRef: SessionRef): Promise<SessionSchemaInfo> {
    if (this.isMuse(sessionRef)) {
      // No pi session file underneath; skew is meaningless, never newer.
      return {
        fileSchemaVersion: undefined,
        runtimeSchemaVersion: this.runtimeSchemaVersion,
        writtenByNewerRuntime: false,
      };
    }
    return this.pi.getSessionSchemaInfo(sessionRef);
  }

  // ── Pi-only capabilities (background tasks, workspaces, titles) ──

  listBackgroundTasks(...args: Parameters<PiSdkDriver["listBackgroundTasks"]>) {
    return this.pi.listBackgroundTasks(...args);
  }

  readBackgroundTask(...args: Parameters<PiSdkDriver["readBackgroundTask"]>) {
    return this.pi.readBackgroundTask(...args);
  }

  stopBackgroundTask(...args: Parameters<PiSdkDriver["stopBackgroundTask"]>) {
    return this.pi.stopBackgroundTask(...args);
  }

  generateThreadTitle(...args: Parameters<PiSdkDriver["generateThreadTitle"]>) {
    return this.pi.generateThreadTitle(...args);
  }

  removeWorkspace(...args: Parameters<PiSdkDriver["removeWorkspace"]>) {
    return this.pi.removeWorkspace(...args);
  }

  renameWorkspace(...args: Parameters<PiSdkDriver["renameWorkspace"]>) {
    return this.pi.renameWorkspace(...args);
  }

  syncWorkspace(...args: Parameters<PiSdkDriver["syncWorkspace"]>) {
    return this.pi.syncWorkspace(...args);
  }
}

/** SessionDriver plus the pi-driver extras the desktop calls with child sessions. */
export interface ChildCapableDriver extends SessionDriver {
  setChildIsolation(sessionRef: SessionRef, info: ChildIsolationInfo): void;
  getTranscript(sessionRef: SessionRef): Promise<SessionTranscriptItem[]>;
  getSessionFilePath(sessionRef: SessionRef): Promise<string | undefined>;
  reloadSessionWhenIdle(sessionRef: SessionRef): Promise<"reloaded" | "deferred">;
}

function sessionKeyOf(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}
