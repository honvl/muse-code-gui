import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  readPersistedUiState,
  writePersistedUiState,
} from "../../electron/persistence/app-store-persistence";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";
import { toPersistedOrchestrationChildren } from "../../electron/orchestration/app-store-orchestration";
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
  { version: 19, defaultLeadModel: { provider: "", modelId: "x" } },
  { version: 19, defaultLeadModel: { provider: "acme", modelId: "" } },
  { version: 19, defaultLeadModel: { provider: "acme" } },
  { version: 19, defaultLeadModel: "acme" },
  { version: 19, defaultScoutModel: { provider: "", modelId: "x" } },
  { version: 19, defaultScoutModel: { provider: "acme", modelId: "" } },
  { version: 19, defaultScoutModel: { provider: "acme" } },
  { version: 19, defaultScoutModel: "acme" },
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
  expect(written.version).toBe(21);
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
  expect(written.version).toBe(21);
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
  expect(written.version).toBe(21);
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
  expect(written.version).toBe(21);
  expect(written.sidekickBySession).toEqual({
    "ws:sess": { provider: "acme", modelId: "sidekick-1" },
  });
});

test("default lead model round-trips through ui-state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-default-lead-")), "ui-state.json");
  await writePersistedUiState(path, {
    defaultLeadModel: { provider: "acme", modelId: "lead-1" },
  });
  const decoded = await readPersistedUiState(path);
  expect(decoded.defaultLeadModel).toEqual({ provider: "acme", modelId: "lead-1" });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    defaultLeadModel: { provider: string; modelId: string };
  };
  expect(written.version).toBe(21);
  expect(written.defaultLeadModel).toEqual({ provider: "acme", modelId: "lead-1" });
});

test("ui-state without default lead model loads as absent", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-no-default-lead-")), "ui-state.json");
  await writeFile(path, JSON.stringify({ version: 15, composerDraft: "kept" }));
  expect((await readPersistedUiState(path)).defaultLeadModel).toBeUndefined();
  await writePersistedUiState(path, { composerDraft: "kept" });
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect("defaultLeadModel" in written).toBe(false);
  expect((await readPersistedUiState(path)).defaultLeadModel).toBeUndefined();
});

test("default scout model round-trips through ui-state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-default-scout-")), "ui-state.json");
  await writePersistedUiState(path, {
    defaultScoutModel: { provider: "acme", modelId: "scout-1" },
  });
  const decoded = await readPersistedUiState(path);
  expect(decoded.defaultScoutModel).toEqual({ provider: "acme", modelId: "scout-1" });
  const written = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    defaultScoutModel: { provider: string; modelId: string };
  };
  expect(written.version).toBe(21);
  expect(written.defaultScoutModel).toEqual({ provider: "acme", modelId: "scout-1" });
});

test("ui-state without default scout model loads as absent", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-no-default-scout-")), "ui-state.json");
  await writeFile(path, JSON.stringify({ version: 15, composerDraft: "kept" }));
  expect((await readPersistedUiState(path)).defaultScoutModel).toBeUndefined();
  await writePersistedUiState(path, { composerDraft: "kept" });
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect("defaultScoutModel" in written).toBe(false);
  expect((await readPersistedUiState(path)).defaultScoutModel).toBeUndefined();
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

test("orchestration child write scopes round-trip through ui-state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-scopes-")), "ui-state.json");
  await writePersistedUiState(path, {
    orchestrationChildren: [
      childThread({ mode: "worker", writeScopes: ["apps/a", "packages/b"] }),
      childThread({ id: "child-2", mode: "worker", writeScopes: [] }),
    ],
  });
  const written = JSON.parse(await readFile(path, "utf8")) as { version: number };
  expect(written.version).toBe(21);
  const decoded = await readPersistedUiState(path);
  expect(decoded.orchestrationChildren?.[0]?.writeScopes).toEqual(["apps/a", "packages/b"]);
  expect(decoded.orchestrationChildren?.[1]?.writeScopes).toEqual([]);
});

test("a v19 ui-state without write scopes loads its workers as whole-workspace", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-scopes-v19-")), "ui-state.json");
  const original = JSON.stringify({
    version: 19,
    orchestrationChildren: [childThread({ mode: "worker", status: "running" })],
  });
  await writeFile(path, original);
  const decoded = await readPersistedUiState(path);
  expect(decoded.version).toBe(19);
  expect(decoded.orchestrationChildren).toHaveLength(1);
  // Missing means [] (the whole workspace): see existingChildWriteScopes.
  expect(decoded.orchestrationChildren?.[0]?.writeScopes).toBeUndefined();
  await writePersistedUiState(path, { orchestrationChildren: decoded.orchestrationChildren });
  const rewritten = await readPersistedUiState(path);
  expect(rewritten.version).toBe(21);
  expect(rewritten.orchestrationChildren?.[0]?.writeScopes).toBeUndefined();
  // The first v21 write keeps the exact v19 bytes, so a downgrade can restore them.
  const dir = join(path, "..");
  const copies = (await readdir(dir)).filter((name) =>
    /^ui-state\.pre-workbench-v19\..+\.json$/.test(name),
  );
  expect(copies).toHaveLength(1);
  expect(await readFile(join(dir, copies[0]!), "utf8")).toBe(original);
});

test("orchestration child write scopes reject malformed values and pre-v20 files", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-scopes-bad-")), "ui-state.json");
  await expect(
    writePersistedUiState(path, {
      orchestrationChildren: [
        childThread({ writeScopes: ["apps/a", 3] as unknown as readonly string[] }),
      ],
    }),
  ).rejects.toThrow(/Invalid ui-state field orchestrationChildren\[0\]\.writeScopes/);
  await expect(
    writePersistedUiState(path, { orchestrationChildren: [childThread({ writeScopes: [""] })] }),
  ).rejects.toThrow(/Invalid ui-state field orchestrationChildren\[0\]\.writeScopes/);
  const original = JSON.stringify({
    version: 19,
    orchestrationChildren: [childThread({ writeScopes: ["apps/a"] })],
  });
  await writeFile(path, original);
  await expect(readPersistedUiState(path)).rejects.toThrow(/writeScopes before v20/);
  expect(await readFile(path, "utf8")).toBe(original);
});

const WORKTREE_FIELDS = {
  worktreePath: "/repo/.worktrees/abcd1234",
  branch: "child/abcd1234",
  baseCommit: "0123456789abcdef0123456789abcdef01234567",
} as const;

test("worktree child fields round-trip through ui-state v21", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-worktree-")), "ui-state.json");
  await writePersistedUiState(path, {
    orchestrationChildren: [
      childThread({ mode: "worker", ...WORKTREE_FIELDS }),
      childThread({ id: "child-2", mode: "worker", writeScopes: ["apps/a"] }),
    ],
  });
  const written = JSON.parse(await readFile(path, "utf8")) as { version: number };
  expect(written.version).toBe(21);
  const decoded = await readPersistedUiState(path);
  expect(decoded.orchestrationChildren?.[0]).toMatchObject(WORKTREE_FIELDS);
  expect(decoded.orchestrationChildren?.[1]?.worktreePath).toBeUndefined();
  expect(decoded.orchestrationChildren?.[1]?.branch).toBeUndefined();
});

test("a v20 ui-state without worktree fields loads its children as shared-checkout", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-worktree-v20-")), "ui-state.json");
  const original = JSON.stringify({
    version: 20,
    orchestrationChildren: [childThread({ mode: "worker", writeScopes: ["apps/a"] })],
  });
  await writeFile(path, original);
  const decoded = await readPersistedUiState(path);
  expect(decoded.version).toBe(20);
  expect(decoded.orchestrationChildren?.[0]?.writeScopes).toEqual(["apps/a"]);
  expect(decoded.orchestrationChildren?.[0]?.worktreePath).toBeUndefined();
  await writePersistedUiState(path, { orchestrationChildren: decoded.orchestrationChildren });
  expect((await readPersistedUiState(path)).version).toBe(21);
  const dir = join(path, "..");
  const copies = (await readdir(dir)).filter((name) =>
    /^ui-state\.pre-workbench-v20\..+\.json$/.test(name),
  );
  expect(copies).toHaveLength(1);
  expect(await readFile(join(dir, copies[0]!), "utf8")).toBe(original);
});

test("worktree child fields reject partial or malformed values and pre-v21 files", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-worktree-bad-")), "ui-state.json");
  await expect(
    writePersistedUiState(path, {
      orchestrationChildren: [childThread({ worktreePath: "/repo/.worktrees/x" })],
    }),
  ).rejects.toThrow(/Invalid ui-state field orchestrationChildren\[0\]\.worktree fields/);
  await expect(
    writePersistedUiState(path, {
      orchestrationChildren: [childThread({ ...WORKTREE_FIELDS, baseCommit: "HEAD" })],
    }),
  ).rejects.toThrow(/Invalid ui-state field orchestrationChildren\[0\]\.baseCommit/);
  await expect(
    writePersistedUiState(path, {
      orchestrationChildren: [childThread({ ...WORKTREE_FIELDS, branch: "" })],
    }),
  ).rejects.toThrow(/Invalid ui-state field orchestrationChildren\[0\]\.branch/);
  const original = JSON.stringify({
    version: 20,
    orchestrationChildren: [childThread({ ...WORKTREE_FIELDS })],
  });
  await writeFile(path, original);
  await expect(readPersistedUiState(path)).rejects.toThrow(/worktree fields before v21/);
  expect(await readFile(path, "utf8")).toBe(original);
});

test("a ui-state saved with the removed supervision loop still loads", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-legacy-supervision-")), "ui-state.json");
  // The app-owned supervision loop was removed; files written before that still
  // carry the field. Unknown keys fail validation, so this pins the legacy
  // allowlist that keeps those files loadable.
  const legacy = {
    ...childThread(),
    supervisionLoop: {
      id: "loop-1",
      status: "monitoring",
      gate: "continue",
      intervalMs: 60000,
      iterationCount: 3,
      lastCheckedAt: "2026-10-27T20:00:00.000Z",
      reason: "Monitoring child thread.",
      lastChildStatus: "running",
    },
  };
  const raw = { version: 19, orchestrationChildren: [legacy] };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify(raw), "utf8");
  const decoded = await readPersistedUiState(path);
  expect(decoded.orchestrationChildren).toHaveLength(1);
  expect(decoded.orchestrationChildren?.[0]?.id).toBe(legacy.id);
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

function evidenceRow(
  id: string,
  source: OrchestrationChildThread["evidence"][number]["source"] = "worker-reported",
) {
  return {
    id,
    childThreadId: "child-1",
    kind: "worker_report" as const,
    source,
    status: "reported" as const,
    title: "Worker reported output",
    detail: "x".repeat(4_000),
    parentSessionId: "parent",
    childSessionId: "child",
    createdAt: "2026-10-27T00:00:00.000Z",
  };
}

test("derived evidence is not persisted; only the creation record survives", () => {
  // The projection to a saved shape lives in toPersistedOrchestrationChildren;
  // writePersistedUiState stores whatever it is handed.
  const persisted = toPersistedOrchestrationChildren([
    childThread({
      evidence: [
        evidenceRow("derived-1"),
        evidenceRow("derived-2", "orchestrator-observed"),
        evidenceRow("creation-1", "orchestrator-accepted"),
      ],
    }),
  ]);
  // Evidence re-derives from transcripts on load, so only the creation record
  // (git context that no transcript can reproduce) is kept on disk.
  expect(persisted?.[0]?.evidence.map((row) => row.id)).toEqual(["creation-1"]);
  expect(persisted?.[0]?.evidence[0]?.childThreadId).toBe("child-1");
});

test("a child with a session does not persist its goal twice", () => {
  const persisted = toPersistedOrchestrationChildren([
    childThread({ goal: "g".repeat(5_000), latestTranscript: "g".repeat(5_000) }),
  ]);
  expect(persisted?.[0]?.latestTranscript).toBe("");
  expect(persisted?.[0]?.transcript).toEqual([]);
  // The goal itself is display text and stays.
  expect(persisted?.[0]?.goal).toHaveLength(5_000);
});

test("a saved child record round-trips once projected", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-state-child-projected-")), "ui-state.json");
  const projected = toPersistedOrchestrationChildren([
    childThread({
      evidence: [evidenceRow("derived-1"), evidenceRow("creation-1", "orchestrator-accepted")],
    }),
  ]);
  await writePersistedUiState(path, { orchestrationChildren: projected });
  const decoded = await readPersistedUiState(path);
  expect(decoded.orchestrationChildren?.[0]?.id).toBe("child-1");
  expect(decoded.orchestrationChildren?.[0]?.evidence.map((row) => row.id)).toEqual(["creation-1"]);
});

test("the saved child list is capped, keeping unfinished work first", () => {
  const running = Array.from({ length: 3 }, (_unused, index) =>
    childThread({
      id: `running-${index}`,
      status: "running",
      updatedAt: "2026-10-20T00:00:00.000Z",
    }),
  );
  const settled = Array.from({ length: 45 }, (_unused, index) =>
    childThread({
      id: `settled-${index}`,
      status: "complete",
      updatedAt: `2026-10-27T00:${String(index).padStart(2, "0")}:00.000Z`,
    }),
  );
  const persisted = toPersistedOrchestrationChildren([...settled, ...running]);
  const ids = persisted?.map((child) => child.id) ?? [];
  expect(ids).toHaveLength(40);
  // Dropping a running child would lose its record while its session continues.
  for (const child of running) {
    expect(ids).toContain(child.id);
  }
  // The newest settled records survive; the oldest age out.
  expect(ids).toContain("settled-44");
  expect(ids).not.toContain("settled-0");
});
