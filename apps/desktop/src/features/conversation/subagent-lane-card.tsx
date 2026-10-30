import { useState } from "react";
import type { SubagentLane } from "../threads/subagent-lanes";
import {
  SubagentTranscriptDialog,
  type SubagentDialogTranscriptState,
} from "./subagent-transcript-dialog";
import type { SubagentTranscriptResult } from "../../../contracts/desktop-state";

interface SubagentLaneCardProps {
  readonly workspaceId: string | undefined;
  readonly lanes: readonly SubagentLane[];
  readonly getTranscript: (lane: SubagentLane) => Promise<SubagentTranscriptResult>;
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

/**
 * Subagent lanes under the parent thread: one compact row per third-party
 * `agent` tool call, matching the running-child rows (status dot inline before
 * a left-aligned "type · description", status as a muted trailing label, then
 * one muted activity line and the branch). Opening a row shows the subagent's
 * own session transcript in a dedicated read-only dialog.
 */
export function SubagentLaneCard({ workspaceId, lanes, getTranscript }: SubagentLaneCardProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<
    Readonly<Record<string, SubagentDialogTranscriptState>>
  >({});
  const [expandedToolCallIds, setExpandedToolCallIds] = useState<ReadonlySet<string>>(new Set());

  if (lanes.length === 0 || !workspaceId) {
    return null;
  }

  const fetchTranscript = (lane: SubagentLane) => {
    setTranscripts((current) => ({ ...current, [lane.key]: { status: "loading" } }));
    getTranscript(lane).then(
      (result) =>
        setTranscripts((current) => ({ ...current, [lane.key]: { status: "ready", result } })),
      (error: unknown) =>
        setTranscripts((current) => ({
          ...current,
          [lane.key]: {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        })),
    );
  };

  const toggleLane = (lane: SubagentLane) => {
    if (openKey === lane.key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(lane.key);
    if (!transcripts[lane.key]) {
      fetchTranscript(lane);
    }
  };

  const toggleToolCall = (callId: string) => {
    setExpandedToolCallIds((current) => {
      const next = new Set(current);
      if (next.has(callId)) {
        next.delete(callId);
      } else {
        next.add(callId);
      }
      return next;
    });
  };

  const openLane = openKey ? (lanes.find((lane) => lane.key === openKey) ?? null) : null;

  return (
    <>
      <section className="session-rail__card" data-testid="session-rail-subagents">
        <h3 className="session-rail__card-title">Subagents</h3>
        {lanes.map((lane) => {
          const preview = lane.activity[lane.activity.length - 1] ?? lane.detailText;
          return (
            <div key={lane.key} data-testid={`session-rail-subagent-${lane.key}`}>
              <button
                className="session-rail__subagent-toggle"
                data-testid={`session-rail-subagent-toggle-${lane.key}`}
                type="button"
                onClick={() => toggleLane(lane)}
                aria-expanded={openKey === lane.key}
                title={lane.description}
              >
                <span
                  className={`session-rail__pip session-rail__pip--${laneStatusTone(lane.status)}`}
                  aria-hidden="true"
                />
                <span className="session-rail__subagent-title">
                  {lane.type} · {lane.description}
                </span>
                <span className="session-rail__subagent-status">{laneStatusLabel(lane)}</span>
              </button>
              {preview ? (
                <div
                  className="session-rail__row session-rail__row--muted session-rail__child-output"
                  title={preview}
                >
                  {preview}
                </div>
              ) : null}
              {lane.branch ? (
                <div
                  className="session-rail__row session-rail__row--muted"
                  title={lane.worktreeDir ?? lane.branch}
                >
                  {lane.branch}
                  {lane.worktreeKept === false ? " (removed)" : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </section>

      {openLane ? (
        <SubagentTranscriptDialog
          lane={openLane}
          transcript={transcripts[openLane.key]}
          expandedToolCallIds={expandedToolCallIds}
          onToggleToolCall={toggleToolCall}
          onRetry={() => fetchTranscript(openLane)}
          onClose={() => setOpenKey(null)}
        />
      ) : null}
    </>
  );
}

function laneStatusTone(status: SubagentLane["status"]): string {
  switch (status) {
    case "running":
      return "running";
    case "complete":
      return "idle";
    case "failed":
      return "failed";
  }
}
