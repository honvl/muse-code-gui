import { expect, test } from "@playwright/test";
import {
  createEmptyDesktopAppState,
  type DesktopAppState,
  type OrchestrationChildThread,
  type SessionRecord,
  type WorkspaceRecord,
} from "../../contracts/desktop-state";
import {
  buildThreadSidebarModel,
  sessionThreadKey,
  summarizeChildGroup,
} from "../../src/features/threads/thread-groups";
import { childThreadFinalDetail } from "../../electron/orchestration/app-store-orchestration";

function session(
  id: string,
  title: string,
  updatedAt: string,
  extra: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    title,
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    updatedAt,
    ...extra,
  };
}

function workspace(id: string, sessions: readonly SessionRecord[]): WorkspaceRecord {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    kind: "primary",
    sessions,
  };
}

function child(
  id: string,
  parentSessionId: string,
  childSessionId: string,
  status: OrchestrationChildThread["status"],
  extra: Partial<OrchestrationChildThread> = {},
): OrchestrationChildThread {
  return {
    id,
    parentWorkspaceId: "ws",
    parentSessionId,
    childWorkspaceId: "ws",
    childSessionId,
    title: `Child ${id}`,
    goal: "do work",
    mode: "worker",
    depth: 1,
    status,
    latestTranscript: "",
    transcript: [],
    evidence: [],
    createdAt: "2026-09-21T12:00:00.000Z",
    updatedAt: "2026-09-21T12:00:00.000Z",
    ...extra,
  };
}

function state(
  workspaces: readonly WorkspaceRecord[],
  orchestrationChildren: readonly OrchestrationChildThread[] = [],
): DesktopAppState {
  return {
    ...createEmptyDesktopAppState(),
    workspaces,
    workspaceOrder: workspaces.map((entry) => entry.id),
    orchestrationChildren,
  };
}

const NOW = new Date(2026, 8, 21, 15, 0, 0).getTime();

test("child sessions nest under their parent and leave top-level history", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace("ws", [
          session("parent", "Parent", "2026-09-21T14:00:00.000Z"),
          session("kid", "Kid", "2026-09-21T14:30:00.000Z"),
          session("other", "Other", "2026-09-21T13:00:00.000Z"),
        ]),
      ],
      [child("c1", "parent", "kid", "running")],
    ),
    NOW,
  );

  const group = model.workspaceGroups.find((entry) => entry.workspace.id === "ws");
  expect(group?.threads.map((thread) => thread.session.id)).toEqual(["parent", "other"]);
  expect(model.childrenByParentKey.get("ws:parent")?.map((thread) => thread.session.id)).toEqual([
    "kid",
  ]);
  const nested = model.childrenByParentKey.get("ws:parent")?.[0];
  expect(nested?.child).toMatchObject({ id: "c1", status: "running", parentKey: "ws:parent" });
  // Quick-switch order still lists the child for direct jumps.
  expect(model.recencyOrder.map((thread) => thread.session.id)).toContain("kid");
  expect(sessionThreadKey(nested!)).toBe("ws:kid");
});

test("children sort oldest-first and orphans are ignored", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace("ws", [
          session("parent", "Parent", "2026-09-21T14:00:00.000Z"),
          session("newer", "Newer", "2026-09-21T14:30:00.000Z"),
          session("older", "Older", "2026-09-21T14:10:00.000Z"),
        ]),
      ],
      [
        child("c-new", "parent", "newer", "running"),
        child("c-old", "parent", "older", "complete"),
        child("c-ghost", "parent", "missing", "running"),
      ],
    ),
    NOW,
  );

  expect(model.childrenByParentKey.get("ws:parent")?.map((thread) => thread.session.id)).toEqual([
    "older",
    "newer",
  ]);
});

test("pinned and archived children keep their top-level rows", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace("ws", [
          session("parent", "Parent", "2026-09-21T14:00:00.000Z"),
          session("pinned-kid", "Pinned", "2026-09-21T14:30:00.000Z", {
            pinnedAt: "2026-09-21T14:31:00.000Z",
          }),
          session("archived-kid", "Archived", "2026-09-21T14:20:00.000Z", {
            archivedAt: "2026-09-21T14:25:00.000Z",
          }),
        ]),
      ],
      [
        child("c-pin", "parent", "pinned-kid", "running"),
        child("c-arch", "parent", "archived-kid", "complete"),
      ],
    ),
    NOW,
  );

  expect(model.pinnedThreads.map((thread) => thread.session.id)).toContain("pinned-kid");
  expect(model.archivedThreads.map((thread) => thread.session.id)).toContain("archived-kid");
  expect(model.childrenByParentKey.get("ws:parent") ?? []).toEqual([]);
});

test("grandchild chains group under their direct parent", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace("ws", [
          session("parent", "Parent", "2026-09-21T14:00:00.000Z"),
          session("kid", "Kid", "2026-09-21T14:30:00.000Z"),
          session("grandkid", "Grandkid", "2026-09-21T14:40:00.000Z"),
        ]),
      ],
      [
        child("c1", "parent", "kid", "complete"),
        child("c2", "kid", "grandkid", "running", { depth: 2 }),
      ],
    ),
    NOW,
  );

  expect(model.childrenByParentKey.get("ws:parent")?.map((thread) => thread.session.id)).toEqual([
    "kid",
  ]);
  expect(model.childrenByParentKey.get("ws:kid")?.map((thread) => thread.session.id)).toEqual([
    "grandkid",
  ]);
});

test("summarizeChildGroup is empty when there are no children", () => {
  expect(summarizeChildGroup([])).toEqual({ count: 0, running: 0, failed: 0 });
});

test("summarizeChildGroup counts entries and live statuses", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace("ws", [
          session("parent", "Parent", "2026-09-21T14:00:00.000Z"),
          session("a", "A", "2026-09-21T14:10:00.000Z", { status: "running" }),
          session("b", "B", "2026-09-21T14:20:00.000Z", { status: "failed" }),
          session("c", "C", "2026-09-21T14:30:00.000Z"),
        ]),
      ],
      [
        child("c-a", "parent", "a", "running"),
        child("c-b", "parent", "b", "failed"),
        child("c-c", "parent", "c", "complete"),
      ],
    ),
    NOW,
  );

  const kids = model.childrenByParentKey.get("ws:parent") ?? [];
  expect(summarizeChildGroup(kids)).toEqual({ count: 3, running: 1, failed: 1 });
});

test("summarizeChildGroup sees orchestration status when the session row is idle", () => {
  const model = buildThreadSidebarModel(
    state(
      [
        workspace("ws", [
          session("parent", "Parent", "2026-09-21T14:00:00.000Z"),
          session("kid", "Kid", "2026-09-21T14:30:00.000Z"),
        ]),
      ],
      [child("c1", "parent", "kid", "running")],
    ),
    NOW,
  );

  const kids = model.childrenByParentKey.get("ws:parent") ?? [];
  expect(kids).toHaveLength(1);
  expect(summarizeChildGroup(kids)).toEqual({ count: 1, running: 1, failed: 0 });
});

test("childThreadFinalDetail reports completion and failure", () => {
  expect(childThreadFinalDetail({ title: "Scout api", status: "complete" })).toBe(
    'Child thread "Scout api" completed.',
  );
  expect(childThreadFinalDetail({ title: "Scout api", status: "failed" })).toBe(
    'Child thread "Scout api" failed.',
  );
});
