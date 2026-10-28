import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  readPersistedUiState,
  writePersistedUiState,
} from "../../electron/persistence/app-store-persistence";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";
import { AttachmentStore } from "../../electron/persistence/attachment-store";

for (const invalid of [
  { version: 99, composerDraft: "future data" },
  { version: 15, composerDraftsBySession: { one: 42 } },
  { version: 15, workspaceOrder: ["valid", null] },
  { version: 15, orchestrationChildren: [null] },
  { version: 15, appGlobalModelSettings: { defaultThinkingLevel: "unknown" } },
  { version: 15, futureData: "retain" },
  { version: 15, notificationPreferences: { futureSetting: true } },
  { version: 16, lastInteractedAtBySession: { one: 42 } },
  { version: 17, threadGrouping: "priority" },
  { version: 19, extensionFlagsByWorkspace: { ws: { retries: 3 } } },
  { version: 19, extensionFlagsBySession: { "ws:sess": ["plan"] } },
  { version: 19, collapsedWorkspaceIds: ["alpha", 42] },
  { version: 19, sidekickBySession: { "ws:sess": { provider: "", modelId: "x" } } },
  { version: 19, sidekickBySession: { "ws:sess": "acme" } },
  [],
]) {
  test(`preserves invalid UI state ${JSON.stringify(invalid)}`, async () => {
    const path = join(await mkdtemp(join(tmpdir(), "ui-state-validation-")), "ui-state.json");
    const original = JSON.stringify(invalid);
    await writeFile(path, original);
    await expect(readPersistedUiState(path)).rejects.toThrow(/Invalid ui-state/);
    await expect(writePersistedUiState(path, { composerDraft: "replacement" })).rejects.toThrow(
      /Invalid ui-state/,
    );
    expect(await readFile(path, "utf8")).toBe(original);
  });
}

test("reads v15 ui-state without lastInteractedAt and writes v18", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-recency-")), "ui-state.json");
  await writeFile(path, JSON.stringify({ version: 15, composerDraft: "kept" }));
  const decoded = await readPersistedUiState(path);
  expect(decoded.version).toBe(15);
  expect(decoded.lastInteractedAtBySession).toBeUndefined();
  await writePersistedUiState(path, {
    composerDraft: "kept",
    lastInteractedAtBySession: { "ws:sess": "2026-09-21T12:00:00.000Z" },
  });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    lastInteractedAtBySession: Record<string, string>;
  };
  expect(written.version).toBe(19);
  expect(written.lastInteractedAtBySession).toEqual({ "ws:sess": "2026-09-21T12:00:00.000Z" });
});

test("reads v16 ui-state without threadGrouping and writes the saved choice as v18", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-grouping-")), "ui-state.json");
  await writeFile(path, JSON.stringify({ version: 16, composerDraft: "kept" }));
  const decoded = await readPersistedUiState(path);
  expect(decoded.version).toBe(16);
  expect(decoded.threadGrouping).toBeUndefined();
  await writePersistedUiState(path, {
    composerDraft: "kept",
    threadGrouping: "workspace",
  });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    threadGrouping: string;
  };
  expect(written.version).toBe(19);
  expect(written.threadGrouping).toBe("workspace");
});

test("extension flag defaults and per-thread flags round-trip through ui-state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-flags-")), "ui-state.json");
  await writePersistedUiState(path, {
    extensionFlagsByWorkspace: { ws: { plan: true, "dry-run": false, env: "" } },
    extensionFlagsBySession: { "ws:sess": { plan: true }, "ws:empty": {} },
  });
  const decoded = await readPersistedUiState(path);
  expect(decoded.extensionFlagsByWorkspace).toEqual({
    ws: { plan: true, "dry-run": false, env: "" },
  });
  expect(decoded.extensionFlagsBySession).toEqual({ "ws:sess": { plan: true } });
});

test("reads ui-state without folded folders and writes the collapsed ids", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-collapsed-")), "ui-state.json");
  await writeFile(path, JSON.stringify({ version: 15, composerDraft: "kept" }));
  expect((await readPersistedUiState(path)).collapsedWorkspaceIds).toBeUndefined();
  await writePersistedUiState(path, { composerDraft: "kept", collapsedWorkspaceIds: ["alpha"] });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    collapsedWorkspaceIds: readonly string[];
  };
  expect(written.version).toBe(19);
  expect(written.collapsedWorkspaceIds).toEqual(["alpha"]);
  expect((await readPersistedUiState(path)).collapsedWorkspaceIds).toEqual(["alpha"]);
});

test("backup recovery retains damaged bytes and the good backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ui-state-backup-"));
  const path = join(dir, "ui-state.json");
  const good = JSON.stringify({ version: 15, composerDraft: "retained draft" });
  await writeFile(`${path}.bak`, good);
  await writeFile(path, "{damaged");
  expect((await readPersistedUiState(path)).composerDraft).toBe("retained draft");
  await writePersistedUiState(path, { composerDraft: "retained draft" });
  expect(await readFile(`${path}.bak`, "utf8")).toBe(good);
  const preserved = (await readdir(dir)).filter((name) =>
    name.startsWith("ui-state.json.corrupt."),
  );
  expect(preserved).toHaveLength(1);
  expect(await readFile(join(dir, preserved[0]!), "utf8")).toBe("{damaged");
});

test("unrecoverable syntax errors cannot be overwritten", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-broken-")), "ui-state.json");
  await writeFile(path, "{damaged");
  await expect(readPersistedUiState(path)).rejects.toThrow(/original data was retained/);
  await expect(writePersistedUiState(path, {})).rejects.toThrow(/Cannot overwrite/);
  expect(await readFile(path, "utf8")).toBe("{damaged");
});

test("attachment owner rejects malformed entries before read, replacement or pruning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attachment-validation-"));
  const store = new AttachmentStore(dir);
  const valid = {
    id: "one",
    kind: "image" as const,
    name: "image.png",
    mimeType: "image/png",
    data: "eA==",
  };
  await store.write("session", [valid]);
  const path = join(dir, "attachments", "session.json");
  const original = JSON.stringify([valid, null]);
  await writeFile(path, original);
  await expect(store.read("session")).rejects.toThrow(/Invalid saved attachment/);
  await expect(store.write("session", [])).rejects.toThrow(/Invalid saved attachment/);
  await expect(store.remove("session")).rejects.toThrow(/Invalid saved attachment/);
  expect(await readFile(path, "utf8")).toBe(original);
  await writeFile(
    path,
    JSON.stringify([
      { id: valid.id, name: valid.name, mimeType: valid.mimeType, data: valid.data },
    ]),
  );
  expect(await store.read("session")).toEqual([valid]);
});

function childThread(overrides: Partial<OrchestrationChildThread> = {}): OrchestrationChildThread {
  return {
    id: "child-1",
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: "child",
    title: "Scout the repo",
    goal: "Find the thing",
    mode: "scout",
    depth: 2,
    status: "running",
    latestTranscript: "working",
    transcript: [],
    evidence: [],
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:01:00.000Z",
    ...overrides,
  };
}

test("sidekick model selections round-trip through ui-state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-sidekick-")), "ui-state.json");
  await writePersistedUiState(path, {
    sidekickBySession: { "ws:sess": { provider: "acme", modelId: "sidekick-1" } },
  });
  const decoded = await readPersistedUiState(path);
  expect(decoded.sidekickBySession).toEqual({
    "ws:sess": { provider: "acme", modelId: "sidekick-1" },
  });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    sidekickBySession: Record<string, { provider: string; modelId: string }>;
  };
  expect(written.version).toBe(19);
  expect(written.sidekickBySession).toEqual({
    "ws:sess": { provider: "acme", modelId: "sidekick-1" },
  });
});

test("orchestration child mode and depth round-trip through ui-state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-mode-")), "ui-state.json");
  await writePersistedUiState(path, {
    orchestrationChildren: [
      childThread(),
      childThread({ id: "child-2", mode: "worker", depth: 1 }),
    ],
  });
  const decoded = await readPersistedUiState(path);
  expect(decoded.orchestrationChildren).toHaveLength(2);
  expect(decoded.orchestrationChildren?.[0]?.mode).toBe("scout");
  expect(decoded.orchestrationChildren?.[0]?.depth).toBe(2);
  expect(decoded.orchestrationChildren?.[1]?.mode).toBe("worker");
  expect(decoded.orchestrationChildren?.[1]?.depth).toBe(1);
});

test("orchestration child rejects unknown mode and bad depth", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-mode-bad-")), "ui-state.json");
  await expect(
    writePersistedUiState(path, {
      orchestrationChildren: [
        childThread({ mode: "admin" as unknown as OrchestrationChildThread["mode"] }),
      ],
    }),
  ).rejects.toThrow(/Invalid ui-state field orchestrationChildren\[0\]\.mode/);
  await expect(
    writePersistedUiState(path, { orchestrationChildren: [childThread({ depth: -1 })] }),
  ).rejects.toThrow(/Invalid ui-state field orchestrationChildren\[0\]\.depth/);
  await expect(
    writePersistedUiState(path, { orchestrationChildren: [childThread({ depth: 1.5 })] }),
  ).rejects.toThrow(/Invalid ui-state field orchestrationChildren\[0\]\.depth/);
});

test("unknown attachment fields survive rejected replacement and pruning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attachment-unknown-"));
  const store = new AttachmentStore(dir);
  await store.write("session", []);
  const path = join(dir, "attachments", "session.json");
  const original = JSON.stringify([
    { id: "one", name: "image.png", mimeType: "image/png", data: "eA==", futureData: "retain" },
  ]);
  await writeFile(path, original);
  await expect(store.read("session")).rejects.toThrow(/unsupported field/);
  await expect(store.write("session", [])).rejects.toThrow(/unsupported field/);
  await expect(store.remove("session")).rejects.toThrow(/unsupported field/);
  expect(await readFile(path, "utf8")).toBe(original);
});
