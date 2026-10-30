// node_modules/@earendil-works/chord/dist/context/index.js
var ABORT_SIGNAL_CONTEXT_KEY = Object.freeze({
  token: /* @__PURE__ */ Symbol("chord.abortSignal")
});
var BaseContext = class {
  get abortSignal() {
    return this.value(ABORT_SIGNAL_CONTEXT_KEY);
  }
};
var EmptyContext = class extends BaseContext {
  #name;
  constructor(name) {
    super();
    this.#name = name;
  }
  value(_key) {
    return void 0;
  }
  toString() {
    return this.#name;
  }
};
var BACKGROUND_CONTEXT = new EmptyContext("[Context BACKGROUND_CONTEXT]");
var TODO_CONTEXT = new EmptyContext("[Context TODO_CONTEXT]");

// node_modules/@earendil-works/chord/dist/api.js
function defineService(id, options) {
  if (id.length === 0)
    throw new TypeError("Service ID must not be empty");
  if (id.startsWith("$chord."))
    throw new TypeError("Service IDs beginning with $chord. are reserved");
  return Object.freeze({ id, local: options?.local ?? false });
}

// examples/desktop-extensions/muse-usage/contract.ts
var MuseUsage = defineService("pi-gui.example.muse-usage.v1");

// examples/desktop-extensions/muse-usage/model.ts
var META_PROVIDER = "meta";
var PERIODS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" }
];
function emptyCounts() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}
function addCounts(target, usage) {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost;
}
function totalTokens(counts) {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}
function cacheHitRate(counts) {
  const prompt = counts.input + counts.cacheRead + counts.cacheWrite;
  return prompt > 0 ? counts.cacheRead / prompt : null;
}
function localDayStart(time) {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}
function periodStart(period, now) {
  if (period === "all") return null;
  const days = period === "today" ? 0 : period === "7d" ? 6 : 29;
  const start = new Date(localDayStart(now));
  start.setDate(start.getDate() - days);
  return start.getTime();
}
function sumProvider(days, provider, since) {
  const counts = emptyCounts();
  for (const day of days) {
    if (since !== null && day.dayStart < since) continue;
    const dayCounts = day.providers[provider];
    if (dayCounts) addCounts(counts, dayCounts);
  }
  return counts;
}
function sumAll(days, since) {
  const counts = emptyCounts();
  for (const day of days) {
    if (since !== null && day.dayStart < since) continue;
    for (const dayCounts of Object.values(day.providers)) addCounts(counts, dayCounts);
  }
  return counts;
}
function summarizePeriod(threads, period, now) {
  const since = periodStart(period, now);
  const meta = emptyCounts();
  const total = emptyCounts();
  let threadCount = 0;
  for (const thread of threads) {
    const threadMeta = sumProvider(thread.days, META_PROVIDER, since);
    const threadTotal = sumAll(thread.days, since);
    if (totalTokens(threadTotal) === 0) continue;
    threadCount += 1;
    addCounts(meta, threadMeta);
    addCounts(total, threadTotal);
  }
  const metaTokens = totalTokens(meta);
  const totalTokensValue = totalTokens(total);
  return {
    meta,
    metaTokens,
    metaCacheHit: cacheHitRate(meta),
    total,
    totalTokens: totalTokensValue,
    subscription: totalTokensValue > 0 && total.cost === 0,
    threadCount
  };
}
function formatTokens(value) {
  const units = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"]
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
    }
  }
  return String(Math.round(value));
}
function formatPercent(value) {
  if (value === null) return "\u2014";
  if (value > 0 && value < 0.01) return "<1%";
  return `${Math.round(value * 100)}%`;
}
function formatCost(value) {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(value >= 1e3 ? 0 : 2)}`;
}
function formatRelative(time, now) {
  if (time === null || !Number.isFinite(time)) return "never";
  const minutes = Math.floor((now - time) / 6e4);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...sameYear ? {} : { year: "numeric" }
  });
}
function quotaTone(usedPercent) {
  if (usedPercent >= 90) return "hot";
  if (usedPercent >= 70) return "warm";
  return "ok";
}
function formatResetMs(resetsAtMs, now) {
  if (resetsAtMs === null || !Number.isFinite(resetsAtMs)) return "reset time unknown";
  const diff = resetsAtMs - now;
  if (diff <= 0) return "resetting now";
  const minutes = Math.floor(diff / 6e4);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `resets in ${days}d` : `resets in ${days}d ${hours % 24}h`;
}

// examples/desktop-extensions/muse-usage/desktop.ts
var VISIBLE_THREADS = 8;
var TOKEN_PARTS = [
  { key: "input", label: "Input", color: "var(--c-input)" },
  { key: "output", label: "Output", color: "var(--c-output)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--c-write)" },
  { key: "cacheRead", label: "Cache read", color: "var(--c-read)" }
];
var CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:var(--background)}
.muse-usage{
  --fg:var(--foreground);
  --muted:color-mix(in srgb,var(--fg) 56%,transparent);
  --faint:color-mix(in srgb,var(--fg) 38%,transparent);
  --line:color-mix(in srgb,var(--fg) 10%,transparent);
  --hover:color-mix(in srgb,var(--fg) 5%,transparent);
  --track:color-mix(in srgb,var(--fg) 8%,transparent);
  --c-meta:#8b6cd9;--c-other:color-mix(in srgb,var(--fg) 30%,transparent);
  --ok:#4faa7c;--c-warn:#e4a73b;--c-hot:#d95f5f;
  --c-input:#3f7be0;--c-output:#e06a3c;--c-write:#4faa7c;--c-read:#e4a73b;
  container:muse-usage/inline-size;
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
  font-size:13px;line-height:1.45;color:var(--fg);background:var(--background);
  padding:20px 20px 28px;min-height:100vh;-webkit-font-smoothing:antialiased;
}
button,select{font:inherit;color:inherit}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.muted{color:var(--muted)}
h1{font-size:15px;font-weight:600;margin:0}
h2{font-size:13px;font-weight:500;margin:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.icon-button{width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:6px;background:none;color:var(--muted);cursor:pointer}
.icon-button:hover{background:var(--hover);color:var(--fg)}
.icon-button svg{width:15px;height:15px}
.icon-button[data-busy=true] svg{animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.scope{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:14px 0 6px}
.scope-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.picker{position:relative;display:inline-flex;align-items:center;color:var(--muted);white-space:nowrap}
.picker select{appearance:none;-webkit-appearance:none;border:0;background:none;padding:3px 18px 3px 4px;border-radius:6px;cursor:pointer;color:var(--fg)}
.picker select:hover{background:var(--hover)}
.picker select:focus-visible,.icon-button:focus-visible,.row:focus-visible,.more:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 70%,transparent);outline-offset:1px}
.picker svg{position:absolute;right:4px;width:10px;height:10px;pointer-events:none;color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));column-gap:20px;margin:0}
.stat{display:flex;align-items:baseline;gap:8px;padding:9px 0;border-bottom:1px solid var(--line);min-width:0}
.stat dt{color:var(--muted)}
.stat dd{margin:0;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{display:flex;gap:2px;height:8px;border-radius:4px;overflow:hidden;background:var(--track)}
.bar span{min-width:3px;height:100%}
section{margin-top:26px}
.stats + section{margin-top:22px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 0 8px;border-bottom:1px solid var(--line)}
.section-head.first{padding-top:0}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
.list .label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.swatch{width:9px;height:9px;border-radius:2px;flex:none}
.note{color:var(--faint);font-size:12px;margin:8px 0 0}
.quota{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-top:10px}
.quota + .quota{margin-top:10px}
.quota .row{display:flex;align-items:baseline;gap:10px}
.quota .name{font-weight:600}
.quota .pct{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600}
.quota.ok .pct{color:var(--ok)}.quota.warm .pct{color:var(--c-warn)}.quota.hot .pct{color:var(--c-hot)}
.meter{height:6px;border-radius:3px;background:var(--track);overflow:hidden;margin:8px 0 6px}
.meter span{display:block;height:100%;border-radius:3px}
.quota.ok .meter span{background:var(--ok)}.quota.warm .meter span{background:var(--c-warn)}.quota.hot .meter span{background:var(--c-hot)}
.threads{list-style:none;margin:0;padding:0}
.threads > li{border-bottom:1px solid var(--line)}
.row{all:unset;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) 72px 64px;column-gap:12px;align-items:center;width:100%;padding:9px 6px 9px 0;cursor:pointer;border-radius:6px}
.row:hover{background:var(--hover)}
.who{min-width:0}
.title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{display:block;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.meta .here{color:var(--accent)}
.more{border:0;background:none;padding:10px 0 0;color:var(--muted);cursor:pointer}
.more:hover{color:var(--fg)}
.detail{padding:4px 0 14px}
.empty{padding:28px 0;text-align:left}
.empty p{margin:0 0 4px}
.error{color:#c9771f;margin:10px 0 0}
footer{margin-top:18px}
@container muse-usage (max-width:560px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
var REFRESH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';
var CHEVRON_ICON = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.8 5 6.6 8 3.8"/></svg>';
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === void 0 || value === false) continue;
    if (name === "class") node.className = String(value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children)
    if (child !== null && child !== void 0 && child !== false) node.append(child);
  return node;
}
function periodPicker(label, options, value, onChange) {
  const select = h("select", { "aria-label": label });
  for (const option of options) select.append(h("option", { value: option.id }, option.label));
  select.value = value;
  select.onchange = () => onChange(select.value);
  const wrap = h("span", { class: "picker" }, select);
  wrap.insertAdjacentHTML("beforeend", CHEVRON_ICON);
  return wrap;
}
async function mount(root, host) {
  host.signal.throwIfAborted();
  const style = h("style");
  style.textContent = CSS;
  const view = h("main", { class: "muse-usage" });
  root.replaceChildren(style, view);
  let state = null;
  let period = "7d";
  let showAllThreads = false;
  let expandedThread = null;
  let disposed = false;
  const refreshButton = h("button", {
    class: "icon-button",
    type: "button",
    "aria-label": "Refresh Muse usage",
    title: "Refresh"
  });
  refreshButton.innerHTML = REFRESH_ICON;
  const render = () => {
    if (disposed) return;
    const now = Date.now();
    const loading = !state || state.status === "loading" || state.status === "idle";
    refreshButton.dataset.busy = String(loading);
    const top = h("div", { class: "top" }, h("h1", {}, "Muse Usage"), refreshButton);
    const scope = h(
      "div",
      { class: "scope" },
      h(
        "span",
        { class: "scope-name" },
        "This folder",
        state?.folderName ? h("span", { class: "muted" }, ` \xB7 ${state.folderName}`) : null
      ),
      periodPicker("Period", PERIODS, period, (next) => {
        period = next;
        render();
      })
    );
    const children = [top, scope];
    const error = state?.error;
    if (!state || state.refreshedAt === null && state.status !== "error") {
      children.push(h("p", { class: "muted empty" }, "Reading this folder\u2019s threads\u2026"));
      view.replaceChildren(...children.filter((child) => child instanceof Node));
      return;
    }
    if (error) children.push(h("p", { class: "error", role: "alert" }, error));
    children.push(quotaSection(state, now));
    const summary = summarizePeriod(state.threads, period, now);
    children.push(metaStats(summary));
    children.push(breakdownSection(summary));
    children.push(modelsSection(state));
    children.push(threadsSection(state, now));
    children.push(
      h(
        "footer",
        { class: "note" },
        [
          `Read ${state.scanned} saved ${state.scanned === 1 ? "thread" : "threads"}`,
          state.unreadable ? `${state.unreadable} unreadable skipped` : "",
          state.capped ? `${state.capped} older not read` : "",
          state.refreshedAt ? `updated ${formatRelative(state.refreshedAt, now)}` : ""
        ].filter(Boolean).join(" \xB7 ")
      )
    );
    view.replaceChildren(...children.filter((child) => child instanceof Node));
  };
  const quotaCard = (name, detail, limit, testId) => {
    const now = Date.now();
    if (!limit) {
      return h(
        "div",
        { class: "quota", "data-testid": testId },
        h(
          "div",
          { class: "row" },
          h("span", { class: "name" }, name),
          h("span", { class: "pct muted" }, "\u2014")
        ),
        h("p", { class: "hint" }, detail)
      );
    }
    const tone = quotaTone(limit.usedPercent);
    const meter = h("div", { class: "meter" }, h("span", {}));
    meter.firstChild.style.width = `${Math.min(100, limit.usedPercent)}%`;
    return h(
      "div",
      { class: `quota ${tone}`, "data-testid": testId },
      h(
        "div",
        { class: "row" },
        h("span", { class: "name" }, name),
        h("span", { class: "pct" }, `${Math.round(limit.usedPercent)}%`)
      ),
      meter,
      h("div", { class: "muted" }, formatResetMs(limit.resetsAtMs, now))
    );
  };
  const quotaSection = (current, now) => {
    const section = h(
      "section",
      { "aria-label": "Subscription allowance" },
      h(
        "div",
        { class: "section-head first" },
        h("h2", {}, "Allowance"),
        h("span", { class: "muted" }, current.quota.tier ?? "`muse usage`")
      )
    );
    if (!current.quota.window && !current.quota.weekly) {
      section.append(
        h(
          "p",
          { class: "note" },
          current.quota.error ?? "Allowance unavailable \u2014 run `muse usage` in a terminal."
        )
      );
      return section;
    }
    section.append(
      quotaCard("Window", "subscription window", current.quota.window, "quota-window"),
      quotaCard("Weekly", "subscription week", current.quota.weekly, "quota-weekly")
    );
    if (current.quota.error) section.append(h("p", { class: "error" }, current.quota.error));
    else if (current.quota.fetchedAt)
      section.append(
        h(
          "p",
          { class: "note" },
          `Fetched ${formatRelative(current.quota.fetchedAt, now)} \xB7 cached 60s`
        )
      );
    return section;
  };
  const breakdownSection = (summary) => {
    const bar = h("div", {
      class: "bar",
      role: "img",
      "aria-label": `Muse token breakdown: ${TOKEN_PARTS.filter(
        (part) => summary.meta[part.key] > 0
      ).map(
        (part) => `${part.label} ${formatPercent(summary.meta[part.key] / summary.metaTokens)}`
      ).join(", ")}`
    });
    for (const part of TOKEN_PARTS) {
      if (summary.meta[part.key] <= 0) continue;
      const segment = h("span", {
        title: `${part.label} \xB7 ${formatTokens(summary.meta[part.key])} \xB7 ${formatPercent(summary.meta[part.key] / summary.metaTokens)}`
      });
      segment.style.flex = `${summary.meta[part.key]} 1 0`;
      segment.style.background = part.color;
      bar.append(segment);
    }
    const rows = h("ul", { class: "list", "data-testid": "muse-breakdown" });
    for (const part of TOKEN_PARTS) {
      rows.append(
        h(
          "li",
          {},
          h("span", { class: "swatch", "aria-hidden": "true", style: `background:${part.color}` }),
          h("span", { class: "label" }, part.label),
          h(
            "span",
            { class: "num muted" },
            formatPercent(summary.meta[part.key] / summary.metaTokens)
          ),
          h(
            "span",
            { class: "num", "data-testid": `muse-${part.key}` },
            formatTokens(summary.meta[part.key])
          )
        )
      );
    }
    return h(
      "section",
      { "aria-labelledby": "muse-breakdown" },
      bar,
      h(
        "div",
        { class: "section-head" },
        h("h2", { id: "muse-breakdown" }, "Breakdown"),
        h("span", { class: "muted" }, "Muse \xB7 this period")
      ),
      rows
    );
  };
  const metaStats = (summary) => {
    const stat = (label, value, testId, title) => h(
      "div",
      { class: "stat" },
      h("dt", {}, label),
      h("dd", { "data-testid": testId, ...title ? { title } : {} }, value)
    );
    return h(
      "dl",
      { class: "stats" },
      stat(
        "Muse",
        formatTokens(summary.metaTokens),
        "muse-tokens",
        summary.metaTokens.toLocaleString()
      ),
      stat(
        "All models",
        formatTokens(summary.totalTokens),
        "muse-total",
        summary.totalTokens.toLocaleString()
      ),
      stat("Cache hit", formatPercent(summary.metaCacheHit), "muse-cache-hit"),
      summary.subscription ? stat("Cost", "Subscription", "muse-cost", "No per-token cost reported by the provider") : stat("Cost", formatCost(summary.total.cost), "muse-cost")
    );
  };
  const modelsSection = (current) => {
    const section = h(
      "section",
      { "aria-labelledby": "muse-models" },
      h(
        "div",
        { class: "section-head first" },
        h("h2", { id: "muse-models" }, "Models"),
        h("span", { class: "muted" }, "all time in this folder")
      )
    );
    if (current.models.length === 0) {
      section.append(h("p", { class: "note" }, "No model replies in this folder yet."));
      return section;
    }
    const max = Math.max(...current.models.map((model) => model.tokens));
    const bar = h("div", { class: "bar", role: "img", "aria-label": "Token share by model" });
    for (const model of current.models.slice(0, 8)) {
      const segment = h("span", {
        title: `${model.displayName ?? model.model} \xB7 ${formatTokens(model.tokens)}`
      });
      segment.style.flex = `${Math.max(1, Math.round(model.tokens / max * 100))} 1 0`;
      segment.style.background = model.provider === META_PROVIDER ? "var(--c-meta)" : "var(--c-other)";
      bar.append(segment);
    }
    section.append(bar);
    const list = h("ul", { class: "list", "data-testid": "muse-models" });
    for (const model of current.models.slice(0, 8)) {
      list.append(
        h(
          "li",
          {},
          h("span", {
            class: "swatch",
            "aria-hidden": "true",
            style: `background:${model.provider === META_PROVIDER ? "var(--c-meta)" : "var(--c-other)"}`
          }),
          h(
            "span",
            { class: "label" },
            model.displayName ?? model.model,
            model.provider !== META_PROVIDER ? h("span", { class: "muted" }, ` \xB7 ${model.provider}`) : null,
            model.subscription ? h("span", { class: "muted" }, " \xB7 Subscription") : null
          ),
          h("span", { class: "num muted" }, `${model.replies} replies`),
          h("span", { class: "num" }, formatTokens(model.tokens))
        )
      );
    }
    section.append(list);
    return section;
  };
  const threadsSection = (current, now) => {
    const rows = current.threads.map((thread) => {
      const meta = sumProvider(thread.days, META_PROVIDER, periodStart(period, now));
      const total = sumAll(thread.days, periodStart(period, now));
      return { thread, meta: totalTokens(meta), total: totalTokens(total) };
    }).filter((row) => row.total > 0).sort((a, b) => b.meta - a.meta || b.total - a.total);
    const section = h(
      "section",
      { "aria-labelledby": "muse-threads" },
      h(
        "div",
        { class: "section-head first" },
        h("h2", { id: "muse-threads" }, `Threads \xB7 ${rows.length}`),
        h("span", { class: "muted" }, "sorted by Muse tokens")
      )
    );
    if (rows.length === 0) {
      section.append(
        h(
          "div",
          { class: "empty", "data-testid": "muse-empty" },
          h("p", {}, "No threads in this folder have usage in this period"),
          h("p", { class: "muted" }, "Threads appear here once they get a reply from a model.")
        )
      );
      return section;
    }
    const visible = showAllThreads ? rows : rows.slice(0, VISIBLE_THREADS);
    const list = h("ul", { class: "threads", "aria-label": "Threads" });
    for (const row of visible) {
      const open = expandedThread === row.thread.id;
      const button = h(
        "button",
        {
          class: "row",
          type: "button",
          "aria-expanded": String(open),
          "data-testid": "muse-thread-row",
          "data-thread-title": row.thread.title
        },
        h(
          "span",
          { class: "who" },
          h("span", { class: "title" }, row.thread.title),
          h(
            "span",
            { class: "meta" },
            row.thread.current ? h("span", { class: "here" }, "This thread \xB7 ") : null,
            [row.thread.model, formatRelative(row.thread.lastActiveAt, now)].filter(Boolean).join(" \xB7 ")
          )
        ),
        h("span", { class: "num", title: row.meta.toLocaleString() }, formatTokens(row.meta)),
        h(
          "span",
          { class: "num muted", title: row.total.toLocaleString() },
          formatTokens(row.total)
        )
      );
      button.onclick = () => {
        expandedThread = open ? null : row.thread.id;
        render();
      };
      const item = h("li", {}, button);
      if (open) {
        const providers = providerSplit(row.thread);
        item.append(
          h(
            "div",
            { class: "detail", "data-testid": "muse-thread-detail" },
            h(
              "ul",
              { class: "list" },
              ...providers.map(
                ([provider, counts]) => h(
                  "li",
                  {},
                  h("span", {
                    class: "swatch",
                    style: `background:${provider === META_PROVIDER ? "var(--c-meta)" : "var(--c-other)"}`
                  }),
                  h(
                    "span",
                    { class: "label" },
                    provider === META_PROVIDER ? "Muse (meta)" : provider
                  ),
                  h("span", { class: "num" }, formatTokens(totalTokens(counts)))
                )
              )
            )
          )
        );
      }
      list.append(item);
    }
    section.append(list);
    if (rows.length > VISIBLE_THREADS) {
      const more = h(
        "button",
        { class: "more", type: "button" },
        showAllThreads ? "Show fewer" : `Show ${rows.length - VISIBLE_THREADS} more`
      );
      more.onclick = () => {
        showAllThreads = !showAllThreads;
        render();
      };
      section.append(more);
    }
    return section;
  };
  const providerSplit = (thread) => {
    const since = periodStart(period, Date.now());
    const byProvider = /* @__PURE__ */ new Map();
    for (const day of thread.days) {
      if (since !== null && day.dayStart < since) continue;
      for (const [provider, counts] of Object.entries(day.providers)) {
        const tally = byProvider.get(provider) ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0
        };
        tally.input += counts.input;
        tally.output += counts.output;
        tally.cacheRead += counts.cacheRead;
        tally.cacheWrite += counts.cacheWrite;
        tally.cost += counts.cost;
        byProvider.set(provider, tally);
      }
    }
    return [...byProvider.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));
  };
  const binding = host.services.open({
    services: [MuseUsage],
    assertAccess: () => host.signal.throwIfAborted(),
    onError: (reason) => {
      if (state)
        state = { ...state, error: reason instanceof Error ? reason.message : String(reason) };
      render();
    }
  });
  const service = binding.use(MuseUsage);
  const doRefresh = () => {
    service.refresh({}, BACKGROUND_CONTEXT).catch((reason) => {
      if (state)
        state = { ...state, error: reason instanceof Error ? reason.message : String(reason) };
      render();
    });
  };
  refreshButton.onclick = doRefresh;
  let unsubscribe = () => {
  };
  const clock = setInterval(render, 6e4);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(clock);
    unsubscribe();
    host.signal.removeEventListener("abort", dispose);
    binding.dispose(BACKGROUND_CONTEXT).catch(() => {
    });
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
    doRefresh();
  } catch (reason) {
    dispose();
    throw reason;
  }
  return dispose;
}
export {
  mount
};
