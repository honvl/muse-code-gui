import type { SessionModelSelection } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/desktop-state";

/** App-global default selection, absent when cleared. */
export type DefaultLeadModel = SessionModelSelection | undefined;

/** Exact match, treating absent/cleared as equal. */
export function isDefaultLeadModelEqual(
  current: SessionModelSelection | undefined,
  next: SessionModelSelection | null | undefined,
): boolean {
  const normalizedNext = next ?? undefined;
  if (current === undefined || normalizedNext === undefined) {
    return current === normalizedNext;
  }
  return current.provider === normalizedNext.provider && current.modelId === normalizedNext.modelId;
}

/**
 * True when the thread already has conversation history that a model switch
 * would invalidate. Only message/tool/custom/summary rows count: local
 * activity rows, pins and cards never ran through the model and must not
 * block a pre-run switch.
 */
export function hasThreadHistory(transcript: readonly TranscriptMessage[]): boolean {
  return transcript.some(
    (item) =>
      item.kind === "message" ||
      item.kind === "tool" ||
      item.kind === "custom" ||
      item.kind === "summary",
  );
}

/**
 * Which model a new thread should start on. Explicit per-thread input always
 * wins; the app-global default only applies to lead-mode threads and otherwise
 * the workspace default (whatever the caller computed) is kept.
 */
export function resolveInitialModelForLeadThread(options: {
  readonly explicitProvider?: string;
  readonly explicitModelId?: string;
  readonly orchestratorMode?: boolean;
  readonly defaultLeadModel: DefaultLeadModel;
  readonly workspaceInitialModel?: SessionModelSelection;
}): SessionModelSelection | undefined {
  if (options.explicitProvider && options.explicitModelId) {
    return { provider: options.explicitProvider, modelId: options.explicitModelId };
  }
  if (options.orchestratorMode && options.defaultLeadModel) {
    return options.defaultLeadModel;
  }
  return options.workspaceInitialModel;
}

/**
 * Which model a lead-mode toggle should switch to, if any. Only an empty
 * thread (no conversation history) moves: mid-conversation switches destroy
 * prompt cache and surprise the user. Already-on-default is a no-op so the
 * toggle never re-pushes the same model.
 */
export function defaultLeadModelForLeadToggle(options: {
  readonly enabled: boolean;
  readonly defaultLeadModel: DefaultLeadModel;
  readonly transcript: readonly TranscriptMessage[];
  readonly currentProvider?: string;
  readonly currentModelId?: string;
}): SessionModelSelection | undefined {
  if (!options.enabled) {
    return undefined;
  }
  const def = options.defaultLeadModel;
  if (!def) {
    return undefined;
  }
  if (hasThreadHistory(options.transcript)) {
    return undefined;
  }
  if (options.currentProvider === def.provider && options.currentModelId === def.modelId) {
    return undefined;
  }
  return def;
}
