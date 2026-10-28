import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SessionModelSelection, SessionRef } from "@pi-gui/session-driver/types";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { DesktopAppState, ThinkingLevel } from "../../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import { updateSnapshot } from "../../../app/desktop-app-state";

interface LeadModeHookParams {
  readonly api: PiDesktopApi | undefined;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly target: SessionRef | null;
}

interface UseSidekickSelectionParams extends LeadModeHookParams {
  readonly sidekick: SessionModelSelection | undefined;
}

/**
 * Owns the lead-mode sidekick model: the current `config.sidekick` selection
 * plus setters for it and its reasoning effort that apply immediately through
 * the session bridge (`null` clears back to the workspace default).
 */
export function useSidekickSelection(params: UseSidekickSelectionParams) {
  const { api, setSnapshot, target, sidekick } = params;
  const [pending, setPending] = useState(false);
  const setSidekick = useCallback(
    (selection: SessionModelSelection | null) => {
      if (!api || !target) {
        return;
      }
      setPending(true);
      void updateSnapshot(setSnapshot, () =>
        api.setSessionSidekickModel(target.workspaceId, target.sessionId, selection),
      )
        .catch((error: unknown) => {
          console.error("[renderer] updateSnapshot failed", error);
        })
        .finally(() => {
          setPending(false);
        });
    },
    [api, setSnapshot, target],
  );
  const setSidekickThinkingLevel = useCallback(
    (level: string | null) => {
      if (!api || !target) {
        return;
      }
      void updateSnapshot(setSnapshot, () =>
        api.setSessionSidekickThinkingLevel(
          target.workspaceId,
          target.sessionId,
          level as ThinkingLevel | null,
        ),
      ).catch((error: unknown) => {
        console.error("[renderer] updateSnapshot failed", error);
      });
    },
    [api, setSnapshot, target],
  );
  return { sidekick, setSidekick, setSidekickThinkingLevel, pending };
}

interface UseSessionConfigControlsParams extends LeadModeHookParams {
  readonly orchestratorMode: boolean | undefined;
}

/**
 * Hosts the session-scoped config setters (lead model, thinking level,
 * orchestrator mode) so App.tsx stays a composer. Same bridge-call pattern
 * as the sidekick setter above.
 */
export function useSessionConfigControls(params: UseSessionConfigControlsParams) {
  const { api, setSnapshot, target, orchestratorMode } = params;
  const setSessionModel = useCallback(
    (provider: string, modelId: string) => {
      if (!api || !target) {
        return;
      }
      void updateSnapshot(setSnapshot, () =>
        api.setSessionModel(target.workspaceId, target.sessionId, provider, modelId),
      ).catch((error: unknown) => {
        console.error("[renderer] updateSnapshot failed", error);
      });
    },
    [api, setSnapshot, target],
  );

  const setSessionThinking = useCallback(
    (level: string) => {
      if (!api || !target) {
        return;
      }
      void updateSnapshot(setSnapshot, () =>
        api.setSessionThinkingLevel(
          target.workspaceId,
          target.sessionId,
          level as NonNullable<RuntimeSnapshot["settings"]["defaultThinkingLevel"]>,
        ),
      ).catch((error: unknown) => {
        console.error("[renderer] updateSnapshot failed", error);
      });
    },
    [api, setSnapshot, target],
  );

  const setOrchestratorMode = useCallback(
    (enabled: boolean) => {
      if (!api || !target) {
        return;
      }
      void updateSnapshot(setSnapshot, () =>
        api.setSessionOrchestratorMode(target.workspaceId, target.sessionId, enabled),
      ).catch((error: unknown) => {
        console.error("[renderer] updateSnapshot failed", error);
      });
    },
    [api, setSnapshot, target],
  );

  return {
    orchestratorMode: orchestratorMode === true,
    setOrchestratorMode,
    setSessionModel,
    setSessionThinking,
  };
}
