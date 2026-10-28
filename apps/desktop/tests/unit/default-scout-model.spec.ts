import { expect, test } from "@playwright/test";
import type { SessionModelSelection } from "@pi-gui/session-driver";
import {
  isDefaultScoutModelEqual,
  type DefaultScoutModel,
} from "../../electron/application/default-scout-model";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectDefaultScoutModelSelection,
  expectNullableThinkingLevel,
} from "../../electron/ipc/request-validation";
import {
  readPersistedUiState,
  writePersistedUiState,
} from "../../electron/persistence/app-store-persistence";

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

test("scout and sidekick reasoning validation clears on null and rejects unknown levels", () => {
  expect(expectNullableThinkingLevel(null)).toBeNull();
  expect(expectNullableThinkingLevel("minimal")).toBe("minimal");
  expect(expectNullableThinkingLevel("max")).toBe("max");
  expect(() => expectNullableThinkingLevel(undefined)).toThrow();
  expect(() => expectNullableThinkingLevel("extreme")).toThrow();
});

test("scout and sidekick reasoning round-trip through ui-state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-thinking-")), "ui-state.json");
  await writePersistedUiState(path, {
    defaultScoutThinkingLevel: "low",
    sidekickThinkingBySession: { "ws:lead": "medium" },
  });
  const decoded = await readPersistedUiState(path);
  expect(decoded.defaultScoutThinkingLevel).toBe("low");
  expect(decoded.sidekickThinkingBySession).toEqual({ "ws:lead": "medium" });
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(written.version).toBe(21);
});

test("ui-state without reasoning overrides loads as absent", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-no-child-thinking-")), "ui-state.json");
  await writeFile(path, JSON.stringify({ version: 19, composerDraft: "kept" }));
  const decoded = await readPersistedUiState(path);
  expect(decoded.defaultScoutThinkingLevel).toBeUndefined();
  expect(decoded.sidekickThinkingBySession).toBeUndefined();
});

for (const invalid of [
  { version: 20, defaultScoutThinkingLevel: "extreme" },
  { version: 20, defaultScoutThinkingLevel: 3 },
  { version: 20, sidekickThinkingBySession: { "ws:lead": "extreme" } },
  { version: 20, sidekickThinkingBySession: "low" },
]) {
  test(`preserves ui-state with invalid reasoning ${JSON.stringify(invalid)}`, async () => {
    const path = join(await mkdtemp(join(tmpdir(), "ui-state-bad-thinking-")), "ui-state.json");
    const original = JSON.stringify(invalid);
    await writeFile(path, original);
    await expect(readPersistedUiState(path)).rejects.toThrow(/Invalid ui-state/);
    expect(await readFile(path, "utf8")).toBe(original);
  });
}
