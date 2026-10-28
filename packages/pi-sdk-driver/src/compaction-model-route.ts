import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SessionModelSelection, SessionRef } from "@pi-gui/session-driver";

/**
 * Mid-session model routing at compaction time (exploratory, host opt-in).
 *
 * Compaction drops the provider's prompt cache anyway, so switching a session's
 * model there costs no extra cache miss. This hidden extension only asks the
 * host's router what the session should run on next and applies it through
 * pi's own `setModel`/`setThinkingLevel`. It never cancels or replaces the
 * compaction: pi still summarizes with the model that filled the context, and
 * the next turn runs on the routed model. Routing policy (which sessions,
 * when, to what) stays with the host.
 */

export interface CompactionModelRouteRequest {
  readonly sessionRef: SessionRef;
  /** What triggered the compaction: manual /compact, the context threshold, or overflow recovery. */
  readonly reason: "manual" | "threshold" | "overflow";
  /** True when pi retries the aborted turn after this compaction (overflow recovery). */
  readonly willRetry: boolean;
  readonly tokensBefore: number;
  readonly model?: SessionModelSelection;
  readonly thinkingLevel?: string;
}

export interface CompactionModelRoute {
  readonly model?: SessionModelSelection;
  readonly thinkingLevel?: string;
}

/** Host policy: a route to apply after this compaction, or undefined to keep the session as is. */
export type CompactionModelRouter = (
  request: CompactionModelRouteRequest,
) => CompactionModelRoute | undefined | Promise<CompactionModelRoute | undefined>;

export interface CompactionModelRouteOptions {
  readonly workspaceId: string;
  readonly router: CompactionModelRouter;
  /** Called after pi accepted a route, so the host can refresh its view of the session config. */
  readonly onRouted?: (sessionRef: SessionRef, route: CompactionModelRoute) => void;
}

export function createCompactionModelRouteExtension(
  options: CompactionModelRouteOptions,
): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", async (event, ctx) => {
      // Routing is advisory: a router or lookup failure must never fail the compaction.
      try {
        const sessionRef: SessionRef = {
          workspaceId: options.workspaceId,
          sessionId: ctx.sessionManager.getSessionId(),
        };
        const current = ctx.model;
        const route = await options.router({
          sessionRef,
          reason: event.reason,
          willRetry: event.willRetry,
          tokensBefore: event.preparation.tokensBefore,
          ...(current ? { model: { provider: current.provider, modelId: current.id } } : {}),
          thinkingLevel: pi.getThinkingLevel(),
        });
        if (!route || event.signal.aborted) return undefined;

        let applied = false;
        if (
          route.model &&
          (route.model.provider !== current?.provider || route.model.modelId !== current?.id)
        ) {
          const next = ctx.modelRegistry.find(route.model.provider, route.model.modelId);
          if (!next || !(await pi.setModel(next))) {
            console.warn(
              `[pi-sdk-driver] compaction route skipped: ${route.model.provider}:${route.model.modelId} is unavailable`,
            );
            return undefined;
          }
          applied = true;
        }
        if (route.thinkingLevel) {
          // pi clamps the level to what the (possibly new) model supports.
          pi.setThinkingLevel(
            route.thinkingLevel as Parameters<ExtensionAPI["setThinkingLevel"]>[0],
          );
          applied = true;
        }
        if (applied) options.onRouted?.(sessionRef, route);
      } catch (error) {
        console.warn("[pi-sdk-driver] compaction route failed:", error);
      }
      return undefined;
    });
  };
}
