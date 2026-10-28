import { useEffect, useState, type ReactNode } from "react";
import type {
  RuntimeModelRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { SessionModelSelection } from "@pi-gui/session-driver/types";
import type { DesktopAppState } from "../../../contracts/desktop-state";
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
  "New lead threads start on this model. Threads that already have messages keep their current model.";

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
 * Options for the default-lead-model picker: the same enabled-model list the
 * default-model control offers, plus a leading "Thread's own model" entry
 * that clears the setting.
 */
export function leadModelOptions(
  enabledModels: readonly RuntimeModelRecord[],
): readonly LeadModelOption[] {
  return [
    { value: DEFAULT_LEAD_MODEL_THREAD_VALUE, label: "Thread's own model" },
    ...enabledModels.map(modelOption),
  ];
}

/** Picker value reflecting the stored setting; absent means "Thread's own model". */
export function leadModelSelectValue(selection: SessionModelSelection | undefined): string {
  if (!selection) {
    return DEFAULT_LEAD_MODEL_THREAD_VALUE;
  }
  return `${selection.provider}:${selection.modelId}`;
}

/**
 * Parse a picker value back into a bridge selection. The thread entry resolves
 * to null, which clears the app-global default lead model.
 */
export function resolveLeadModelSelection(value: string): SessionModelSelection | null {
  if (value === DEFAULT_LEAD_MODEL_THREAD_VALUE) {
    return null;
  }
  const [provider = "", ...modelParts] = value.split(":");
  return { provider, modelId: modelParts.join(":") };
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
  return [
    { value: DEFAULT_SCOUT_MODEL_THREAD_VALUE, label: "Thread's sidekick model" },
    ...enabledModels.map(modelOption),
  ];
}

/** Picker value reflecting the stored setting; absent means "Thread's sidekick model". */
export function scoutModelSelectValue(selection: SessionModelSelection | undefined): string {
  if (!selection) {
    return DEFAULT_SCOUT_MODEL_THREAD_VALUE;
  }
  return `${selection.provider}:${selection.modelId}`;
}

/**
 * Parse a picker value back into a bridge selection. The thread entry resolves
 * to null, which clears the app-global default scout model.
 */
export function resolveScoutModelSelection(value: string): SessionModelSelection | null {
  if (value === DEFAULT_SCOUT_MODEL_THREAD_VALUE) {
    return null;
  }
  const [provider = "", ...modelParts] = value.split(":");
  return { provider, modelId: modelParts.join(":") };
}

/**
 * Commit a picker value through the bridge. The component reflects the returned
 * state; exported so unit tests can assert the selection mapping without a DOM.
 */
export function commitScoutModelSelection(
  value: string,
  setDefaultScoutModel: (selection: SessionModelSelection | null) => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return setDefaultScoutModel(resolveScoutModelSelection(value));
}

/**
 * Commit a picker value through the bridge. The component reflects the returned
 * state; exported so unit tests can assert the selection mapping without a DOM.
 */
export function commitLeadModelSelection(
  value: string,
  setDefaultLeadModel: (selection: SessionModelSelection | null) => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return setDefaultLeadModel(resolveLeadModelSelection(value));
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

function modelPattern(model: RuntimeModelRecord): string {
  return `${model.providerId}/${model.modelId}`;
}

/** Cursor's Models page: defaults on top, then one searchable list with a switch per model. */
export function SettingsModelsSection({
  runtime,
  defaultLeadModel,
  defaultScoutModel,
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

  // App-global override for new lead threads; absent means "Thread's own model".
  // Loaded from the bridge because no parent threads this value through yet.
  const [leadSelection, setLeadSelection] = useState<SessionModelSelection | undefined>(
    defaultLeadModel,
  );
  useEffect(() => {
    if (defaultLeadModel !== undefined) {
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
          setLeadSelection(state.defaultLeadModel);
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
  }, [defaultLeadModel]);

  // Mirrors handleSetModelSettingsScopeMode in secondary-surfaces: fire the
  // app-global bridge call and log failures, then reflect the returned state.
  const handleLeadModelChange = (value: string) => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    void commitLeadModelSelection(value, (selection) => api.setDefaultLeadModel(selection))
      .then((state) => {
        setLeadSelection(state.defaultLeadModel);
      })
      .catch((error: unknown) => {
        console.error("[renderer] setDefaultLeadModel failed", error);
      });
  };

  // App-global override for read-only scout children; absent means "Thread's
  // sidekick model". Loaded from the bridge because no parent threads this
  // value through yet.
  const [scoutSelection, setScoutSelection] = useState<SessionModelSelection | undefined>(
    defaultScoutModel,
  );
  useEffect(() => {
    if (defaultScoutModel !== undefined) {
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
          setScoutSelection(state.defaultScoutModel);
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
  }, [defaultScoutModel]);

  const handleScoutModelChange = (value: string) => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    void commitScoutModelSelection(value, (selection) => api.setDefaultScoutModel(selection))
      .then((state) => {
        setScoutSelection(state.defaultScoutModel);
      })
      .catch((error: unknown) => {
        console.error("[renderer] setDefaultScoutModel failed", error);
      });
  };

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
            value={leadModelSelectValue(leadSelection)}
            onChange={handleLeadModelChange}
          />
        </SettingsRow>
        <SettingsRow
          title={DEFAULT_SCOUT_MODEL_TITLE}
          description={DEFAULT_SCOUT_MODEL_DESCRIPTION}
        >
          <SettingsSelect
            label={DEFAULT_SCOUT_MODEL_TITLE}
            options={scoutModelOptions(enabledModels)}
            value={scoutModelSelectValue(scoutSelection)}
            onChange={handleScoutModelChange}
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
