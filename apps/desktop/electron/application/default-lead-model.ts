import type { SessionModelSelection } from "@pi-gui/session-driver";

/** App-global default selection, absent when cleared. */
export type DefaultLeadModel = SessionModelSelection | undefined;

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
 * The model a thread was on right before the Solo -> Lead toggle switched it,
 * plus the lead model the toggle applied. Held in memory per session key so
 * Lead -> Solo can undo the switch.
 */
export interface PreLeadModel {
  readonly previous: SessionModelSelection;
  readonly applied: SessionModelSelection;
}

function sameModel(
  a: SessionModelSelection | undefined,
  b: SessionModelSelection | undefined,
): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.modelId === b.modelId;
}

/**
 * Which model the Solo -> Lead toggle should switch to, if any. The toggle is
 * explicit user intent, so history does not block it: the prompt-cache cost of
 * a mid-conversation switch is the user's call. Already-on-default is a no-op
 * so the toggle never re-pushes the same model; no default means no switch.
 */
export function defaultLeadModelForLeadToggle(options: {
  readonly defaultLeadModel: DefaultLeadModel;
  readonly current?: SessionModelSelection;
}): SessionModelSelection | undefined {
  const def = options.defaultLeadModel;
  if (!def || sameModel(def, options.current)) {
    return undefined;
  }
  return def;
}

/**
 * Which model the Lead -> Solo toggle should restore, if any: the pre-lead
 * model, but only while the thread is still on the lead model the toggle
 * applied. A model the user picked meanwhile, or a lost record (restart),
 * leaves the model alone.
 */
export function preLeadModelForSoloToggle(options: {
  readonly preLead: PreLeadModel | undefined;
  readonly current?: SessionModelSelection;
}): SessionModelSelection | undefined {
  const preLead = options.preLead;
  if (!preLead || !sameModel(preLead.applied, options.current)) {
    return undefined;
  }
  return preLead.previous;
}

/** A runtime model entry, as far as availability needs. */
interface RuntimeModelAvailability {
  readonly providerId: string;
  readonly modelId: string;
  readonly available: boolean;
}

/**
 * Whether a model is selectable: known, available, and allowed by the
 * workspace's enabled patterns (empty means all available). Mirrors the
 * renderer's buildModelOptions filter.
 */
export function isModelAvailableInRuntime(options: {
  readonly models?: readonly RuntimeModelAvailability[] | undefined;
  readonly enabledModelPatterns?: readonly string[] | undefined;
  readonly provider: string;
  readonly modelId: string;
}): boolean {
  const entry = options.models?.find(
    (model) => model.providerId === options.provider && model.modelId === options.modelId,
  );
  if (!entry || !entry.available) {
    return false;
  }
  const patterns = options.enabledModelPatterns ?? [];
  if (patterns.length === 0) {
    return true;
  }
  return patterns.includes(`${options.provider}/${options.modelId}`);
}

/**
 * Which model Lead -> Solo falls back to when there is no pre-lead record:
 * threads born in Lead mode never recorded one, and a restart drops the
 * in-memory map. Only while the thread is still on the default lead model,
 * and only to a workspace Solo default that is different and available.
 * A user-picked model, or a thread that already left the lead default,
 * is left alone.
 */
export function fallbackSoloModelForSoloToggle(options: {
  readonly current?: SessionModelSelection;
  readonly defaultLeadModel: DefaultLeadModel;
  readonly workspaceDefaultModel?: SessionModelSelection | undefined;
  readonly models?: readonly RuntimeModelAvailability[] | undefined;
  readonly enabledModelPatterns?: readonly string[] | undefined;
}): SessionModelSelection | undefined {
  const def = options.defaultLeadModel;
  if (!def || !sameModel(def, options.current)) {
    return undefined;
  }
  const target = options.workspaceDefaultModel;
  if (!target || sameModel(target, options.current)) {
    return undefined;
  }
  if (
    !isModelAvailableInRuntime({
      ...(options.models ? { models: options.models } : {}),
      ...(options.enabledModelPatterns
        ? { enabledModelPatterns: options.enabledModelPatterns }
        : {}),
      provider: target.provider,
      modelId: target.modelId,
    })
  ) {
    return undefined;
  }
  return target;
}

/**
 * The thinking level a thread had right before the Solo -> Lead toggle changed
 * it, plus the effective level pi settled on after the change. Held in memory
 * per session key, like {@link PreLeadModel}.
 */
export interface PreLeadThinking {
  readonly previous: string;
  readonly applied: string;
}

/**
 * Which thinking level a new thread starts with. An explicit pick wins; a
 * lead-mode thread otherwise starts at the default lead reasoning, and a
 * solo thread keeps the workspace default.
 */
export function resolveInitialThinkingForLeadThread(options: {
  readonly explicit?: string;
  readonly orchestratorMode?: boolean;
  readonly defaultLeadThinkingLevel: string;
  readonly workspaceInitialThinkingLevel?: string;
}): string | undefined {
  if (options.explicit) {
    return options.explicit;
  }
  return options.orchestratorMode
    ? options.defaultLeadThinkingLevel
    : options.workspaceInitialThinkingLevel;
}

/** Thinking level the Solo -> Lead toggle applies; already-there is a no-op. */
export function defaultLeadThinkingForLeadToggle(options: {
  readonly defaultLeadThinkingLevel: string;
  readonly current?: string;
}): string | undefined {
  return options.defaultLeadThinkingLevel === options.current
    ? undefined
    : options.defaultLeadThinkingLevel;
}

/**
 * Which thinking level Lead -> Solo restores: the pre-lead level, only while
 * the thread is still on the level the toggle applied.
 */
export function preLeadThinkingForSoloToggle(options: {
  readonly preLead: PreLeadThinking | undefined;
  readonly current?: string;
}): string | undefined {
  const preLead = options.preLead;
  if (!preLead || options.current === undefined || preLead.applied !== options.current) {
    return undefined;
  }
  return preLead.previous === preLead.applied ? undefined : preLead.previous;
}

/**
 * Which thinking level Lead -> Solo falls back to when there is no pre-lead
 * record: the workspace Solo default, but only while the thread is still on
 * the default lead level. A level the user picked meanwhile is left alone.
 */
export function fallbackSoloThinkingForSoloToggle(options: {
  readonly current?: string | undefined;
  readonly defaultLeadThinkingLevel?: string | undefined;
  readonly workspaceDefaultThinkingLevel?: string | undefined;
}): string | undefined {
  const current = options.current;
  const leadDefault = options.defaultLeadThinkingLevel;
  const target = options.workspaceDefaultThinkingLevel;
  if (current === undefined || leadDefault === undefined || current !== leadDefault) {
    return undefined;
  }
  if (target === undefined || target === current) {
    return undefined;
  }
  return target;
}
