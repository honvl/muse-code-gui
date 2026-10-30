import { expect, test } from "@playwright/test";
import type { SessionCatalogEntry } from "@pi-gui/catalogs";
import { mergeSessionListings } from "../../electron/application/app-store-utils";
import { threadDisplayTitle, type ThreadListEntry } from "../../src/features/threads/thread-groups";

function catalogEntry(
  sessionId: string,
  title: string,
  status: SessionCatalogEntry["status"] = "idle",
): SessionCatalogEntry {
  return {
    sessionRef: { workspaceId: "ws", sessionId },
    workspaceId: "ws",
    title,
    updatedAt: "2026-10-29T17:39:32.123Z",
    sessionFilePath: `/tmp/muse-sessions/${sessionId}.json`,
    status,
  };
}

function threadEntry(sessionTitle: string, childTitle?: string): ThreadListEntry {
  return {
    folderId: "ws",
    workspaceId: "ws",
    session: {
      id: "child-session",
      title: sessionTitle,
      updatedAt: "2026-10-29T17:39:32.123Z",
      preview: "",
      status: "idle",
      hasUnseenUpdate: false,
    },
    environment: { kind: "local", label: "Local" },
    contextLabel: "ws",
    ...(childTitle !== undefined
      ? {
          child: {
            id: "child-1",
            status: "complete",
            parentKey: "ws:parent-session",
            title: childTitle,
          },
        }
      : {}),
  };
}

test("mergeSessionListings keeps pi's title when the Muse entry is blank", () => {
  const merged = mergeSessionListings(
    [catalogEntry("muse-1", "In /Users/honvl/pi-gui, read apps/de…")],
    [{ ...catalogEntry("muse-1", "", "running") }],
  );
  expect(merged).toHaveLength(1);
  // pi's stored title survives, with the live Muse status.
  expect(merged[0]?.title).toBe("In /Users/honvl/pi-gui, read apps/de…");
  expect(merged[0]?.status).toBe("running");
});

test("mergeSessionListings still lets a titled Muse entry win", () => {
  const merged = mergeSessionListings(
    [catalogEntry("muse-1", "stale pi title")],
    [catalogEntry("muse-1", "fresh Muse title", "running")],
  );
  expect(merged).toHaveLength(1);
  expect(merged[0]?.title).toBe("fresh Muse title");
  expect(merged[0]?.status).toBe("running");
});

test("threadDisplayTitle falls back to the orchestration child title", () => {
  expect(threadDisplayTitle(threadEntry("catalog title", "child title"))).toBe("catalog title");
  expect(threadDisplayTitle(threadEntry("", "child title"))).toBe("child title");
  expect(threadDisplayTitle(threadEntry("  ", "child title"))).toBe("child title");
  expect(threadDisplayTitle(threadEntry("", ""))).toBe("");
  expect(threadDisplayTitle(threadEntry("catalog title"))).toBe("catalog title");
});
