import { expect, test } from "@playwright/test";
import type { RuntimeModelRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { SessionModelSelection } from "@pi-gui/session-driver/types";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  commitScoutModelSelection,
  DEFAULT_SCOUT_MODEL_DESCRIPTION,
  DEFAULT_SCOUT_MODEL_THREAD_VALUE,
  DEFAULT_SCOUT_MODEL_TITLE,
  DEFAULT_SCOUT_THINKING_SIDEKICK_VALUE,
  resolveScoutModelSelection,
  resolveScoutThinkingLevel,
  scoutModelOptions,
  scoutModelSelectValue,
  scoutThinkingOptions,
  scoutThinkingSelectValue,
} from "../../src/features/settings/settings-models-section";

function modelRecord(
  providerId: string,
  modelId: string,
  label: string,
  providerName = "Acme",
): RuntimeModelRecord {
  return {
    providerId,
    providerName,
    modelId,
    label,
    available: true,
    authType: "api_key",
    reasoning: false,
    supportsImages: false,
    thinkingLevels: [],
  };
}

function runtimeWith(models: readonly RuntimeModelRecord[]): RuntimeSnapshot {
  return {
    models,
    settings: { enableSkillCommands: false, enabledModelPatterns: [] },
  } as unknown as RuntimeSnapshot;
}

const MODELS = [
  modelRecord("acme", "scout-1", "Scout One"),
  modelRecord("acme", "scout-2", "Scout Two"),
];

test("renders the row with Thread's sidekick model active when the setting is absent", () => {
  expect(DEFAULT_SCOUT_MODEL_TITLE).toBe("Default scout model");
  const options = scoutModelOptions(runtimeWith(MODELS).models);
  expect(options[0]).toEqual({
    value: DEFAULT_SCOUT_MODEL_THREAD_VALUE,
    label: "Thread's sidekick model",
  });
  // The row binds the select to this value, and it matches an option, so the
  // thread entry renders as the active option when no scout model is stored.
  expect(scoutModelSelectValue(undefined)).toBe(DEFAULT_SCOUT_MODEL_THREAD_VALUE);
});

test("renders the stored model active when the setting is present", () => {
  const options = scoutModelOptions(runtimeWith(MODELS).models);
  expect(scoutModelSelectValue({ provider: "acme", modelId: "scout-2" })).toBe("acme:scout-2");
  expect(options.some((option) => option.value === "acme:scout-2")).toBe(true);
});

test("selecting a model calls setDefaultScoutModel once with the chosen model", async () => {
  const calls: (SessionModelSelection | null)[] = [];
  const returned = {
    defaultScoutModel: { provider: "acme", modelId: "scout-2" },
  } as DesktopAppState;
  const state = await commitScoutModelSelection("acme:scout-2", (selection) => {
    calls.push(selection);
    return Promise.resolve(returned);
  });
  expect(calls).toEqual([{ provider: "acme", modelId: "scout-2" }]);
  expect(state).toBe(returned);
});

test("choosing Thread's sidekick model calls setDefaultScoutModel with null", async () => {
  const calls: (SessionModelSelection | null)[] = [];
  const returned = {} as DesktopAppState;
  await commitScoutModelSelection(DEFAULT_SCOUT_MODEL_THREAD_VALUE, (selection) => {
    calls.push(selection);
    return Promise.resolve(returned);
  });
  expect(calls).toEqual([null]);
});

test("the scout picker reuses the default-model option list plus the thread entry", () => {
  const options = scoutModelOptions(runtimeWith(MODELS).models);
  expect(options.slice(1)).toEqual([
    { value: "acme:scout-1", label: "Acme · Scout One" },
    { value: "acme:scout-2", label: "Acme · Scout Two" },
  ]);
  expect(resolveScoutModelSelection("acme:scout-1")).toEqual({
    provider: "acme",
    modelId: "scout-1",
  });
});

test("the helper text says workers keep the thread's sidekick model", () => {
  expect(DEFAULT_SCOUT_MODEL_DESCRIPTION).toContain(
    "Workers keep using the thread's sidekick model",
  );
});

test("scout reasoning row defaults to the sidekick's reasoning and maps levels through", () => {
  const options = scoutThinkingOptions();
  expect(options[0]).toEqual({
    value: DEFAULT_SCOUT_THINKING_SIDEKICK_VALUE,
    label: "Sidekick's reasoning",
  });
  expect(options.slice(1).map((option) => option.value)).toEqual([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(scoutThinkingSelectValue(undefined)).toBe(DEFAULT_SCOUT_THINKING_SIDEKICK_VALUE);
  expect(scoutThinkingSelectValue("high")).toBe("high");
  expect(resolveScoutThinkingLevel(DEFAULT_SCOUT_THINKING_SIDEKICK_VALUE)).toBeNull();
  expect(resolveScoutThinkingLevel("low")).toBe("low");
});
