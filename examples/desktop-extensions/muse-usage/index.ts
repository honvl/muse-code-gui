import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { collectMuseUsage, reduceThread, type CurrentThread } from "./collect.ts";
import { MuseUsage, type MuseUsageState } from "./contract.ts";
import { formatTokens, summarizePeriod, type Period } from "./model.ts";
import { emptyQuota, fetchQuota } from "./quota.ts";

const initialState = (): MuseUsageState => ({
  status: "idle",
  error: null,
  refreshedAt: null,
  folderName: "",
  threads: [],
  models: [],
  quota: emptyQuota(),
  scanned: 0,
  unreadable: 0,
  capped: 0,
});

export default function museUsageExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | null = null;
  let state = initialState();
  const listeners = new Set<(next: MuseUsageState) => void>();
  let running: Promise<void> | null = null;
  let again = false;

  const publish = (next: MuseUsageState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const currentThread = (ctx: ExtensionContext): CurrentThread => ({
    id: ctx.sessionManager.getSessionId(),
    entries: ctx.sessionManager.getEntries(),
    name: ctx.sessionManager.getSessionName(),
  });

  // Short names like the reference ("Wonder"): drop the vendor prefix and "(latest)".
  const modelName = (ctx: ExtensionContext) => (provider: string, modelId: string) =>
    ctx.modelRegistry
      .find(provider, modelId)
      ?.name.replace(/^Muse\s+/i, "")
      .replace(/\s*\(latest\)$/, "");
  // Mirrors pi-gui's footer: OAuth to a subscription provider has no per-token cost.
  const isSubscription = (ctx: ExtensionContext) => (provider: string, modelId: string) => {
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) return false;
    return ctx.modelRegistry.getProvider(provider)?.auth?.oauth?.isSubscription === true;
  };

  const fail = (error: unknown) =>
    publish({
      ...state,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });

  const collectOnce = async () => {
    const ctx = context;
    if (!ctx) return;
    publish({ ...state, status: "loading", error: null });
    try {
      const collected = await collectMuseUsage({
        cwd: ctx.cwd,
        sessionDir: ctx.sessionManager.getSessionDir(),
        current: currentThread(ctx),
        modelName: modelName(ctx),
        isSubscription: isSubscription(ctx),
      });
      // Quota is best-effort: a failed `muse usage` call never blocks usage data.
      const quota = await fetchQuota();
      if (ctx === context) {
        publish({
          status: "ready",
          error: null,
          refreshedAt: collected.refreshedAt,
          folderName: collected.folderName,
          threads: collected.threads,
          models: collected.models,
          quota,
          scanned: collected.scanned,
          unreadable: collected.unreadable,
          capped: collected.capped,
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

  /** After a turn only this thread changed; recompute it from live entries, not the folder. */
  const refreshCurrent = () => {
    const ctx = context;
    if (!ctx || state.status !== "ready") return;
    const current = currentThread(ctx);
    const existing = state.threads.find((thread) => thread.id === current.id);
    const thread = reduceThread({
      id: current.id,
      title: existing?.title ?? current.name ?? "This thread",
      lastActiveAt: Date.now(),
      entries: current.entries as unknown[],
      current: true,
      modelName: modelName(ctx),
      isSubscription: isSubscription(ctx),
    });
    publish({
      ...state,
      threads: existing
        ? state.threads.map((candidate) => (candidate.id === current.id ? thread : candidate))
        : [thread, ...state.threads],
    });
  };

  /** Only recompute while a view is connected; opening one always refreshes. */
  const refreshInBackground = () => {
    if (listeners.size > 0) refresh().catch(fail);
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    state = initialState();
    refreshInBackground();
  });
  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
    refreshInBackground();
  });
  pi.on("turn_end", () => {
    if (listeners.size > 0) refreshCurrent();
  });
  pi.on("agent_end", refreshInBackground);

  pi.on("session_shutdown", () => {
    context = null;
  });

  pi.registerCommand("muse-usage", {
    description: "Summarize Muse (meta provider) token usage and allowance",
    async handler(_args, ctx: ExtensionContext) {
      context = ctx;
      await refresh();
      const summary = summarizePeriod(state.threads, "7d" as Period, Date.now());
      const metaModels = state.models.filter((model) => model.provider === "meta").slice(0, 4);
      const quota = state.quota;
      const quotaLine =
        quota.window || quota.weekly
          ? [
              `Allowance · ${quota.tier ?? "Muse"}`,
              quota.window ? `Window ${Math.round(quota.window.usedPercent)}%` : "",
              quota.weekly ? `Weekly ${Math.round(quota.weekly.usedPercent)}%` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          : `Allowance: ${quota.error ?? "unavailable"}`;
      const lines = [
        `Muse usage · ${state.folderName}`,
        quotaLine,
        `7d meta ${formatTokens(summary.metaTokens)} across ${summary.threadCount} threads · Cache hit ${summary.metaCacheHit === null ? "—" : `${Math.round(summary.metaCacheHit * 100)}%`} · ${summary.subscription ? "Subscription" : "metered"}`,
        `  in ${formatTokens(summary.meta.input)} · out ${formatTokens(summary.meta.output)} · cache read ${formatTokens(summary.meta.cacheRead)} · cache write ${formatTokens(summary.meta.cacheWrite)}`,
        ...metaModels.map(
          (model) => `  ${model.displayName ?? model.model}: ${formatTokens(model.tokens)}`,
        ),
        "Subagents live in the companion Subagents view (`agent`-tool activity).",
      ];
      ctx.ui.notify(lines.join("\n"), state.status === "error" ? "error" : "info");
    },
  });

  registerDesktopView(pi, {
    id: "muse-usage",
    title: "Muse Usage",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "pi-gui.example.muse-usage.backend",
        setup(env) {
          const replicated = env.replicatedState(state);
          const listener = (next: MuseUsageState) => replicated.replace(BACKGROUND_CONTEXT, next);
          listeners.add(listener);
          env.own(() => {
            listeners.delete(listener);
          });
          env.provide(MuseUsage, {
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
