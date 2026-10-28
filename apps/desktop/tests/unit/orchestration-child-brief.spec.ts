import { expect, test } from "@playwright/test";
import {
  CHILD_REPORT_SUFFIX,
  DEFAULT_SUCCESS_CRITERIA,
  DEFAULT_VERIFY,
  SCOPE_BRIEF_WARNING,
  briefWarningsFromParams,
  composeChildBrief,
  createChildThreadBriefFromParams,
} from "../../electron/orchestration/orchestration-runtime";

test("composeChildBrief composes a full brief in fixed order", () => {
  expect(
    composeChildBrief({
      prompt: "Investigate the auth flow.",
      scope: "apps/desktop/src/features/auth",
      constraints: "Do not change the login screen.",
      success_criteria: "A written summary of the token path.",
      verify: "pnpm --filter @pi-gui/desktop run typecheck",
    }),
  ).toBe(
    [
      "Investigate the auth flow.",
      "Scope: apps/desktop/src/features/auth",
      "Constraints: Do not change the login screen.",
      "Success criteria: A written summary of the token path.",
      "Verify: pnpm --filter @pi-gui/desktop run typecheck",
      CHILD_REPORT_SUFFIX,
    ].join("\n\n"),
  );
});

test("composeChildBrief omits blank scope/constraints and defaults success criteria/verify", () => {
  expect(composeChildBrief({ prompt: "Just do it." })).toBe(
    [
      "Just do it.",
      `Success criteria: ${DEFAULT_SUCCESS_CRITERIA}`,
      `Verify: ${DEFAULT_VERIFY}`,
      CHILD_REPORT_SUFFIX,
    ].join("\n\n"),
  );
  expect(
    composeChildBrief({
      prompt: "  Tidy the helper.  ",
      scope: "   ",
      constraints: "",
      success_criteria: "No lint errors.",
      verify: "  ",
    }),
  ).toBe(
    [
      "Tidy the helper.",
      "Success criteria: No lint errors.",
      `Verify: ${DEFAULT_VERIFY}`,
      CHILD_REPORT_SUFFIX,
    ].join("\n\n"),
  );
});

test("composeChildBrief always ends with the report contract", () => {
  expect(composeChildBrief({ prompt: "Just do it." }).endsWith(CHILD_REPORT_SUFFIX)).toBe(true);
  expect(
    composeChildBrief({
      prompt: "Investigate the auth flow.",
      scope: "apps/desktop/src/features/auth",
      constraints: "Do not change the login screen.",
      success_criteria: "A written summary of the token path.",
      verify: "pnpm --filter @pi-gui/desktop run typecheck",
    }).endsWith(`\n\n${CHILD_REPORT_SUFFIX}`),
  ).toBe(true);
});

test("briefWarningsFromParams flags only missing scope", () => {
  expect(briefWarningsFromParams(undefined)).toEqual([]);
  expect(briefWarningsFromParams({})).toEqual([SCOPE_BRIEF_WARNING]);
  expect(
    briefWarningsFromParams({ prompt: "x", scope: "apps/a", success_criteria: "done when green" }),
  ).toEqual([]);
  // Success criteria and verify fall back to host defaults, so they never warn.
  expect(briefWarningsFromParams({ prompt: "x", scope: "apps/a" })).toEqual([]);
  expect(briefWarningsFromParams({ prompt: "x", success_criteria: "done when green" })).toEqual([
    SCOPE_BRIEF_WARNING,
  ]);
  // Blank scope counts as missing; constraints/verify gaps never warn.
  expect(briefWarningsFromParams({ prompt: "x", scope: "  ", verify: "pnpm t" })).toEqual([
    SCOPE_BRIEF_WARNING,
  ]);
});

test("createChildThreadBriefFromParams reads prompt plus optional blocks", () => {
  expect(createChildThreadBriefFromParams(undefined)).toBeUndefined();
  expect(createChildThreadBriefFromParams({})).toBeUndefined();
  expect(createChildThreadBriefFromParams({ prompt: "   " })).toBeUndefined();
  expect(createChildThreadBriefFromParams({ prompt: "Explore." })).toBe(
    [
      "Explore.",
      `Success criteria: ${DEFAULT_SUCCESS_CRITERIA}`,
      `Verify: ${DEFAULT_VERIFY}`,
      CHILD_REPORT_SUFFIX,
    ].join("\n\n"),
  );
  expect(
    createChildThreadBriefFromParams({
      prompt: "Explore.",
      scope: "packages/pi-sdk-driver/src",
      success_criteria: "List the owners.",
    }),
  ).toBe(
    [
      "Explore.",
      "Scope: packages/pi-sdk-driver/src",
      "Success criteria: List the owners.",
      `Verify: ${DEFAULT_VERIFY}`,
      CHILD_REPORT_SUFFIX,
    ].join("\n\n"),
  );
  expect(
    createChildThreadBriefFromParams({
      prompt: "Explore.",
      scope: "  ",
      constraints: 42,
      verify: " pnpm test ",
    }),
  ).toBe(
    [
      "Explore.",
      `Success criteria: ${DEFAULT_SUCCESS_CRITERIA}`,
      "Verify: pnpm test",
      CHILD_REPORT_SUFFIX,
    ].join("\n\n"),
  );
});
