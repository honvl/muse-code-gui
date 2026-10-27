import { defineService, type Context, type ReplicatedState } from "@earendil-works/chord";

export type AgentStatus = "running" | "done" | "error";

/** What a finished subagent actually did, read from its own session file. */
export interface AgentSummary {
  turns: number;
  toolCalls: number;
  topTools: { name: string; count: number }[];
  /** Distinct file paths the agent read or wrote, capped. */
  filesTouched: string[];
  /** Excerpt of the agent's last reply. */
  lastMessage: string;
}

/** One `agent`-tool delegation: a subagent run. */
export interface AgentRun {
  /** Stable key: thread id + tool call id. */
  key: string;
  threadId: string;
  threadTitle: string;
  /** True when the run belongs to the thread hosting the view. */
  current: boolean;
  description: string;
  subagentType: string;
  background: boolean;
  model: string | null;
  isolation: string | null;
  status: AgentStatus;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  /** pi-cc-subagent session id, parsed from the tool result; used for resume. */
  agentId: string | null;
  summary: AgentSummary | null;
}

export interface SubagentsState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  refreshedAt: number | null;
  folderName: string;
  runs: AgentRun[];
  /** Session files considered and files that could not be read. */
  scanned: number;
  unreadable: number;
}

export interface SubagentsService {
  state: ReplicatedState<SubagentsState>;
  refresh(request: Record<string, never>, context: Context): Promise<void>;
}

export const Subagents = defineService<SubagentsService>("pi-gui.example.subagents.v1");
