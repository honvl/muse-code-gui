import { useBackgroundTasks } from "./hooks/use-background-tasks";
import { SessionRail } from "./session-rail";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type {
  DesktopAppState,
  WorkspaceRecord,
  WorkspaceSessionTarget,
} from "../../../contracts/desktop-state";
import type { SessionRecord } from "../../../contracts/desktop-state";
import type { useTurnChanges } from "./hooks/use-turn-changes";

interface ThreadRailColumnProps {
  readonly api: PiDesktopApi | undefined;
  readonly session: SessionRecord;
  readonly workspace: WorkspaceRecord;
  readonly worktreeName: string | undefined;
  readonly state: DesktopAppState | null;
  readonly sessionKey: string;
  readonly turnChanges: Pick<ReturnType<typeof useTurnChanges>, "turns" | "openTurnChange">;
  readonly onStopRun: () => void;
}

/**
 * Session details rail for the open thread, mounted as the last child of the
 * thread canvas so it overlays the right edge. Owns background-task polling
 * (the only live data the rail needs beyond App state).
 */
export function ThreadRailColumn({
  api,
  session,
  workspace,
  worktreeName,
  state,
  sessionKey,
  turnChanges,
  onStopRun,
}: ThreadRailColumnProps) {
  const target: WorkspaceSessionTarget | null = session
    ? { workspaceId: workspace.id, sessionId: session.id }
    : null;
  const backgroundTasks = useBackgroundTasks(api, target);

  return (
    <SessionRail
      session={session}
      workspaceName={workspace.name}
      workspacePath={workspace.path}
      worktreeName={worktreeName}
      provider={session.config?.provider}
      modelId={session.config?.modelId}
      thinkingLevel={session.config?.thinkingLevel}
      usage={state?.sessionUsageBySession[sessionKey]}
      tasks={backgroundTasks.tasks}
      stoppingTaskId={backgroundTasks.stoppingTaskId}
      onStopTask={backgroundTasks.stopTask}
      onReadOutput={backgroundTasks.readOutput}
      turns={turnChanges.turns}
      onOpenTurnChange={turnChanges.openTurnChange}
      onStopRun={onStopRun}
    />
  );
}
