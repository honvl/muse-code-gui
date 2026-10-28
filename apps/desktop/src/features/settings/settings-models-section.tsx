import { useEffect, useState, type ReactNode } from "react";
import type {
  RuntimeModelRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { SessionModelSelection } from "@pi-gui/session-driver/types";
import {
  DEFAULT_LEAD_THINKING_LEVEL,
  DEFAULT_SIDEKICK_THINKING_LEVEL,
  type DesktopAppState,
  type ThinkingLevel,
} from "../../../contracts/desktop-state";
import { THINKING_LEVEL_ORDER } from "../../../contracts/thinking-levels";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { SearchIcon } from "../../ui/icons";
import { SettingsSelect, SettingsSwitch } from "./settings-controls";
import {
  filterModels,
  labelForThinking,
  SettingsGroup,
  SettingsRow,
  THINKING_LEVELS,
} from "./settings-utils";

/**
 * Value of the "Thread's own model" entry: no override, so new lead threads
 * start on their own model. Never collides with a real model value, which is
 * always `providerId:modelId`.
 */
export const DEFAULT_LEAD_MODEL_THREAD_VALUE = "__thread-model";

export const DEFAULT_LEAD_MODEL_TITLE = "Default lead model";

export const DEFAULT_LEAD_MODEL_DESCRIPTION =
  "New lead threads start on this model, and switching a thread to Lead applies it. Switching back to Solo restores the thread's previous model.";

export interface LeadModelOption {
  readonly value: string;
  readonly label: string;
}

function modelOption(model: RuntimeModelRecord): LeadModelOption {
  return {
    value: `${model.providerId}:${model.modelId}`,
    label: `${model.providerName} · ${model.label}`,
  };
}

/**
 * Options for a default-model picker: the same enabled-model list the
 * default-model control offers, plus a leading thread entry that clears the setting.
 */
function defaultModelOptions(
  threadValue: string,
  threadLabel: string,
  enabledModels: readonly RuntimeModelRecord[],
): readonly LeadModelOption[] {
  return [{ value: threadValue, label: threadLabel }, ...enabledModels.map(modelOption)];
}

/** Picker value reflecting the stored setting; absent means the thread entry. */
function defaultModelSelectValue(
  threadValue: string,
  selection: SessionModelSelection | undefined,
): string {
  if (!selection) {
    return threadValue;
  }
  return `${selection.provider}:${selection.modelId}`;
}

/**
 * Parse a picker value back into a bridge selection. The thread entry resolves
 * to null, which clears the app-global default.
 */
function resolveDefaultModelSelection(
  threadValue: string,
  value: string,
): SessionModelSelection | null {
  if (value === threadValue) {
    return null;
  }
  const [provider = "", ...modelParts] = value.split(":");
  return { provider, modelId: modelParts.join(":") };
}

/**
 * Options for the default-lead-model picker: the same enabled-model list the
 * default-model control offers, plus a leading "Thread's own model" entry
 * that clears the setting.
 */
export function leadModelOptions(
  enabledModels: readonly RuntimeModelRecord[],
): readonly LeadModelOption[] {
  return defaultModelOptions(DEFAULT_LEAD_MODEL_THREAD_VALUE, "Thread's own model", enabledModels);
}

/** Picker value reflecting the stored setting; absent means "Thread's own model". */
export function leadModelSelectValue(selection: SessionModelSelection | undefined): string {
  return defaultModelSelectValue(DEFAULT_LEAD_MODEL_THREAD_VALUE, selection);
}

/**
 * Parse a picker value back into a bridge selection. The thread entry resolves
 * to null, which clears the app-global default lead model.
 */
export function resolveLeadModelSelection(value: string): SessionModelSelection | null {
  return resolveDefaultModelSelection(DEFAULT_LEAD_MODEL_THREAD_VALUE, value);
}

/**
 * Value of the "Thread's sidekick model" entry: no override, so read-only
 * scout children run on the thread's sidekick model. Never collides with a
 * real model value, which is always `providerId:modelId`.
 */
export const DEFAULT_SCOUT_MODEL_THREAD_VALUE = "__thread-sidekick-model";

export const DEFAULT_SCOUT_MODEL_TITLE = "Default scout model";

export const DEFAULT_SCOUT_MODEL_DESCRIPTION =
  "Read-only scout children run on this model. Workers keep using the thread's sidekick model.";

/**
 * Options for the default-scout-model picker: the same enabled-model list the
 * default-model control offers, plus a leading "Thread's sidekick model"
 * entry that clears the setting.
 */
export function scoutModelOptions(
  enabledModels: readonly RuntimeModelRecord[],
): readonly LeadModelOption[] {
  return defaultModelOptions(
    DEFAULT_SCOUT_MODEL_THREAD_VALUE,
    "Thread's sidekick model",
    enabledModels,
  );
}

/** Picker value reflecting the stored setting; absent means "Thread's sidekick model". */
export function scoutModelSelectValue(selection: SessionModelSelection | undefined): string {
  return defaultModelSelectValue(DEFAULT_SCOUT_MODEL_THREAD_VALUE, selection);
}

/**
 * Parse a picker value back into a bridge selection. The thread entry resolves
 * to null, which clears the app-global default scout model.
 */
export function resolveScoutModelSelection(value: string): SessionModelSelection | null {
  return resolveDefaultModelSelection(DEFAULT_SCOUT_MODEL_THREAD_VALUE, value);
}

/**
 * Commit a picker value through the bridge. The component reflects the returned
 * state; exported so unit tests can assert the selection mapping without a DOM.
 */
function commitDefaultModelSelection(
  value: string,
  threadValue: string,
  setDefaultModel: (selection: SessionModelSelection | null) => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return setDefaultModel(resolveDefaultModelSelection(threadValue, value));
}

/**
 * Commit a picker value through the bridge. The component reflects the returned
 * state; exported so unit tests can assert the selection mapping without a DOM.
 */
export function commitScoutModelSelection(
  value: string,
  setDefaultScoutModel: (selection: SessionModelSelection | null) => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return commitDefaultModelSelection(value, DEFAULT_SCOUT_MODEL_THREAD_VALUE, setDefaultScoutModel);
}

/**
 * Commit a picker value through the bridge. The component reflects the returned
 * state; exported so unit tests can assert the selection mapping without a DOM.
 */
export function commitLeadModelSelection(
  value: string,
  setDefaultLeadModel: (selection: SessionModelSelection | null) => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return commitDefaultModelSelection(value, DEFAULT_LEAD_MODEL_THREAD_VALUE, setDefaultLeadModel);
}

/**
 * Value of the "Sidekick's reasoning" entry: no override, so scout children
 * start with the thread's sidekick reasoning. Never collides with a level.
 */
export const DEFAULT_SCOUT_THINKING_SIDEKICK_VALUE = "__sidekick-thinking";

export const DEFAULT_SCOUT_THINKING_TITLE = "Scout reasoning";

export const DEFAULT_SCOUT_THINKING_DESCRIPTION =
  "Reasoning effort read-only scout children start with. Set the sidekick's next to its model in a Lead thread.";

export function scoutThinkingOptions(): readonly LeadModelOption[] {
  return [
    { value: DEFAULT_SCOUT_THINKING_SIDEKICK_VALUE, label: "Sidekick's reasoning" },
    ...ALL_THINKING_OPTIONS,
  ];
}

/** Picker value reflecting the stored setting; absent means "Sidekick's reasoning". */
export function scoutThinkingSelectValue(level: ThinkingLevel | undefined): string {
  return level ?? DEFAULT_SCOUT_THINKING_SIDEKICK_VALUE;
}

/** The sidekick entry resolves to null, which clears the app-global scout reasoning. */
export function resolveScoutThinkingLevel(value: string): ThinkingLevel | null {
  return value === DEFAULT_SCOUT_THINKING_SIDEKICK_VALUE ? null : (value as ThinkingLevel);
}

export const DEFAULT_LEAD_THINKING_TITLE = "Default lead reasoning";

export const DEFAULT_LEAD_THINKING_DESCRIPTION =
  "Lead threads start at this reasoning effort, and switching a thread to Lead applies it. A model without this level uses its nearest one.";

export const DEFAULT_SIDEKICK_THINKING_TITLE = "Default sidekick reasoning";

export const DEFAULT_SIDEKICK_THINKING_DESCRIPTION =
  "Child threads start at this reasoning effort unless a Lead thread sets its own next to the sidekick model. A model without this level uses its nearest one.";

/**
 * Every level for an app-global reasoning default. Unlike the composer, no
 * single model is chosen here, so nothing is filtered; pi clamps per model.
 */
export function allThinkingOptions(): readonly LeadModelOption[] {
  return ALL_THINKING_OPTIONS;
}

/** Bridge wiring for one app-global reasoning row; module-level so the loader effect fires once. */
interface ThinkingRowBridge {
  readonly committed: (state: DesktopAppState) => ThinkingLevel | undefined;
  readonly setDefault: (api: PiDesktopApi, level: ThinkingLevel | null) => Promise<DesktopAppState>;
  readonly failureLabel: string;
}

const SCOUT_THINKING_ROW: ThinkingRowBridge = {
  committed: (state) => state.defaultScoutThinkingLevel,
  setDefault: (api, level) => api.setDefaultScoutThinkingLevel(level),
  failureLabel: "setDefaultScoutThinkingLevel",
};

const LEAD_THINKING_ROW: ThinkingRowBridge = {
  committed: (state) => state.defaultLeadThinkingLevel,
  setDefault: (api, level) => api.setDefaultLeadThinkingLevel(level),
  failureLabel: "setDefaultLeadThinkingLevel",
};

const SIDEKICK_THINKING_ROW: ThinkingRowBridge = {
  committed: (state) => state.defaultSidekickThinkingLevel,
  setDefault: (api, level) => api.setDefaultSidekickThinkingLevel(level),
  failureLabel: "setDefaultSidekickThinkingLevel",
};

/** Same bridge pattern as the default-model rows: load once, then reflect each result. */
function useAppThinkingLevel({
  seed,
  committed,
  setDefault,
  failureLabel,
}: ThinkingRowBridge & { readonly seed: ThinkingLevel | undefined }): {
  readonly level: ThinkingLevel | undefined;
  readonly onChange: (level: ThinkingLevel | null) => void;
} {
  const [level, setLevel] = useState<ThinkingLevel | undefined>(seed);
  useEffect(() => {
    if (seed !== undefined) {
      return;
    }
    const api = window.piApp;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api
      .getState()
      .then((state) => {
        if (!cancelled) {
          setLevel(committed(state));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("[renderer] getState failed", error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [seed, committed]);

  const onChange = (next: ThinkingLevel | null) => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    void setDefault(api, next)
      .then((state) => {
        setLevel(committed(state));
      })
      .catch((error: unknown) => {
        console.error(`[renderer] ${failureLabel} failed`, error);
      });
  };
  return { level, onChange };
}

/** Bridge wiring for one default-model picker row; module-level so the loader effect fires once. */
interface DefaultModelRowBridge {
  readonly threadValue: string;
  readonly committed: (state: DesktopAppState) => SessionModelSelection | undefined;
  readonly setDefault: (
    api: PiDesktopApi,
    selection: SessionModelSelection | null,
  ) => Promise<DesktopAppState>;
  readonly failureLabel: string;
}

const LEAD_MODEL_ROW: DefaultModelRowBridge = {
  threadValue: DEFAULT_LEAD_MODEL_THREAD_VALUE,
  committed: (state) => state.defaultLeadModel,
  setDefault: (api, selection) => api.setDefaultLeadModel(selection),
  failureLabel: "setDefaultLeadModel",
};

const SCOUT_MODEL_ROW: DefaultModelRowBridge = {
  threadValue: DEFAULT_SCOUT_MODEL_THREAD_VALUE,
  committed: (state) => state.defaultScoutModel,
  setDefault: (api, selection) => api.setDefaultScoutModel(selection),
  failureLabel: "setDefaultScoutModel",
};

/**
 * State backing one default-model picker row. The override is app-global and
 * no parent threads the value through, so the row loads the live value from
 * the bridge on mount and thereafter reflects each bridge result. Mirrors
 * handleSetModelSettingsScopeMode in secondary-surfaces: fire the app-global
 * bridge call and log failures, then reflect the returned state.
 */
function useDefaultModelSelection({
  seed,
  threadValue,
  committed,
  setDefault,
  failureLabel,
}: DefaultModelRowBridge & {
  readonly seed: SessionModelSelection | undefined;
}): {
  readonly selection: SessionModelSelection | undefined;
  readonly onChange: (value: string) => void;
} {
  const [selection, setSelection] = useState<SessionModelSelection | undefined>(seed);
  useEffect(() => {
    if (seed !== undefined) {
      return;
    }
    const api = window.piApp;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api
      .getState()
      .then((state) => {
        if (!cancelled) {
          setSelection(committed(state));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("[renderer] getState failed", error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [seed, committed]);

  const onChange = (value: string) => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    void commitDefaultModelSelection(value, threadValue, (next) => setDefault(api, next))
      .then((state) => {
        setSelection(committed(state));
      })
      .catch((error: unknown) => {
        console.error(`[renderer] ${failureLabel} failed`, error);
      });
  };
  return { selection, onChange };
}

interface SettingsModelsSectionProps {
  readonly runtime?: RuntimeSnapshot;
  /**
   * Seed for the app-global default lead model. No parent passes it yet, so the
   * row loads the live value from the bridge on mount and thereafter reflects
   * each bridge result.
   */
  readonly defaultLeadModel?: SessionModelSelection;
  /**
   * Seed for the app-global default scout model. No parent passes it yet, so
   * the row loads the live value from the bridge on mount and thereafter
   * reflects each bridge result.
   */
  readonly defaultScoutModel?: SessionModelSelection;
  /** Seed for the app-global scout reasoning; loaded from the bridge like the scout model. */
  readonly defaultScoutThinkingLevel?: ThinkingLevel;
  /** Seeds for the app-global lead and sidekick reasoning; absent means the built-in default. */
  readonly defaultLeadThinkingLevel?: ThinkingLevel;
  readonly defaultSidekickThinkingLevel?: ThinkingLevel;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
  readonly onSetThinkingLevel: (
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ) => void;
  readonly onSetScopedModelPatterns: (patterns: readonly string[]) => void;
  readonly onOpenProviders: () => void;
}

const THINKING_OPTIONS = THINKING_LEVELS.map((level) => ({
  value: level,
  label: labelForThinking(level),
}));

const ALL_THINKING_OPTIONS = THINKING_LEVEL_ORDER.map((level) => ({
  value: level,
  label: labelForThinking(level),
}));

function modelPattern(model: RuntimeModelRecord): string {
  return `${model.providerId}/${model.modelId}`;
}

/** Cursor's Models page: defaults on top, then one searchable list with a switch per model. */
export function SettingsModelsSection({
  runtime,
  defaultLeadModel,
  defaultScoutModel,
  defaultScoutThinkingLevel,
  defaultLeadThinkingLevel,
  defaultSidekickThinkingLevel,
  onSetDefaultModel,
  onSetThinkingLevel,
  onSetScopedModelPatterns,
  onOpenProviders,
}: SettingsModelsSectionProps) {
  const [query, setQuery] = useState("");
  const [showUnconnected, setShowUnconnected] = useState(false);

  const models = runtime?.models ?? [];
  const availableModels = models.filter((model) => model.available);
  const unconnectedModels = models.filter((model) => !model.available);

  // No saved patterns means pi enables every available model.
  const savedPatterns = runtime?.settings.enabledModelPatterns ?? [];
  const activePatterns =
    savedPatterns.length === 0 ? availableModels.map(modelPattern) : savedPatterns;
  const activeSet = new Set(activePatterns);
  const enabledModels = availableModels.filter((model) => activeSet.has(modelPattern(model)));

  const defaultProvider = runtime?.settings.defaultProvider;
  const defaultModelId = runtime?.settings.defaultModelId;
  const defaultValue =
    defaultProvider && defaultModelId ? `${defaultProvider}:${defaultModelId}` : undefined;
  const defaultIsEnabled = enabledModels.some(
    (model) => model.providerId === defaultProvider && model.modelId === defaultModelId,
  );

  // App-global overrides for new threads; absent means the row's thread entry.
  // Loaded from the bridge because no parent threads these values through yet.
  const leadRow = useDefaultModelSelection({ seed: defaultLeadModel, ...LEAD_MODEL_ROW });
  const scoutRow = useDefaultModelSelection({ seed: defaultScoutModel, ...SCOUT_MODEL_ROW });
  const scoutThinking = useAppThinkingLevel({
    seed: defaultScoutThinkingLevel,
    ...SCOUT_THINKING_ROW,
  });
  const leadThinking = useAppThinkingLevel({
    seed: defaultLeadThinkingLevel,
    ...LEAD_THINKING_ROW,
  });
  const sidekickThinking = useAppThinkingLevel({
    seed: defaultSidekickThinkingLevel,
    ...SIDEKICK_THINKING_ROW,
  });

  const searching = query.trim().length > 0;
  const visibleAvailable = filterModels(availableModels, query);
  const visibleUnconnected = filterModels(unconnectedModels, query);

  const setEnabled = (pattern: string, enabled: boolean) => {
    const next = enabled
      ? [...activePatterns, pattern]
      : activePatterns.filter((entry) => entry !== pattern);
    if (next.length > 0) onSetScopedModelPatterns(next);
  };

  return (
    <>
      <SettingsGroup>
        <SettingsRow title="Default model" description="Used for new threads.">
          <SettingsSelect
            label="Default model"
            options={enabledModels.map(modelOption)}
            value={defaultIsEnabled ? defaultValue : undefined}
            onChange={(value) => {
              const [provider = "", ...modelParts] = value.split(":");
              onSetDefaultModel(provider, modelParts.join(":"));
            }}
          />
        </SettingsRow>
        <SettingsRow title={DEFAULT_LEAD_MODEL_TITLE} description={DEFAULT_LEAD_MODEL_DESCRIPTION}>
          <SettingsSelect
            label={DEFAULT_LEAD_MODEL_TITLE}
            options={leadModelOptions(enabledModels)}
            value={leadModelSelectValue(leadRow.selection)}
            onChange={leadRow.onChange}
          />
        </SettingsRow>
        <SettingsRow
          title={DEFAULT_LEAD_THINKING_TITLE}
          description={DEFAULT_LEAD_THINKING_DESCRIPTION}
        >
          <SettingsSelect
            label={DEFAULT_LEAD_THINKING_TITLE}
            options={allThinkingOptions()}
            value={leadThinking.level ?? DEFAULT_LEAD_THINKING_LEVEL}
            onChange={(value) => leadThinking.onChange(value as ThinkingLevel)}
          />
        </SettingsRow>
        <SettingsRow
          title={DEFAULT_SIDEKICK_THINKING_TITLE}
          description={DEFAULT_SIDEKICK_THINKING_DESCRIPTION}
        >
          <SettingsSelect
            label={DEFAULT_SIDEKICK_THINKING_TITLE}
            options={allThinkingOptions()}
            value={sidekickThinking.level ?? DEFAULT_SIDEKICK_THINKING_LEVEL}
            onChange={(value) => sidekickThinking.onChange(value as ThinkingLevel)}
          />
        </SettingsRow>
        <SettingsRow
          title={DEFAULT_SCOUT_MODEL_TITLE}
          description={DEFAULT_SCOUT_MODEL_DESCRIPTION}
        >
          <SettingsSelect
            label={DEFAULT_SCOUT_MODEL_TITLE}
            options={scoutModelOptions(enabledModels)}
            value={scoutModelSelectValue(scoutRow.selection)}
            onChange={scoutRow.onChange}
          />
        </SettingsRow>
        <SettingsRow
          title={DEFAULT_SCOUT_THINKING_TITLE}
          description={DEFAULT_SCOUT_THINKING_DESCRIPTION}
        >
          <SettingsSelect
            label={DEFAULT_SCOUT_THINKING_TITLE}
            options={scoutThinkingOptions()}
            value={scoutThinkingSelectValue(scoutThinking.level)}
            onChange={(value) => scoutThinking.onChange(resolveScoutThinkingLevel(value))}
          />
        </SettingsRow>
        <SettingsRow title="Reasoning" description="Default reasoning effort for new threads.">
          <SettingsSelect
            label="Reasoning"
            options={THINKING_OPTIONS}
            value={runtime?.settings.defaultThinkingLevel ?? undefined}
            onChange={onSetThinkingLevel}
          />
        </SettingsRow>
        {defaultValue && !defaultIsEnabled ? (
          <div className="settings-row">
            <span className="settings-warning">
              Your default model ({defaultProvider}/{defaultModelId}) is turned off or its provider
              is not connected. Choose a new default.
            </span>
          </div>
        ) : null}
      </SettingsGroup>

      <section className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">
            Enabled models{" "}
            <span className="resource-list__count">
              {enabledModels.length} of {availableModels.length}
            </span>
          </h3>
          <label className="resource-search">
            <SearchIcon />
            <input
              aria-label="Search models"
              placeholder="Search models"
              spellCheck={false}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>
        <p className="settings-section__description">
          Only enabled models appear in model pickers.
        </p>
        <div className="settings-group" data-testid="settings-model-list">
          {visibleAvailable.length === 0 ? (
            <div className="settings-row">
              <span className="settings-row__description">
                {availableModels.length === 0
                  ? "No connected models available yet. Connect a provider to add models."
                  : `No connected models match “${query.trim()}”.`}
              </span>
            </div>
          ) : (
            visibleAvailable.map((model) => {
              const pattern = modelPattern(model);
              const enabled = activeSet.has(pattern);
              return (
                <ModelRow
                  isDefault={
                    model.providerId === defaultProvider && model.modelId === defaultModelId
                  }
                  key={pattern}
                  model={model}
                >
                  <SettingsSwitch
                    checked={enabled}
                    disabled={enabled && activePatterns.length <= 1}
                    label={`Enable ${pattern}`}
                    onChange={(next) => setEnabled(pattern, next)}
                  />
                </ModelRow>
              );
            })
          )}
        </div>
      </section>

      {unconnectedModels.length > 0 && (!searching || visibleUnconnected.length > 0) ? (
        <section className="settings-section">
          <div className="settings-section__header">
            <h3 className="settings-section__title">
              Not connected{" "}
              <span className="resource-list__count">{visibleUnconnected.length}</span>
            </h3>
            <button className="button button--secondary" type="button" onClick={onOpenProviders}>
              Connect a provider
            </button>
          </div>
          <p className="settings-section__description">
            Models from providers you have not signed in to.
          </p>
          {searching || showUnconnected ? (
            <div className="settings-group" data-testid="settings-unconnected-model-list">
              {visibleUnconnected.map((model) => (
                <ModelRow isDefault={false} key={modelPattern(model)} model={model} />
              ))}
            </div>
          ) : (
            <button
              className="resource-list__more"
              type="button"
              onClick={() => setShowUnconnected(true)}
            >
              Show {unconnectedModels.length} models
            </button>
          )}
        </section>
      ) : null}
    </>
  );
}

function ModelRow({
  model,
  isDefault,
  children,
}: {
  readonly model: RuntimeModelRecord;
  readonly isDefault: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="settings-row model-row">
      <div className="settings-row__label">
        <div className="settings-row__title">
          {model.label}
          {isDefault ? <span className="model-row__badge">Default</span> : null}
        </div>
        <div className="settings-row__description">
          {model.providerName} · {modelPattern(model)}
          {model.reasoning ? <span className="model-row__tag">Reasoning</span> : null}
          {model.supportsImages ? <span className="model-row__tag">Images</span> : null}
        </div>
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}
