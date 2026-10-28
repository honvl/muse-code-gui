import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";

/** Every reasoning effort pi knows, lowest to highest. */
export const THINKING_LEVEL_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * The level pi actually applies when `level` is requested on a model that
 * supports `supported`. Mirrors pi-ai's `clampThinkingLevel`: the requested
 * level if supported, else the nearest supported level above it, else below.
 * Unknown support (no model record) leaves the level as requested.
 */
export function effectiveThinkingLevel(
  level: string,
  supported: readonly string[] | undefined,
): string {
  if (!supported || supported.length === 0 || supported.includes(level)) {
    return level;
  }
  const order: readonly string[] = THINKING_LEVEL_ORDER;
  const requested = order.indexOf(level);
  if (requested === -1) {
    return supported[0] ?? level;
  }
  const above = order.slice(requested + 1).find((candidate) => supported.includes(candidate));
  const below = order
    .slice(0, requested)
    .reverse()
    .find((candidate) => supported.includes(candidate));
  return above ?? below ?? level;
}

/** Levels a model accepts, from the runtime's model list; undefined when unknown. */
export function modelThinkingLevels(
  runtime: Pick<RuntimeSnapshot, "models"> | undefined,
  provider: string | undefined,
  modelId: string | undefined,
): readonly string[] | undefined {
  if (!provider || !modelId) {
    return undefined;
  }
  return runtime?.models.find((model) => model.providerId === provider && model.modelId === modelId)
    ?.thinkingLevels;
}
