import type { SessionModelSelection } from "@pi-gui/session-driver";

/** App-global default selection for scout children, absent when cleared. */
export type DefaultScoutModel = SessionModelSelection | undefined;

/** Exact match, treating absent/cleared as equal. */
export function isDefaultScoutModelEqual(
  current: SessionModelSelection | undefined,
  next: SessionModelSelection | null | undefined,
): boolean {
  const normalizedNext = next ?? undefined;
  if (current === undefined || normalizedNext === undefined) {
    return current === normalizedNext;
  }
  return current.provider === normalizedNext.provider && current.modelId === normalizedNext.modelId;
}
