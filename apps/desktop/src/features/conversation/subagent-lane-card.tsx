import { useState } from "react";
import type {
  SubagentTranscriptResult,
  TranscriptMessage,
} from "../../../contracts/desktop-state";
import type { DisplayTimelineItem } from "../../../contracts/timeline-types";
import type { SubagentLane } from "../threads/subagent-lanes";
import { TimelineItem } from "./timeline-item";

interface SubagentLaneCardProps {
  readonly workspaceId: string | undefined;
  readonly lanes: readonly SubagentLane[];
  readonly getTranscript: (lane: SubagentLane) => Promise<SubagentTranscriptResult>;
}

type LaneTranscriptState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: SubagentTranscriptResult }
  | { readonly status: "error"; readonly message: string };

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
 * Read-only subagent lanes under the parent thread: one row per third-party
 * `agent` tool call, derived from the transcript. Opening a row fetches the
 * subagent's own session transcript (when its file can be located) and draws
 * it with the shared read-only timeline rows — no composer, fork or resend
 * actions are reachable from here.
 */
export function SubagentLaneCard({ workspaceId, lanes, getTranscript }: SubagentLaneCardProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Readonly<Record<string, LaneTranscriptState>>>({});
  const [expandedToolCallIds, setExpandedToolCallIds] = useState<ReadonlySet<string>>(new Set());

  if (lanes.length === 0 || !workspaceId) {
    return null;
  }

  const toggleLane = (lane: SubagentLane) => {
    if (openKey === lane.key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(lane.key);
    if (transcripts[lane.key]) {
      return;
    }
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

  return (
    <section className="session-rail__card" data-testid="session-rail-subagents">
      <h3 className="session-rail__card-title">Subagents</h3>
      {lanes.map((lane) => {
        const open = openKey === lane.key;
        const state = transcripts[lane.key];
        const latestActivity = lane.activity[lane.activity.length - 1];
        return (
          <div key={lane.key} data-testid={`session-rail-subagent-${lane.key}`}>
            <button
              className="session-rail__row session-rail__subagent-toggle"
              data-testid={`session-rail-subagent-toggle-${lane.key}`}
              type="button"
              onClick={() => toggleLane(lane)}
              aria-expanded={open}
              title={lane.description}
            >
              <span
                className={`session-rail__pip session-rail__pip--${laneStatusTone(lane.status)}`}
                aria-hidden="true"
              />
              <span className="session-rail__child-head">
                {lane.type} · {lane.description}
              </span>
              <span className="session-rail__row--muted">{laneStatusLabel(lane)}</span>
            </button>
            {lane.branch ? (
              <div
                className="session-rail__row session-rail__row--muted"
                title={lane.worktreeDir ?? lane.branch}
              >
                {lane.branch}
                {lane.worktreeKept === false ? " (removed)" : null}
              </div>
            ) : null}
            {latestActivity && !open ? (
              <div
                className="session-rail__row session-rail__row--muted session-rail__child-output"
                title={latestActivity}
              >
                {latestActivity}
              </div>
            ) : null}
            {lane.detailText && !open ? (
              <div
                className="session-rail__row session-rail__row--muted session-rail__child-output"
                title={lane.detailText}
              >
                {lane.detailText}
              </div>
            ) : null}
            {open ? (
              <div data-testid={`session-rail-subagent-transcript-${lane.key}`}>
                {!state || state.status === "loading" ? (
                  <div className="session-rail__row session-rail__row--muted">
                    Loading subagent transcript…
                  </div>
                ) : state.status === "error" ? (
                  <div className="session-rail__row session-rail__row--muted">{state.message}</div>
                ) : state.result.found === false ? (
                  <div className="session-rail__row session-rail__row--muted">
                    Session file not found — showing tool status only.
                  </div>
                ) : (
                  <>
                    {state.result.omittedRows > 0 ? (
                      <div className="session-rail__row session-rail__row--muted">
                        +{state.result.omittedRows} earlier{" "}
                        {state.result.omittedRows === 1 ? "row" : "rows"} omitted
                      </div>
                    ) : null}
                    {state.result.transcript.length === 0 ? (
                      <div className="session-rail__row session-rail__row--muted">
                        No transcript rows yet.
                      </div>
                    ) : (
                      state.result.transcript.map((row) => (
                        <SubagentTranscriptRow
                          key={rowId(row)}
                          item={row as DisplayTimelineItem}
                          expandedToolCallIds={expandedToolCallIds}
                          onToggleToolCall={toggleToolCall}
                        />
                      ))
                    )}
                  </>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
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

function rowId(row: TranscriptMessage): string {
  if (row.kind === "tool") {
    return row.callId;
  }
  if ("id" in row && typeof row.id === "string") {
    return row.id;
  }
  return `${row.kind}-${row.createdAt}`;
}

function SubagentTranscriptRow({
  item,
  expandedToolCallIds,
  onToggleToolCall,
}: {
  readonly item: DisplayTimelineItem;
  readonly expandedToolCallIds: ReadonlySet<string>;
  readonly onToggleToolCall: (callId: string) => void;
}) {
  return (
    <div className="session-rail__subagent-row">
      <TimelineItem
        item={item}
        expandedToolCallIds={expandedToolCallIds}
        onToggleToolCall={onToggleToolCall}
      />
    </div>
  );
}
