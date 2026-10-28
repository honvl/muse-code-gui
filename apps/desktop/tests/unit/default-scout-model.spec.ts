import { expect, test } from "@playwright/test";
import type { SessionModelSelection } from "@pi-gui/session-driver";
import {
  isDefaultScoutModelEqual,
  type DefaultScoutModel,
} from "../../electron/application/default-scout-model";
import { expectDefaultScoutModelSelection } from "../../electron/ipc/request-validation";

const scout: SessionModelSelection = {
  provider: "acme",
  modelId: "scout-1",
};
const other: SessionModelSelection = {
  provider: "acme",
  modelId: "scout-2",
};

test("default scout validation clears on null and trims", () => {
  expect(expectDefaultScoutModelSelection(null)).toBeNull();
  expect(expectDefaultScoutModelSelection({ provider: "  acme ", modelId: " s " })).toEqual({
    provider: "acme",
    modelId: "s",
  });
  expect(() => expectDefaultScoutModelSelection({ provider: "", modelId: "s" })).toThrow();
  expect(() => expectDefaultScoutModelSelection({ provider: "a" })).toThrow();
  expect(() => expectDefaultScoutModelSelection("acme")).toThrow();
});

test("absent and cleared compare equal; same selection is unchanged", () => {
  const absent: DefaultScoutModel = undefined;
  expect(isDefaultScoutModelEqual(absent, undefined)).toBe(true);
  expect(isDefaultScoutModelEqual(absent, null)).toBe(true);
  expect(isDefaultScoutModelEqual(scout, scout)).toBe(true);
  expect(isDefaultScoutModelEqual({ ...scout }, { ...scout })).toBe(true);
});

test("set and cleared states compare unequal", () => {
  expect(isDefaultScoutModelEqual(undefined, scout)).toBe(false);
  expect(isDefaultScoutModelEqual(scout, null)).toBe(false);
  expect(isDefaultScoutModelEqual(scout, undefined)).toBe(false);
  expect(isDefaultScoutModelEqual(scout, other)).toBe(false);
  expect(isDefaultScoutModelEqual(scout, { provider: "other", modelId: scout.modelId })).toBe(
    false,
  );
});
