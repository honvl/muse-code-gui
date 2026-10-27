import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DesktopViewContext } from "@pi-gui/extension-ui/browser";
import { Subagents, type AgentRun, type SubagentsState } from "./contract.ts";
import { formatDuration, formatElapsed, formatRelative, sortRuns } from "./model.ts";

const VISIBLE_RUNS = 10;

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:var(--background)}
.subagents{
  --fg:var(--foreground);
  --muted:color-mix(in srgb,var(--fg) 56%,transparent);
  --faint:color-mix(in srgb,var(--fg) 38%,transparent);
  --line:color-mix(in srgb,var(--fg) 10%,transparent);
  --hover:color-mix(in srgb,var(--fg) 5%,transparent);
  --track:color-mix(in srgb,var(--fg) 8%,transparent);
  --ok:#4faa7c;--err:#d95f5f;
  container:subagents/inline-size;
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
  font-size:13px;line-height:1.45;color:var(--fg);background:var(--background);
  padding:20px 20px 28px;min-height:100vh;-webkit-font-smoothing:antialiased;
}
button{font:inherit;color:inherit}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.muted{color:var(--muted)}
h1{font-size:15px;font-weight:600;margin:0}
h2{font-size:13px;font-weight:500;margin:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.scope{margin:14px 0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.icon-button{width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:6px;background:none;color:var(--muted);cursor:pointer}
.icon-button:hover{background:var(--hover);color:var(--fg)}
.icon-button svg{width:15px;height:15px}
.icon-button[data-busy=true] svg{animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
section{margin-top:24px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 0 8px;border-bottom:1px solid var(--line)}
.section-head.first{padding-top:0}
.list{list-style:none;margin:0;padding:0}
.list > li{border-bottom:1px solid var(--line)}
.row{all:unset;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto auto;column-gap:10px;align-items:center;width:100%;padding:9px 6px 9px 0;cursor:pointer;border-radius:6px}
.row:hover{background:var(--hover)}
.who{min-width:0;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint)}
.dot.on{background:var(--ok);box-shadow:0 0 6px color-mix(in srgb,var(--ok) 70%,transparent);animation:pulse 1.6s ease-in-out infinite}
.dot.err{background:var(--err)}
@keyframes pulse{50%{opacity:0.45}}
.desc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.meta{display:block;color:var(--muted);font-size:12px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.badge{font-size:11px;border:1px solid var(--line);border-radius:20px;padding:1px 8px;color:var(--muted);white-space:nowrap;flex:none}
.detail{padding:2px 0 14px 16px}
.detail .last{color:var(--muted);font-size:12px;margin:8px 0 0;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.tools{margin:8px 0 0;padding:0;list-style:none}
.tools li{display:flex;gap:8px;font-size:12px;color:var(--muted);padding:2px 0}
.files{margin:8px 0 0;padding:0;list-style:none;font-size:12px;color:var(--muted)}
.files li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:1px 0}
.more{border:0;background:none;padding:10px 0 0;color:var(--muted);cursor:pointer}
.more:hover{color:var(--fg)}
.empty{padding:28px 0;text-align:left}
.empty p{margin:0 0 4px}
.error{color:#c9771f;margin:10px 0 0}
.note{color:var(--faint);font-size:12px;margin:8px 0 0}
footer{margin-top:18px}
`;

const REFRESH_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name === "class") node.className = String(value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children)
    if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

export async function mount(root: HTMLElement, host: DesktopViewContext): Promise<() => void> {
  host.signal.throwIfAborted();
  const style = h("style");
  style.textContent = CSS;
  const view = h("main", { class: "subagents" });
  // The frame document sets --background/--foreground/--accent and updates them on theme changes.
  root.replaceChildren(style, view);

  let state: SubagentsState | null = null;
  let expanded: string | null = null;
  let showAll = false;
  let disposed = false;

  const refreshButton = h("button", {
    class: "icon-button",
    type: "button",
    "aria-label": "Refresh subagents",
    title: "Refresh",
  });
  refreshButton.innerHTML = REFRESH_ICON;

  const render = () => {
    if (disposed) return;
    const now = Date.now();
    const loading = !state || state.status === "loading" || state.status === "idle";
    refreshButton.dataset.busy = String(loading);
    const top = h("div", { class: "top" }, h("h1", {}, "Subagents"), refreshButton);
    const scope = h(
      "div",
      { class: "scope" },
      "This folder",
      state?.folderName ? h("span", { class: "muted" }, ` · ${state.folderName}`) : null,
    );
    const children: Child[] = [top, scope];
    if (!state || (state.refreshedAt === null && state.status !== "error")) {
      children.push(h("p", { class: "muted empty" }, "Reading this folder’s sessions…"));
      view.replaceChildren(...children.filter((child): child is Node => child instanceof Node));
      return;
    }
    if (state.error) children.push(h("p", { class: "error", role: "alert" }, state.error));
    const runs = sortRuns(state.runs);
    const live = runs.filter((run) => run.status === "running");
    const finished = runs.filter((run) => run.status !== "running");
    children.push(liveSection(live, now));
    children.push(finishedSection(finished, now));
    children.push(
      h(
        "footer",
        { class: "note" },
        [
          `Read ${state.scanned} saved ${state.scanned === 1 ? "thread" : "threads"}`,
          state.unreadable ? `${state.unreadable} unreadable skipped` : "",
          state.refreshedAt ? `updated ${formatRelative(state.refreshedAt, now)}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    view.replaceChildren(...children.filter((child): child is Node => child instanceof Node));
  };

  const statusDot = (run: AgentRun) =>
    h("span", {
      class: `dot${run.status === "running" ? " on" : run.status === "error" ? " err" : ""}`,
      "aria-hidden": "true",
    });

  const badges = (run: AgentRun) => [
    run.background ? h("span", { class: "badge" }, "background") : null,
    h("span", { class: "badge" }, run.subagentType),
    run.isolation ? h("span", { class: "badge" }, `⚗ ${run.isolation}`) : null,
  ];

  const runRow = (run: AgentRun, now: number, testId: string): HTMLElement => {
    const open = expanded === run.key;
    const when =
      run.status === "running"
        ? run.startedAt !== null
          ? formatElapsed(run.startedAt, now)
          : "starting…"
        : formatRelative(run.endedAt ?? run.startedAt, now);
    const sub =
      run.status === "running"
        ? [run.threadTitle, run.summary ? `${run.summary.turns} turns so far` : "working…"]
            .filter(Boolean)
            .join(" · ")
        : [
            run.threadTitle,
            run.durationMs !== null ? formatDuration(run.durationMs) : null,
            run.summary
              ? `${run.summary.turns} turns · ${run.summary.toolCalls} tools`
              : "no detail",
          ]
            .filter(Boolean)
            .join(" · ");
    const button = h(
      "button",
      {
        class: "row",
        type: "button",
        "aria-expanded": String(open),
        "data-testid": testId,
        "data-run-key": run.key,
      },
      h(
        "span",
        { class: "who" },
        statusDot(run),
        h(
          "span",
          { style: "min-width:0;flex:1" },
          h("span", { class: "desc" }, run.description),
          h("span", { class: "meta" }, sub),
        ),
      ),
      h("span", {}, ...badges(run)),
      h("span", { class: "num muted" }, when),
    );
    button.onclick = () => {
      expanded = open ? null : run.key;
      render();
    };
    return h("li", {}, button, open && run.summary ? runDetail(run) : null);
  };

  const runDetail = (run: AgentRun): HTMLElement => {
    const summary = run.summary;
    if (!summary)
      return h("div", { class: "detail" }, h("p", { class: "note" }, "No detail recorded."));
    const detail = h("div", { class: "detail", "data-testid": "subagent-detail" });
    if (summary.topTools.length > 0) {
      const tools = h("ul", { class: "tools" });
      for (const tool of summary.topTools)
        tools.append(h("li", {}, h("span", {}, tool.name), h("span", {}, `×${tool.count}`)));
      detail.append(tools);
    }
    if (summary.filesTouched.length > 0) {
      const files = h("ul", { class: "files" });
      for (const file of summary.filesTouched) files.append(h("li", { title: file }, file));
      detail.append(files);
    }
    if (summary.lastMessage) detail.append(h("p", { class: "last" }, summary.lastMessage));
    if (run.agentId) detail.append(h("p", { class: "note" }, `resume: "${run.agentId}"`));
    return detail;
  };

  const liveSection = (live: AgentRun[], now: number) => {
    const section = h(
      "section",
      { "aria-labelledby": "subagents-live" },
      h(
        "div",
        { class: "section-head first" },
        h("h2", { id: "subagents-live" }, live.length > 0 ? `Running · ${live.length}` : "Running"),
      ),
    );
    if (live.length === 0) {
      section.append(h("p", { class: "note" }, "No subagents running in this thread."));
    } else {
      const list = h("ul", { class: "list", "data-testid": "subagents-live" });
      for (const run of live) list.append(runRow(run, now, "subagent-live"));
      section.append(list);
    }
    return section;
  };

  const finishedSection = (finished: AgentRun[], now: number) => {
    const section = h(
      "section",
      { "aria-labelledby": "subagents-recent" },
      h(
        "div",
        { class: "section-head first" },
        h("h2", { id: "subagents-recent" }, `Recent · ${finished.length}`),
        h("span", { class: "muted" }, "this folder"),
      ),
    );
    if (finished.length === 0) {
      section.append(
        h(
          "div",
          { class: "empty", "data-testid": "subagents-empty" },
          h("p", {}, "No subagent runs in this folder yet"),
          h(
            "p",
            { class: "muted" },
            "Ask pi to delegate with the `agent` tool and runs will appear here with what each one did.",
          ),
        ),
      );
      return section;
    }
    const visible = showAll ? finished : finished.slice(0, VISIBLE_RUNS);
    const list = h("ul", { class: "list", "data-testid": "subagents-recent" });
    for (const run of visible) list.append(runRow(run, now, "subagent-row"));
    section.append(list);
    if (finished.length > VISIBLE_RUNS) {
      const more = h(
        "button",
        { class: "more", type: "button" },
        showAll ? "Show fewer" : `Show ${finished.length - VISIBLE_RUNS} more`,
      );
      more.onclick = () => {
        showAll = !showAll;
        render();
      };
      section.append(more);
    }
    return section;
  };

  const binding = host.services.open({
    services: [Subagents],
    assertAccess: () => host.signal.throwIfAborted(),
    onError: (reason) => {
      if (state)
        state = { ...state, error: reason instanceof Error ? reason.message : String(reason) };
      render();
    },
  });
  const service = binding.use(Subagents);
  const doRefresh = () => {
    service.refresh({}, BACKGROUND_CONTEXT).catch((reason: unknown) => {
      if (state)
        state = { ...state, error: reason instanceof Error ? reason.message : String(reason) };
      render();
    });
  };
  refreshButton.onclick = doRefresh;

  let unsubscribe = () => {};
  const clock = setInterval(render, 1000);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(clock);
    unsubscribe();
    host.signal.removeEventListener("abort", dispose);
    binding.dispose(BACKGROUND_CONTEXT).catch(() => {});
    root.replaceChildren();
  };
  host.signal.addEventListener("abort", dispose, { once: true });
  render();
  try {
    await binding.ready(BACKGROUND_CONTEXT);
    host.signal.throwIfAborted();
    unsubscribe = service.state.subscribe((next) => {
      state = next;
      render();
    });
    if (service.state.value) state = service.state.value;
    render();
    // Opening the view always recomputes; the backend coalesces overlapping requests.
    doRefresh();
  } catch (reason) {
    dispose();
    throw reason;
  }
  return dispose;
}
