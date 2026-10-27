import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { collectAgentRuns, type CurrentThread } from "./collect.ts";
import { Subagents, type AgentRun, type SubagentsState } from "./contract.ts";
import { formatDuration, formatRelative, sortRuns } from "./model.ts";

const initialState = (): SubagentsState => ({
  status: "idle",
  error: null,
  refreshedAt: null,
  folderName: "",
  runs: [],
  scanned: 0,
  unreadable: 0,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/** Live `agent`-tool call state, keyed by toolCallId. */
interface LiveCall {
  toolCallId: string;
  description: string;
  subagentType: string;
  background: boolean;
  model: string | null;
  isolation: string | null;
  startedAt: number;
}

export default function subagentsExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | null = null;
  let state = initialState();
  const listeners = new Set<(next: SubagentsState) => void>();
  let running: Promise<void> | null = null;
  let again = false;
  const live = new Map<string, LiveCall>();

  const publish = (next: SubagentsState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const currentThread = (ctx: ExtensionContext): CurrentThread => ({
    id: ctx.sessionManager.getSessionId(),
    entries: ctx.sessionManager.getEntries(),
    name: ctx.sessionManager.getSessionName(),
  });

  const fail = (error: unknown) =>
    publish({
      ...state,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });

  /** Transcript runs plus live calls not yet in the transcript, live first. */
  const mergeLive = (runs: AgentRun[]): AgentRun[] => {
    if (live.size === 0) return runs;
    const seen = new Set(runs.map((run) => run.key));
    const merged: AgentRun[] = [...runs];
    const currentId = context?.sessionManager.getSessionId();
    for (const call of live.values()) {
      const key = `${currentId ?? "current"}:${call.toolCallId}`;
      if (seen.has(key)) continue;
      merged.push({
        key,
        threadId: currentId ?? "current",
        threadTitle: "This thread",
        current: true,
        description: call.description,
        subagentType: call.subagentType,
        background: call.background,
        model: call.model,
        isolation: call.isolation,
        status: "running",
        startedAt: call.startedAt,
        endedAt: null,
        durationMs: null,
        agentId: null,
        summary: null,
      });
    }
    return sortRuns(merged);
  };

  const collectOnce = async () => {
    const ctx = context;
    if (!ctx) return;
    publish({ ...state, status: "loading", error: null });
    try {
      const collected = await collectAgentRuns({
        cwd: ctx.cwd,
        sessionDir: ctx.sessionManager.getSessionDir(),
        current: currentThread(ctx),
      });
      if (ctx === context) {
        publish({
          status: "ready",
          error: null,
          refreshedAt: collected.refreshedAt,
          folderName: collected.folderName,
          runs: mergeLive(collected.runs),
          scanned: collected.scanned,
          unreadable: collected.unreadable,
        });
      }
    } catch (error) {
      fail(error);
    }
  };

  /** Coalesces overlapping requests into at most one follow-up pass. */
  const refresh = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await collectOnce();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  /** Only recompute while a view is connected; opening one always refreshes. */
  const refreshInBackground = () => {
    if (listeners.size > 0) refresh().catch(fail);
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    live.clear();
    state = initialState();
    refreshInBackground();
  });
  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
    refreshInBackground();
  });
  pi.on("agent_end", refreshInBackground);

  // An `agent`-tool call is one subagent run. Track it live; the transcript scan picks
  // up its result (agentId, duration) once the call settles.
  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "agent") return;
    const args = isRecord(event.args) ? event.args : undefined;
    const description =
      (args && typeof args.description === "string" && args.description.trim()) || "Subagent task";
    live.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      description: truncate(description, 120),
      subagentType:
        (args && typeof args.subagent_type === "string" && args.subagent_type) || "general-purpose",
      background: (args && args.run_in_background === true) || false,
      model: args && typeof args.model === "string" && args.model ? args.model : null,
      isolation:
        args && typeof args.isolation === "string" && args.isolation ? args.isolation : null,
      startedAt: Date.now(),
    });
    if (listeners.size > 0) {
      publish({ ...state, runs: mergeLive(state.runs) });
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (live.delete(event.toolCallId) && listeners.size > 0) refresh().catch(fail);
  });

  pi.on("session_shutdown", () => {
    context = null;
    live.clear();
  });

  pi.registerCommand("subagents", {
    description: "Show what pi subagents are doing: live runs and recent activity",
    async handler(_args, ctx: ExtensionContext) {
      context = ctx;
      await refresh();
      const running = state.runs.filter((run) => run.status === "running");
      const recent = state.runs.filter((run) => run.status !== "running").slice(0, 5);
      const lines = [
        `Pi subagents · ${state.folderName}`,
        running.length > 0
          ? `Running: ${running.map((run) => `● ${run.description} (${run.subagentType})`).join("; ")}`
          : "No subagents running.",
        ...recent.map(
          (run) =>
            `${run.status === "error" ? "✗" : "○"} ${run.description} · ${run.subagentType} · ${formatDuration(run.durationMs)} · ${formatRelative(run.endedAt ?? run.startedAt, Date.now())}${run.summary ? ` · ${run.summary.turns} turns, ${run.summary.toolCalls} tools` : ""}`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), state.status === "error" ? "error" : "info");
    },
  });

  registerDesktopView(pi, {
    id: "subagents",
    title: "Subagents",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "pi-gui.example.subagents.backend",
        setup(env) {
          const replicated = env.replicatedState(state);
          const listener = (next: SubagentsState) => replicated.replace(BACKGROUND_CONTEXT, next);
          listeners.add(listener);
          env.own(() => {
            listeners.delete(listener);
          });
          env.provide(Subagents, {
            state: replicated,
            async refresh(_request, callContext) {
              callContext.abortSignal?.throwIfAborted();
              await refresh();
            },
          });
        },
      }),
  });
}
