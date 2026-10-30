import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionCatalogEntry } from "@pi-gui/catalogs";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  DEFAULT_MUSE_SESSION_TITLE,
  MuseCliDriver,
  resolveMuseRecordTitle,
} from "../dist/index.js";

const sessionKey = (ref: SessionRef): string => `${ref.workspaceId}:${ref.sessionId}`;

/** In-memory stand-in for the shared catalog, capturing every upsert. */
function stubCatalog() {
  const sessions = new Map<string, SessionCatalogEntry>();
  const upserts: SessionCatalogEntry[] = [];
  return {
    upserts,
    seed(entry: SessionCatalogEntry): void {
      sessions.set(sessionKey(entry.sessionRef), entry);
    },
    read(ref: SessionRef): SessionCatalogEntry | undefined {
      return sessions.get(sessionKey(ref));
    },
    storage: {
      sessions: {
        async getSession(ref: SessionRef): Promise<SessionCatalogEntry | undefined> {
          return sessions.get(sessionKey(ref));
        },
        async upsertSession(entry: SessionCatalogEntry): Promise<void> {
          upserts.push(entry);
          sessions.set(sessionKey(entry.sessionRef), entry);
        },
      },
      workspaces: {
        async getWorkspace(workspaceId: string): Promise<{ path: string } | undefined> {
          return workspaceId === "ws" ? { path: tmpdir() } : undefined;
        },
      },
    },
  };
}

function writeMarker(dir: string, sessionId: string, payload: Record<string, unknown>): void {
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(payload), "utf8");
}

/** A stub `muse` whose export always fails, like a session Muse hasn't written yet. */
function stubBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-stub-"));
  const bin = join(dir, "muse");
  writeFileSync(bin, "#!/bin/sh\necho 'no such session' >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  return bin;
}

const GOOD_TITLE = "In /Users/honvl/pi-gui, read apps/de…";

await test("resolveMuseRecordTitle prefers catalog, marker, orchestration, prompt, default", () => {
  assert.equal(resolveMuseRecordTitle({ catalogTitle: "  kept  " }), "kept");
  assert.equal(resolveMuseRecordTitle({ catalogTitle: "  ", markerTitle: GOOD_TITLE }), GOOD_TITLE);
  assert.equal(
    resolveMuseRecordTitle({ markerTitle: "", orchestrationTitle: "child title" }),
    "child title",
  );
  assert.equal(
    resolveMuseRecordTitle({
      transcript: [
        {
          kind: "message",
          role: "user",
          text: "do the thing",
          createdAt: "t",
          id: "u1",
        },
      ],
    }),
    "do the thing",
  );
  assert.equal(resolveMuseRecordTitle({}), DEFAULT_MUSE_SESSION_TITLE);
});

await test("subscribe-then-persist never blanks a stored catalog title", async () => {
  const catalog = stubCatalog();
  const sessionFileDir = mkdtempSync(join(tmpdir(), "muse-markers-"));
  const ref: SessionRef = { workspaceId: "ws", sessionId: "session-1" };
  catalog.seed({
    sessionRef: { ...ref },
    workspaceId: "ws",
    title: GOOD_TITLE,
    updatedAt: "2026-10-29T17:00:00.000Z",
    sessionFilePath: join(sessionFileDir, "session-1.json"),
    status: "idle",
  });
  writeMarker(sessionFileDir, "session-1", {
    version: 2,
    museSessionId: "session-1",
    workspaceId: "ws",
    title: GOOD_TITLE,
    updatedAt: "2026-10-29T17:00:00.000Z",
  });
  const driver = new MuseCliDriver({
    binaryPath: stubBinary(),
    catalogStorage: catalog.storage,
    sessionFileDir,
  });

  // Restart shape: subscribe creates the sync shell record (title ""), and a
  // later persist (archive here; turn-end in production) must not upsert ""
  // over the stored title.
  driver.subscribe(ref, () => {});
  await driver.archiveSession(ref);

  const last = catalog.upserts.at(-1);
  assert.ok(last, "expected a catalog upsert");
  assert.equal(last.title, GOOD_TITLE);
  assert.equal(catalog.read(ref)?.title, GOOD_TITLE);
});

await test("a blank catalog title self-heals from the marker file", async () => {
  const catalog = stubCatalog();
  const sessionFileDir = mkdtempSync(join(tmpdir(), "muse-markers-"));
  const ref: SessionRef = { workspaceId: "ws", sessionId: "session-2" };
  catalog.seed({
    sessionRef: { ...ref },
    workspaceId: "ws",
    title: "",
    updatedAt: "2026-10-29T17:39:32.123Z",
    sessionFilePath: join(sessionFileDir, "session-2.json"),
    status: "idle",
  });
  // v1 markers predate workspaceId but still carry the title.
  writeMarker(sessionFileDir, "session-2", {
    version: 1,
    museSessionId: "session-2",
    title: GOOD_TITLE,
    updatedAt: "2026-10-29T17:00:00.000Z",
  });
  const driver = new MuseCliDriver({
    binaryPath: stubBinary(),
    catalogStorage: catalog.storage,
    sessionFileDir,
  });

  driver.subscribe(ref, () => {});
  await driver.archiveSession(ref);

  assert.equal(catalog.upserts.at(-1)?.title, GOOD_TITLE);
});

await test("restart listing keeps the marker title even with a live shell record", async () => {
  const catalog = stubCatalog();
  const sessionFileDir = mkdtempSync(join(tmpdir(), "muse-markers-"));
  const ref: SessionRef = { workspaceId: "ws", sessionId: "session-3" };
  writeMarker(sessionFileDir, "session-3", {
    version: 2,
    museSessionId: "session-3",
    workspaceId: "ws",
    title: GOOD_TITLE,
    updatedAt: "2026-10-29T17:00:00.000Z",
  });
  const driver = new MuseCliDriver({
    binaryPath: stubBinary(),
    catalogStorage: catalog.storage,
    sessionFileDir,
  });

  const before = await driver.listSessions();
  assert.equal(before.sessions[0]?.title, GOOD_TITLE);

  driver.subscribe(ref, () => {});
  const after = await driver.listSessions();
  assert.equal(after.sessions.length, 1);
  assert.equal(after.sessions[0]?.title, GOOD_TITLE);
});

await test("openSession falls back to the orchestration child title, then the default", async () => {
  const catalog = stubCatalog();
  const sessionFileDir = mkdtempSync(join(tmpdir(), "muse-markers-"));
  const withChild = new MuseCliDriver({
    binaryPath: stubBinary(),
    catalogStorage: catalog.storage,
    sessionFileDir,
    resolveOrchestrationTitle: (ref: SessionRef) =>
      ref.sessionId === "session-4" ? "orchestration child title" : undefined,
  });
  const withoutChild = new MuseCliDriver({
    binaryPath: stubBinary(),
    catalogStorage: catalog.storage,
    sessionFileDir,
  });

  const healed = await withChild.openSession({ workspaceId: "ws", sessionId: "session-4" });
  assert.equal(healed.title, "orchestration child title");

  const fallback = await withoutChild.openSession({ workspaceId: "ws", sessionId: "session-5" });
  assert.equal(fallback.title, DEFAULT_MUSE_SESSION_TITLE);
});
test("a stored placeholder title does not block healing to the real title", async () => {
  const { resolveMuseRecordTitle, DEFAULT_MUSE_SESSION_TITLE } = await import("../dist/index.js");
  assert.equal(
    resolveMuseRecordTitle({
      catalogTitle: DEFAULT_MUSE_SESSION_TITLE,
      markerTitle: "Real task title",
    }),
    "Real task title",
  );
  assert.equal(resolveMuseRecordTitle({ catalogTitle: "" }), DEFAULT_MUSE_SESSION_TITLE);
});
