import { expect, test } from "@playwright/test";
import type { RuntimeModelRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { SessionModelSelection } from "@pi-gui/session-driver/types";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  commitLeadModelSelection,
  DEFAULT_LEAD_MODEL_DESCRIPTION,
  DEFAULT_LEAD_MODEL_THREAD_VALUE,
  DEFAULT_LEAD_MODEL_TITLE,
  leadModelOptions,
  leadModelSelectValue,
  resolveLeadModelSelection,
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
  modelRecord("acme", "lead-1", "Lead One"),
  modelRecord("acme", "lead-2", "Lead Two"),
];

test("renders the row with Thread's own model active when the setting is absent", () => {
  expect(DEFAULT_LEAD_MODEL_TITLE).toBe("Default lead model");
  const options = leadModelOptions(runtimeWith(MODELS).models);
  expect(options[0]).toEqual({
    value: DEFAULT_LEAD_MODEL_THREAD_VALUE,
    label: "Thread's own model",
  });
  // The row binds the select to this value, and it matches an option, so the
  // thread entry renders as the active option when no lead model is stored.
  expect(leadModelSelectValue(undefined)).toBe(DEFAULT_LEAD_MODEL_THREAD_VALUE);
});

test("renders the stored model active when the setting is present", () => {
  const options = leadModelOptions(runtimeWith(MODELS).models);
  expect(leadModelSelectValue({ provider: "acme", modelId: "lead-2" })).toBe("acme:lead-2");
  expect(options.some((option) => option.value === "acme:lead-2")).toBe(true);
});

test("selecting a model calls setDefaultLeadModel once with the chosen model", async () => {
  const calls: (SessionModelSelection | null)[] = [];
  const returned = { defaultLeadModel: { provider: "acme", modelId: "lead-2" } } as DesktopAppState;
  const state = await commitLeadModelSelection("acme:lead-2", (selection) => {
    calls.push(selection);
    return Promise.resolve(returned);
  });
  expect(calls).toEqual([{ provider: "acme", modelId: "lead-2" }]);
  expect(state).toBe(returned);
});

test("choosing Thread's own model calls setDefaultLeadModel with null", async () => {
  const calls: (SessionModelSelection | null)[] = [];
  const returned = {} as DesktopAppState;
  await commitLeadModelSelection(DEFAULT_LEAD_MODEL_THREAD_VALUE, (selection) => {
    calls.push(selection);
    return Promise.resolve(returned);
  });
  expect(calls).toEqual([null]);
});

test("the lead picker reuses the default-model option list plus the thread entry", () => {
  const options = leadModelOptions(runtimeWith(MODELS).models);
  expect(options.slice(1)).toEqual([
    { value: "acme:lead-1", label: "Acme · Lead One" },
    { value: "acme:lead-2", label: "Acme · Lead Two" },
  ]);
  expect(resolveLeadModelSelection("acme:lead-1")).toEqual({
    provider: "acme",
    modelId: "lead-1",
  });
});

test("the helper text mentions that threads with messages keep their model", () => {
  expect(DEFAULT_LEAD_MODEL_DESCRIPTION).toContain(
    "Threads that already have messages keep their current model",
  );
});
