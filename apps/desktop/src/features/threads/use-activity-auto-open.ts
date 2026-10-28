import { useEffect, useRef } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { SelectedTranscriptRecord } from "../../../contracts/desktop-state";
import type { TranscriptMessage } from "../../../contracts/timeline-types";
import { mergePushedTranscript } from "../../app/transcript-merge";
import type { DesktopExtensionViewInfo } from "../../../contracts/extension-views";
import type { ToolRef } from "../../../contracts/workbench";

/** Tool calls that count as subagent delegations for first-class follow. */
const SUBAGENT_TOOL_NAMES = new Set(["agent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Running delegation call ids in a transcript. Pure so the edge trigger is
 * unit-testable without Electron: only `agent`-tool calls with a running
 * status count, never pins, messages, or settled calls.
 */
export function runningAgentCallIds(
  transcript: readonly TranscriptMessage[] | undefined,
): readonly string[] {
  if (!transcript) {
    return [];
  }
  const ids: string[] = [];
  for (const item of transcript) {
    if (!isRecord(item)) {
      continue;
    }
    if (item["kind"] !== "tool" || item["status"] !== "running") {
      continue;
    }
    const toolName = item["toolName"];
    const callId = item["callId"];
    if (typeof toolName !== "string" || typeof callId !== "string") {
      continue;
    }
    if (SUBAGENT_TOOL_NAMES.has(toolName)) {
      ids.push(callId);
    }
  }
  return ids;
}

interface ActivityAutoOpenOptions {
  readonly api: PiDesktopApi | undefined;
  readonly workspaceId: string | undefined;
  readonly sessionId: string | undefined;
  readonly sessionKey: string;
  readonly subagentsView: DesktopExtensionViewInfo | undefined;
  readonly onOpenActivityTool: ((tool: ToolRef) => void) | undefined;
}

/**
 * Follows subagent delegations: when a new running `agent`-tool call lands in
 * the selected thread's transcript, its Subagents desktop view opens in the
 * side panel. Edge-triggered per call id per thread — mount primes the seen
 * set without firing, so a call already running before mount never opens.
 * Renderer-only over the existing selected-transcript subscription; no new
 * main/preload surface. A delegation starts from the user's own prompt, so
 * opening is feedback, not an interruption; closing stays one click away.
 */
export function useActivityAutoOpen({
  api,
  workspaceId,
  sessionId,
  sessionKey,
  subagentsView,
  onOpenActivityTool,
}: ActivityAutoOpenOptions): void {
  const seenRef = useRef<Set<string>>(new Set());
  const primedSessionRef = useRef<string | null>(null);
  const latestRef = useRef({ subagentsView, onOpenActivityTool });
  latestRef.current = { subagentsView, onOpenActivityTool };

  useEffect(() => {
    if (!api || !workspaceId || !sessionId) {
      return undefined;
    }
    let disposed = false;
    // Pushes carry only the rows that changed, so this consumer keeps its own
    // copy and splices them on rather than reading a partial transcript.
    let held: SelectedTranscriptRecord | null = null;

    const handleTranscript = (transcript: readonly TranscriptMessage[] | null | undefined) => {
      if (disposed) {
        return;
      }
      const { subagentsView: view, onOpenActivityTool: open } = latestRef.current;
      const running = runningAgentCallIds(transcript ?? undefined);
      if (primedSessionRef.current !== sessionKey) {
        // First sight of this thread: remember what's already running, fire nothing.
        primedSessionRef.current = sessionKey;
        seenRef.current = new Set(running);
        return;
      }
      if (!view || !open) {
        seenRef.current = new Set([...seenRef.current, ...running]);
        return;
      }
      const fresh = running.filter((callId) => !seenRef.current.has(callId));
      seenRef.current = new Set([...seenRef.current, ...running]);
      if (fresh.length === 0) {
        return;
      }
      open({ kind: "extension", extensionId: view.extensionId, viewId: view.id });
    };

    void api
      .getSelectedTranscript()
      .then(
        (record) => {
          if (disposed) {
            return;
          }
          // Only the matching thread primes or fires. A record for another
          // session (switch race) or a transient null waits for its push.
          if (record && record.workspaceId === workspaceId && record.sessionId === sessionId) {
            held = record;
            handleTranscript(record.transcript);
          }
        },
        () => undefined,
      )
      .catch(() => undefined);
    const unsubscribe = api.onSelectedTranscriptChanged((record) => {
      if (!record || record.workspaceId !== workspaceId || record.sessionId !== sessionId) {
        return;
      }
      const merged = mergePushedTranscript(held, record);
      held = merged.record;
      handleTranscript(merged.record?.transcript);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api, workspaceId, sessionId, sessionKey]);
}
