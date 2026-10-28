import { expect, test } from "@playwright/test";
import {
  DEFAULT_LEAD_THINKING_LEVEL,
  DEFAULT_SIDEKICK_THINKING_LEVEL,
} from "../../contracts/desktop-state";
import { effectiveThinkingLevel } from "../../contracts/thinking-levels";
import { expectNullableThinkingLevel } from "../../electron/ipc/request-validation";
import { describeSidekickThinking } from "../../src/features/conversation/model-selector";
import {
  allThinkingOptions,
  DEFAULT_LEAD_THINKING_TITLE,
  DEFAULT_SIDEKICK_THINKING_TITLE,
} from "../../src/features/settings/settings-models-section";

test("lead and sidekick reasoning default to high and xhigh", () => {
  expect(DEFAULT_LEAD_THINKING_LEVEL).toBe("high");
  expect(DEFAULT_SIDEKICK_THINKING_LEVEL).toBe("xhigh");
  expect(DEFAULT_LEAD_THINKING_TITLE).toBe("Default lead reasoning");
  expect(DEFAULT_SIDEKICK_THINKING_TITLE).toBe("Default sidekick reasoning");
});

test("the reasoning rows offer every level, including off and minimal", () => {
  expect(allThinkingOptions()).toEqual([
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
  ]);
  for (const level of ["off", "minimal", "xhigh"]) {
    expect(expectNullableThinkingLevel(level)).toBe(level);
  }
  expect(expectNullableThinkingLevel(null)).toBeNull();
});

test("the effective level mirrors pi's clamp: nearest above, else below", () => {
  const upToHigh = ["off", "minimal", "low", "medium", "high"];
  expect(effectiveThinkingLevel("xhigh", upToHigh)).toBe("high");
  expect(effectiveThinkingLevel("xhigh", ["off", "low", "high", "xhigh", "max"])).toBe("xhigh");
  expect(effectiveThinkingLevel("minimal", ["off", "low", "high"])).toBe("low");
  expect(effectiveThinkingLevel("high", ["off"])).toBe("off");
  // Unknown support: shown as requested.
  expect(effectiveThinkingLevel("xhigh", undefined)).toBe("xhigh");
});

test("the sidekick reasoning badge shows the inherited default, clamped to the model", () => {
  expect(
    describeSidekickThinking({
      threadLevel: undefined,
      defaultLevel: "xhigh",
      modelLevels: undefined,
    }),
  ).toEqual({
    badgeLabel: "Sidekick reasoning: Default (xhigh)",
    inheritedLabel: "Default (xhigh)",
  });
  const upToHigh = ["off", "minimal", "low", "medium", "high"];
  expect(
    describeSidekickThinking({
      threadLevel: undefined,
      defaultLevel: "xhigh",
      modelLevels: upToHigh,
    }).badgeLabel,
  ).toBe("Sidekick reasoning: Default (high)");
  expect(
    describeSidekickThinking({ threadLevel: "low", defaultLevel: "xhigh", modelLevels: upToHigh })
      .badgeLabel,
  ).toBe("Sidekick reasoning: Low");
  expect(
    describeSidekickThinking({ threadLevel: "xhigh", defaultLevel: "xhigh", modelLevels: upToHigh })
      .badgeLabel,
  ).toBe("Sidekick reasoning: High");
});
