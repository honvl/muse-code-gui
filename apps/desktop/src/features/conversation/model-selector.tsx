import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  buildModelOptions,
  filterThinkingOptionsForModelLevels,
  MODEL_OPTIONS_EMPTY_TITLE,
  THINKING_OPTIONS,
  type ComposerModelOption,
} from "./composer-commands";
import { DEFAULT_SIDEKICK_THINKING_LEVEL } from "../../../contracts/desktop-state";
import { effectiveThinkingLevel, modelThinkingLevels } from "../../../contracts/thinking-levels";

interface ModelSelectorProps {
  readonly runtime: RuntimeSnapshot | undefined;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly orchestratorMode?: boolean;
  readonly sidekickProvider?: string | undefined;
  readonly sidekickModelId?: string | undefined;
  readonly sidekickThinkingLevel?: string | undefined;
  /** App-global sidekick reasoning children inherit when the thread sets none. */
  readonly defaultSidekickThinkingLevel?: string | undefined;
  readonly disabled?: boolean;
  readonly dropdownPlacement?: "above" | "below";
  readonly showEmptyModelControl?: boolean;
  readonly unselectedModelLabel?: string;
  readonly emptyModelLabel?: string;
  readonly emptyModelTitle?: string;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly onToggleOrchestrator?: (enabled: boolean) => void;
  readonly onSetSidekickModel?: (provider: string, modelId: string) => void;
  readonly onClearSidekickModel?: () => void;
  /** DesktopAppState's fail-fast notes; the sidekick warning is derived from them here. */
  readonly providerFailureNotes?: Readonly<Record<string, string>> | undefined;
  /** `null` clears the sidekick's reasoning back to the app-global default. */
  readonly onSetSidekickThinkingLevel?: (level: string | null) => void;
}

export const SIDEKICK_IS_LEAD_WARNING = "Sidekick is the lead model; no savings";

export const SIDEKICK_PROVIDER_FAILED_WARNING_ATTRIBUTE = "sidekick-provider-failed";

/**
 * Refusal note when the thread's effective sidekick model sits inside its
 * provider fail-fast window (recent attestation/auth failure), else
 * undefined. Pure and renderer-safe; ModelSelector feeds it DesktopAppState's
 * providerFailureNotes.
 */
export function sidekickFailureWarning(input: {
  readonly sidekickProvider: string | undefined;
  readonly sidekickModelId: string | undefined;
  readonly defaultProvider: string | undefined;
  readonly defaultModelId: string | undefined;
  readonly failureNotes: Readonly<Record<string, string>> | undefined;
}): string | undefined {
  const provider = input.sidekickProvider ?? input.defaultProvider;
  const modelId = input.sidekickModelId ?? input.defaultModelId;
  if (!provider || !modelId || !input.failureNotes) {
    return undefined;
  }
  return input.failureNotes[`${provider}:${modelId}`];
}

/**
 * True when children would run on the lead's own model: the thread's sidekick,
 * or the workspace default when none is set, equals the lead model.
 */
export function sidekickMatchesLead(input: {
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly sidekickProvider: string | undefined;
  readonly sidekickModelId: string | undefined;
  readonly defaultProvider: string | undefined;
  readonly defaultModelId: string | undefined;
}): boolean {
  const hasSidekick = Boolean(input.sidekickProvider && input.sidekickModelId);
  const provider = hasSidekick ? input.sidekickProvider : input.defaultProvider;
  const modelId = hasSidekick ? input.sidekickModelId : input.defaultModelId;
  return Boolean(
    input.provider && input.modelId && provider === input.provider && modelId === input.modelId,
  );
}

/**
 * Labels for the sidekick reasoning badge, showing what pi will apply on the
 * sidekick's model rather than a level it cannot run. Without a thread
 * override children inherit the app-global default, shown as "Default (xhigh)".
 */
export function describeSidekickThinking(input: {
  readonly threadLevel: string | undefined;
  readonly defaultLevel: string;
  readonly modelLevels: readonly string[] | undefined;
}): { readonly badgeLabel: string; readonly inheritedLabel: string } {
  const inheritedLabel = `Default (${effectiveThinkingLevel(input.defaultLevel, input.modelLevels)})`;
  const effective = input.threadLevel
    ? effectiveThinkingLevel(input.threadLevel, input.modelLevels)
    : undefined;
  const label = effective
    ? (THINKING_OPTIONS.find((option) => option.value === effective)?.label ?? effective)
    : inheritedLabel;
  return { badgeLabel: `Sidekick reasoning: ${label}`, inheritedLabel };
}

type OpenDropdown = "none" | "model" | "thinking" | "sidekick" | "sidekick-thinking";

export function ModelSelector({
  runtime,
  provider,
  modelId,
  thinkingLevel,
  orchestratorMode,
  sidekickProvider,
  sidekickModelId,
  sidekickThinkingLevel,
  providerFailureNotes,
  defaultSidekickThinkingLevel = DEFAULT_SIDEKICK_THINKING_LEVEL,
  disabled,
  dropdownPlacement = "above",
  showEmptyModelControl = false,
  unselectedModelLabel = "Choose model",
  emptyModelLabel = "Choose model",
  emptyModelTitle = MODEL_OPTIONS_EMPTY_TITLE,
  onSetModel,
  onSetThinking,
  onToggleOrchestrator,
  onSetSidekickModel,
  onClearSidekickModel,
  onSetSidekickThinkingLevel,
}: ModelSelectorProps) {
  const [open, setOpen] = useState<OpenDropdown>("none");
  const [modelFilter, setModelFilter] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  const modelOptions = useMemo(() => buildModelOptions(runtime), [runtime]);
  const filteredModels = useMemo(() => {
    if (!modelFilter) return modelOptions;
    const q = modelFilter.toLowerCase();
    return modelOptions.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        opt.description.toLowerCase().includes(q) ||
        opt.providerId.toLowerCase().includes(q),
    );
  }, [modelOptions, modelFilter]);

  const groupedModels = useMemo(() => groupByProvider(filteredModels), [filteredModels]);
  // Only offer levels the selected model accepts; the backend clamps anything
  // else, which is what made "max" snap back to "xhigh" on contributor models.
  const currentModelThinkingLevels = runtime?.models.find(
    (model) => model.providerId === provider && model.modelId === modelId,
  )?.thinkingLevels;
  const visibleThinkingOptions = useMemo(
    () => filterThinkingOptionsForModelLevels(currentModelThinkingLevels),
    [currentModelThinkingLevels],
  );
  // Children run on the sidekick model, or the workspace default model when none is set.
  const hasSidekickSelection = Boolean(sidekickProvider && sidekickModelId);
  const sidekickModelThinkingLevels = modelThinkingLevels(
    runtime,
    hasSidekickSelection ? sidekickProvider : runtime?.settings.defaultProvider,
    hasSidekickSelection ? sidekickModelId : runtime?.settings.defaultModelId,
  );
  const visibleSidekickThinkingOptions = useMemo(
    () => filterThinkingOptionsForModelLevels(sidekickModelThinkingLevels),
    [sidekickModelThinkingLevels],
  );
  const hasAvailableModelOptions = modelOptions.length > 0;
  const hasModelControl = Boolean(provider && modelId) || hasAvailableModelOptions;
  const shouldRenderModelControl = hasModelControl || showEmptyModelControl;
  const modelBadgeLabel =
    provider && modelId
      ? `${provider}:${modelId}`
      : hasAvailableModelOptions
        ? unselectedModelLabel
        : emptyModelLabel;
  const noMatchingModels =
    hasAvailableModelOptions && modelFilter.trim().length > 0 && groupedModels.length === 0;

  useEffect(() => {
    if (open === "none") {
      setModelFilter("");
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen("none");
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen("none");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const showOrchestratorToggle = onToggleOrchestrator !== undefined;
  // The sidekick picker only exists for a selected lead-mode thread: it needs
  // both handlers (set + clear) and orchestrator mode on. New-thread surfaces
  // never supply the handlers, so the control stays absent there.
  const showSidekickSelector =
    orchestratorMode === true &&
    onSetSidekickModel !== undefined &&
    onClearSidekickModel !== undefined;
  const sidekickOption =
    hasSidekickSelection && sidekickProvider && sidekickModelId
      ? modelOptions.find(
          (option) => option.providerId === sidekickProvider && option.modelId === sidekickModelId,
        )
      : undefined;
  const sidekickBadgeLabel =
    sidekickProvider && sidekickModelId
      ? `Sidekick: ${sidekickOption ? sidekickOption.label : `${sidekickProvider}:${sidekickModelId}`}`
      : "Sidekick: workspace default";
  const sidekickWarning = sidekickFailureWarning({
    sidekickProvider,
    sidekickModelId,
    defaultProvider: runtime?.settings.defaultProvider,
    defaultModelId: runtime?.settings.defaultModelId,
    failureNotes: providerFailureNotes,
  });
  const sidekickWarningActive = showSidekickSelector && Boolean(sidekickWarning);
  const sidekickIsLead =
    showSidekickSelector &&
    sidekickMatchesLead({
      provider,
      modelId,
      sidekickProvider,
      sidekickModelId,
      defaultProvider: runtime?.settings.defaultProvider,
      defaultModelId: runtime?.settings.defaultModelId,
    });
  const { badgeLabel: sidekickThinkingBadgeLabel, inheritedLabel: inheritedSidekickThinkingLabel } =
    describeSidekickThinking({
      threadLevel: sidekickThinkingLevel,
      defaultLevel: defaultSidekickThinkingLevel,
      modelLevels: sidekickModelThinkingLevels,
    });
  if (
    !shouldRenderModelControl &&
    !thinkingLevel &&
    !showOrchestratorToggle &&
    !showSidekickSelector
  ) {
    return null;
  }

  return (
    <span className="model-selector" ref={containerRef}>
      {shouldRenderModelControl ? (
        <span className="model-selector__anchor">
          <button
            className="model-selector__badge"
            type="button"
            disabled={disabled}
            onClick={() => setOpen(open === "model" ? "none" : "model")}
          >
            {modelBadgeLabel}
          </button>
          {open === "model" ? (
            <div
              className={`model-selector__dropdown ${dropdownPlacement === "below" ? "model-selector__dropdown--below" : ""}`}
              onWheel={(event) => event.stopPropagation()}
            >
              <div className="model-selector__filter">
                <input
                  className="model-selector__filter-input"
                  placeholder="Filter models..."
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  autoFocus
                />
              </div>
              {groupedModels.map((group) => (
                <div key={group.provider}>
                  <div className="model-selector__group-title">{group.provider}</div>
                  {group.items.map((option) => {
                    const isActive = option.providerId === provider && option.modelId === modelId;
                    return (
                      <button
                        className={`model-selector__item${isActive ? " model-selector__item--active" : ""}`}
                        key={`${option.providerId}:${option.modelId}`}
                        type="button"
                        onClick={() => {
                          if (!isActive) {
                            onSetModel(option.providerId, option.modelId);
                          }
                          setOpen("none");
                        }}
                      >
                        <span className="model-selector__item-label">{option.label}</span>
                        {isActive ? (
                          <span className="model-selector__item-meta">active</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              {groupedModels.length === 0 ? (
                <>
                  <div className="model-selector__group-title">
                    {noMatchingModels ? "No matching models" : emptyModelTitle}
                  </div>
                  {noMatchingModels ? (
                    <div className="model-selector__empty">Try a different filter.</div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </span>
      ) : null}
      {showOrchestratorToggle ? (
        <span className="model-selector__anchor">
          <button
            className={`model-selector__badge${orchestratorMode ? " model-selector__item--active" : ""}`}
            type="button"
            disabled={disabled}
            data-warning={
              sidekickWarningActive
                ? SIDEKICK_PROVIDER_FAILED_WARNING_ATTRIBUTE
                : sidekickIsLead
                  ? "sidekick-is-lead"
                  : undefined
            }
            title={
              sidekickWarningActive && sidekickWarning
                ? sidekickWarning
                : sidekickIsLead
                  ? SIDEKICK_IS_LEAD_WARNING
                  : orchestratorMode
                    ? "Lead: delegates bulky work and reviews what children report"
                    : "Solo: works in this thread; can still delegate when needed"
            }
            onClick={() => onToggleOrchestrator?.(!orchestratorMode)}
          >
            {orchestratorMode ? "Lead" : "Solo"}
            {sidekickIsLead || sidekickWarningActive ? (
              <span aria-hidden="true" className="model-selector__badge-warning" />
            ) : null}
          </button>
        </span>
      ) : null}
      {showSidekickSelector ? (
        <span className="model-selector__anchor">
          <button
            className="model-selector__badge"
            type="button"
            disabled={disabled}
            title="Model used for child threads"
            onClick={() => setOpen(open === "sidekick" ? "none" : "sidekick")}
          >
            {sidekickBadgeLabel}
          </button>
          {open === "sidekick" ? (
            <div
              className={`model-selector__dropdown ${dropdownPlacement === "below" ? "model-selector__dropdown--below" : ""}`}
              onWheel={(event) => event.stopPropagation()}
            >
              <div className="model-selector__filter">
                <input
                  className="model-selector__filter-input"
                  placeholder="Filter models..."
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  autoFocus
                />
              </div>
              <button
                className={`model-selector__item${hasSidekickSelection ? "" : " model-selector__item--active"}`}
                type="button"
                onClick={() => {
                  if (hasSidekickSelection) {
                    onClearSidekickModel?.();
                  }
                  setOpen("none");
                }}
              >
                <span className="model-selector__item-label">Workspace default</span>
                {hasSidekickSelection ? null : (
                  <span className="model-selector__item-meta">active</span>
                )}
              </button>
              {groupedModels.map((group) => (
                <div key={group.provider}>
                  <div className="model-selector__group-title">{group.provider}</div>
                  {group.items.map((option) => {
                    const isActive =
                      option.providerId === sidekickProvider && option.modelId === sidekickModelId;
                    return (
                      <button
                        className={`model-selector__item${isActive ? " model-selector__item--active" : ""}`}
                        key={`${option.providerId}:${option.modelId}`}
                        type="button"
                        onClick={() => {
                          if (!isActive) {
                            onSetSidekickModel?.(option.providerId, option.modelId);
                          }
                          setOpen("none");
                        }}
                      >
                        <span className="model-selector__item-label">{option.label}</span>
                        {isActive ? (
                          <span className="model-selector__item-meta">active</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              {groupedModels.length === 0 ? (
                <>
                  <div className="model-selector__group-title">
                    {noMatchingModels ? "No matching models" : emptyModelTitle}
                  </div>
                  {noMatchingModels ? (
                    <div className="model-selector__empty">Try a different filter.</div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </span>
      ) : null}
      {showSidekickSelector && onSetSidekickThinkingLevel ? (
        <span className="model-selector__anchor">
          <button
            className="model-selector__badge"
            type="button"
            disabled={disabled}
            title="Reasoning effort child threads start with"
            onClick={() => setOpen(open === "sidekick-thinking" ? "none" : "sidekick-thinking")}
          >
            {sidekickThinkingBadgeLabel}
          </button>
          {open === "sidekick-thinking" ? (
            <div
              className={`model-selector__dropdown ${dropdownPlacement === "below" ? "model-selector__dropdown--below" : ""}`}
              onWheel={(event) => event.stopPropagation()}
            >
              <div className="model-selector__group-title">Sidekick reasoning</div>
              <button
                className={`model-selector__item${sidekickThinkingLevel ? "" : " model-selector__item--active"}`}
                type="button"
                onClick={() => {
                  if (sidekickThinkingLevel) {
                    onSetSidekickThinkingLevel(null);
                  }
                  setOpen("none");
                }}
              >
                <span className="model-selector__item-label">{inheritedSidekickThinkingLabel}</span>
                {sidekickThinkingLevel ? null : (
                  <span className="model-selector__item-meta">active</span>
                )}
              </button>
              {visibleSidekickThinkingOptions.map((option) => {
                const isActive = option.value === sidekickThinkingLevel;
                return (
                  <button
                    className={`model-selector__item${isActive ? " model-selector__item--active" : ""}`}
                    key={option.value}
                    type="button"
                    onClick={() => {
                      if (!isActive) {
                        onSetSidekickThinkingLevel(option.value);
                      }
                      setOpen("none");
                    }}
                  >
                    <span className="model-selector__item-label">{option.label}</span>
                    <span className="model-selector__item-meta">{option.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </span>
      ) : null}
      {thinkingLevel ? (
        <span className="model-selector__anchor">
          <button
            className="model-selector__badge"
            type="button"
            disabled={disabled}
            onClick={() => setOpen(open === "thinking" ? "none" : "thinking")}
          >
            {thinkingLevel}
          </button>
          {open === "thinking" ? (
            <div
              className={`model-selector__dropdown ${dropdownPlacement === "below" ? "model-selector__dropdown--below" : ""}`}
              onWheel={(event) => event.stopPropagation()}
            >
              <div className="model-selector__group-title">Thinking Level</div>
              {visibleThinkingOptions.map((option) => {
                const isActive = option.value === thinkingLevel;
                return (
                  <button
                    className={`model-selector__item${isActive ? " model-selector__item--active" : ""}`}
                    key={option.value}
                    type="button"
                    onClick={() => {
                      if (!isActive) {
                        onSetThinking(option.value);
                      }
                      setOpen("none");
                    }}
                  >
                    <span className="model-selector__item-label">{option.label}</span>
                    <span className="model-selector__item-meta">{option.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

interface ModelGroup {
  readonly provider: string;
  readonly items: readonly ComposerModelOption[];
}

function groupByProvider(options: readonly ComposerModelOption[]): readonly ModelGroup[] {
  const groups = new Map<string, ComposerModelOption[]>();
  for (const option of options) {
    const existing = groups.get(option.providerId);
    if (existing) {
      existing.push(option);
    } else {
      groups.set(option.providerId, [option]);
    }
  }
  return Array.from(groups.entries()).map(([provider, items]) => ({ provider, items }));
}
