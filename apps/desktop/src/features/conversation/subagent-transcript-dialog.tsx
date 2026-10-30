import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SubagentTranscriptResult, TranscriptMessage } from "../../../contracts/desktop-state";
import type { DisplayTimelineItem } from "../../../contracts/timeline-types";
import type { SubagentLane } from "../threads/subagent-lanes";
import { TimelineItem } from "./timeline-item";
import { trapDialogFocus } from "../../ui/dialog-focus";

export type SubagentDialogTranscriptState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: SubagentTranscriptResult }
  | { readonly status: "error"; readonly message: string };

interface SubagentTranscriptDialogProps {
  readonly lane: SubagentLane;
  readonly transcript: SubagentDialogTranscriptState | undefined;
  readonly expandedToolCallIds: ReadonlySet<string>;
  readonly onToggleToolCall: (callId: string) => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/**
 * Read-only view of one subagent run. It reuses the shared timeline rows, so
 * the transcript looks like the conversation it came from, but no composer,
 * fork, resend or extension actions are reachable from inside the dialog.
 */
export function SubagentTranscriptDialog({
  lane,
  transcript,
  expandedToolCallIds,
  onToggleToolCall,
  onRetry,
  onClose,
}: SubagentTranscriptDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".tree-modal__close")?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="tree-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-modal="true"
        aria-label={`Read-only subagent transcript: ${lane.type} ${lane.description}`}
        className="tree-modal"
        data-testid="subagent-transcript-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="tree-modal__header">
          <div>
            <div className="tree-modal__eyebrow">Read-only subagent</div>
            <h2 className="tree-modal__title">
              {lane.type} · {lane.description}
            </h2>
            <div className="tree-modal__subtitle" data-testid="subagent-transcript-dialog-meta">
              {laneStatusLabel(lane)}
              {lane.branch ? ` · ${lane.branch}` : null}
              {lane.sessionName ? ` · ${lane.sessionName}` : null}
            </div>
          </div>
          <button
            aria-label="Close subagent transcript"
            className="tree-modal__close"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="subagent-dialog__body" data-testid="subagent-transcript-dialog-body">
          {!transcript || transcript.status === "loading" ? (
            <div className="tree-modal__loading">Loading subagent transcript…</div>
          ) : transcript.status === "error" ? (
            <div className="tree-modal__empty">
              <p>{transcript.message}</p>
              <button className="button button--secondary" type="button" onClick={onRetry}>
                Retry
              </button>
            </div>
          ) : transcript.result.found === false ? (
            <div className="tree-modal__empty">
              Session file not found — showing tool status only.
            </div>
          ) : (
            <>
              {transcript.result.omittedRows > 0 ? (
                <div className="tree-modal__note">
                  +{transcript.result.omittedRows} earlier{" "}
                  {transcript.result.omittedRows === 1 ? "row" : "rows"} omitted
                </div>
              ) : null}
              {transcript.result.transcript.length === 0 ? (
                <div className="tree-modal__empty">No transcript rows yet.</div>
              ) : (
                transcript.result.transcript.map((row) => (
                  <TimelineItem
                    key={rowId(row)}
                    item={row as DisplayTimelineItem}
                    expandedToolCallIds={expandedToolCallIds}
                    onToggleToolCall={onToggleToolCall}
                  />
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function laneStatusLabel(lane: SubagentLane): string {
  switch (lane.status) {
    case "running":
      return "Running";
    case "complete":
      return "Done";
    case "failed":
      return "Failed";
  }
}

function rowId(row: TranscriptMessage): string {
  if (row.kind === "tool") {
    return row.callId;
  }
  if ("id" in row && typeof row.id === "string") {
    return row.id;
  }
  return `${row.kind}-${row.createdAt}`;
}
