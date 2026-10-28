import { useMemo } from "react";
import { useBackgroundTasks } from "./hooks/use-background-tasks";
import { SessionRail } from "./session-rail";
import {
  collectDelegatedSessionKeys,
  summarizeOrchestrationUsage,
} from "../threads/orchestration-usage";
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
  state,
  sessionKey,
  turnChanges,
  onStopRun,
}: ThreadRailColumnProps) {
  const target: WorkspaceSessionTarget | null = session
    ? { workspaceId: workspace.id, sessionId: session.id }
    : null;
  const backgroundTasks = useBackgroundTasks(api, target);
  const orchestrationChildren = state?.orchestrationChildren;
  const sessionUsageBySession = state?.sessionUsageBySession;
  const workspaceId = workspace.id;
  const sessionId = session.id;
  // Both walk every child record (the delegated keys are a BFS), so recompute
  // only when the children, the usage map or the open thread change.
  const { laneUsage, delegatedThreadCount } = useMemo(() => {
    const sessionRef = { workspaceId, sessionId };
    const hasOrchestrationChildren = (orchestrationChildren ?? []).some(
      (child) => child.parentSessionId === sessionId,
    );
    const usage =
      orchestrationChildren && sessionUsageBySession && hasOrchestrationChildren
        ? summarizeOrchestrationUsage(sessionRef, orchestrationChildren, sessionUsageBySession)
        : undefined;
    return {
      laneUsage: usage,
      delegatedThreadCount: usage
        ? collectDelegatedSessionKeys(sessionRef, orchestrationChildren ?? []).length
        : 0,
    };
  }, [orchestrationChildren, sessionUsageBySession, workspaceId, sessionId]);

  return (
    <SessionRail
      session={session}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      workspacePath={workspace.path}
      provider={session.config?.provider}
      modelId={session.config?.modelId}
      thinkingLevel={session.config?.thinkingLevel}
      usage={state?.sessionUsageBySession[sessionKey]}
      laneUsage={laneUsage}
      delegatedThreadCount={delegatedThreadCount}
      tasks={backgroundTasks.tasks}
      stoppingTaskId={backgroundTasks.stoppingTaskId}
      onStopTask={backgroundTasks.stopTask}
      onReadOutput={backgroundTasks.readOutput}
      turns={turnChanges.turns}
      onOpenTurnChange={turnChanges.openTurnChange}
      onStopRun={onStopRun}
      orchestrationChildren={state?.orchestrationChildren ?? []}
    />
  );
}
