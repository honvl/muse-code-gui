import { expect, test } from "@playwright/test";
import {
  CHILD_REPORT_SUFFIX,
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

test("composeChildBrief omits missing and blank blocks", () => {
  expect(composeChildBrief({ prompt: "Just do it." })).toBe(
    ["Just do it.", CHILD_REPORT_SUFFIX].join("\n\n"),
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
    ["Tidy the helper.", "Success criteria: No lint errors.", CHILD_REPORT_SUFFIX].join("\n\n"),
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

test("createChildThreadBriefFromParams reads prompt plus optional blocks", () => {
  expect(createChildThreadBriefFromParams(undefined)).toBeUndefined();
  expect(createChildThreadBriefFromParams({})).toBeUndefined();
  expect(createChildThreadBriefFromParams({ prompt: "   " })).toBeUndefined();
  expect(createChildThreadBriefFromParams({ prompt: "Explore." })).toBe(
    ["Explore.", CHILD_REPORT_SUFFIX].join("\n\n"),
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
  ).toBe(["Explore.", "Verify: pnpm test", CHILD_REPORT_SUFFIX].join("\n\n"));
});
