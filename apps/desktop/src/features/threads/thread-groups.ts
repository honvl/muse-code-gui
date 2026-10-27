import type {
  DesktopAppState,
  OrchestrationChildMode,
  OrchestrationChildThreadStatus,
  SessionRecord,
  ThreadGrouping,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import type { SessionUsageSnapshot } from "@pi-gui/session-driver";
import {
  compareByRecency,
  RECENCY_BUCKET_LABELS,
  RECENCY_BUCKET_ORDER,
  recencyBucketId,
  sessionLastInteractedAt,
  type RecencyBucketId,
} from "../../../contracts/thread-recency";

export interface ThreadEnvironmentMeta {
  readonly kind: "local" | "worktree";
  readonly label: string;
  readonly branchName?: string;
  readonly detached?: boolean;
}

export interface OrchestrationChildInfo {
  readonly id: string;
  readonly status: OrchestrationChildThreadStatus;
  readonly mode?: OrchestrationChildMode;
  /** `workspaceId:sessionId` of the parent thread. */
  readonly parentKey: string;
}

export interface ThreadListEntry {
  readonly folderId: string;
  readonly workspaceId: string;
  readonly session: SessionRecord;
  readonly environment: ThreadEnvironmentMeta;
  readonly contextLabel: string;
  readonly child?: OrchestrationChildInfo;
}

export interface WorkspaceThreadGroup {
  readonly workspace: WorkspaceRecord;
  readonly threads: readonly ThreadListEntry[];
}

export const THREAD_HISTORY_PREVIEW_LIMIT = 5;

export function threadHistoryPreview<T>(
  threads: readonly T[],
  expanded: boolean,
): { readonly visible: readonly T[]; readonly overflow: boolean } {
  const overflow = threads.length > THREAD_HISTORY_PREVIEW_LIMIT;
  return {
    visible: overflow && !expanded ? threads.slice(0, THREAD_HISTORY_PREVIEW_LIMIT) : threads,
    overflow,
  };
}

export interface RecencyThreadSection {
  readonly bucket: RecencyBucketId;
  readonly label: string;
  readonly threads: readonly ThreadListEntry[];
}

export interface SidebarPlanLimit {
  readonly provider: string;
  readonly windowMinutes: number;
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

export interface SidebarUsageSummary {
  /** Sessions contributing usage data. */
  readonly sessionCount: number;
  /** All-time tokens across those sessions, subscription included. */
  readonly totalTokens: number;
  /** Billed cost; subscription sessions never contribute (their cost is not money). */
  readonly billedCost: number;
  /** Tokens burned on subscription plans. */
  readonly subscriptionTokens: number;
  /** Tightest provider window first; one entry per provider window. */
  readonly planLimits: readonly SidebarPlanLimit[];
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return "0";
  }
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}K`;
  }
  return String(Math.round(tokens));
}

export function formatBilledCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) {
    return "$0";
  }
  return `$${cost < 10 ? cost.toFixed(2) : Math.round(cost).toString()}`;
}

export function formatPlanWindow(windowMinutes: number): string {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return "";
  }
  if (windowMinutes < 60) {
    return `${Math.round(windowMinutes)}m`;
  }
  if (windowMinutes < 24 * 60) {
    const hours = windowMinutes / 60;
    return `${Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10}h`;
  }
  const days = windowMinutes / (24 * 60);
  return `${Number.isInteger(days) ? days : Math.round(days * 10) / 10}d`;
}

/**
 * Aggregate per-session usage snapshots for the sidebar footer. Billed cost
 * and subscription tokens stay separate: mixing them misstates money spent.
 * Plan windows dedupe by provider window, keeping the highest usage.
 */
export function summarizeSidebarUsage(
  entries: readonly ThreadListEntry[],
  usageBySession: Readonly<Record<string, SessionUsageSnapshot | undefined>> | undefined,
): SidebarUsageSummary {
  const empty: SidebarUsageSummary = {
    sessionCount: 0,
    totalTokens: 0,
    billedCost: 0,
    subscriptionTokens: 0,
    planLimits: [],
  };
  if (!usageBySession) {
    return empty;
  }
  let sessionCount = 0;
  let totalTokens = 0;
  let billedCost = 0;
  let subscriptionTokens = 0;
  const limits = new Map<string, SidebarPlanLimit>();
  for (const entry of entries) {
    const snapshot = usageBySession[`${entry.workspaceId}:${entry.session.id}`];
    if (!snapshot) {
      continue;
    }
    sessionCount += 1;
    const tokens =
      snapshot.totals.input +
      snapshot.totals.output +
      snapshot.totals.cacheRead +
      snapshot.totals.cacheWrite;
    totalTokens += tokens;
    if (snapshot.subscription) {
      subscriptionTokens += tokens;
    } else {
      billedCost += snapshot.totals.cost;
    }
    for (const limit of snapshot.planLimits?.limits ?? []) {
      const key = `${snapshot.planLimits?.provider ?? ""}:${limit.windowMinutes}`;
      const current = limits.get(key);
      if (!current || limit.usedPercent > current.usedPercent) {
        limits.set(key, {
          provider: snapshot.planLimits?.provider ?? "",
          windowMinutes: limit.windowMinutes,
          usedPercent: limit.usedPercent,
          resetsAt: limit.resetsAt,
        });
      }
    }
  }
  return {
    sessionCount,
    totalTokens,
    billedCost,
    subscriptionTokens,
    planLimits: [...limits.values()].sort((a, b) => b.usedPercent - a.usedPercent),
  };
}

export interface ThreadSidebarModel {
  readonly folders: readonly WorkspaceRecord[];
  readonly workspaceGroups: readonly WorkspaceThreadGroup[];
  readonly pinnedThreads: readonly ThreadListEntry[];
  readonly recencySections: readonly RecencyThreadSection[];
  readonly archivedThreads: readonly ThreadListEntry[];
  readonly recencyOrder: readonly ThreadListEntry[];
  /** Nested child threads by parent `workspaceId:sessionId`, oldest first. */
  readonly childrenByParentKey: ReadonlyMap<string, readonly ThreadListEntry[]>;
  readonly usageSummary: SidebarUsageSummary;
}

export function buildThreadSidebarModel(
  state: DesktopAppState,
  nowMs: number = Date.now(),
): ThreadSidebarModel {
  const entries = collectThreadEntries(state);
  attachOrchestrationChildren(entries, state);
  const pinnedThreads = entries
    .filter((entry) => !entry.session.archivedAt && Boolean(entry.session.pinnedAt))
    .sort((left, right) => comparePinnedThreads(left, right, state.pinnedSessionOrder));
  const historyThreads = entries
    .filter(
      (entry) => !entry.session.archivedAt && !entry.session.pinnedAt && !isNestedChild(entry),
    )
    .sort((left, right) => compareByRecency(left.session, right.session));
  const archivedThreads = entries
    .filter((entry) => Boolean(entry.session.archivedAt))
    .sort((left, right) => compareByRecency(left.session, right.session));
  const recencyOrder = entries
    .filter((entry) => !entry.session.archivedAt)
    .sort((left, right) => compareByRecency(left.session, right.session));

  const folders = listFolders(state);
  const childrenByParentKey = groupChildrenByParent(entries);
  return {
    folders,
    childrenByParentKey,
    usageSummary: summarizeSidebarUsage(entries, state.sessionUsageBySession),
    workspaceGroups: folders.map((workspace) => ({
      workspace,
      threads: historyThreads.filter((entry) => entry.folderId === workspace.id),
    })),
    pinnedThreads,
    recencySections: RECENCY_BUCKET_ORDER.flatMap((bucket) => {
      const threads = historyThreads.filter(
        (entry) => recencyBucketId(sessionLastInteractedAt(entry.session), nowMs) === bucket,
      );
      return threads.length > 0 ? [{ bucket, label: RECENCY_BUCKET_LABELS[bucket], threads }] : [];
    }),
    archivedThreads,
    recencyOrder,
  };
}

function listFolders(state: DesktopAppState): readonly WorkspaceRecord[] {
  const workspacesById = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const rootWorkspaces = state.workspaces.filter((workspace) => workspace.kind === "primary");
  const orphanWorktrees = state.workspaces.filter(
    (workspace) =>
      workspace.kind === "worktree" && !workspacesById.has(workspace.rootWorkspaceId ?? ""),
  );
  const order = state.workspaceOrder;
  const sortedRoots = [...rootWorkspaces].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return -1;
    if (bi === -1) return 1;
    return ai - bi;
  });
  return [...sortedRoots, ...orphanWorktrees];
}

function collectThreadEntries(state: DesktopAppState): ThreadListEntry[] {
  const workspacesById = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const folders = listFolders(state);
  return folders.flatMap((folder) => {
    if (folder.kind !== "primary") {
      return folder.sessions.map((session) => ({
        folderId: folder.id,
        workspaceId: folder.id,
        session,
        environment: {
          kind: "worktree" as const,
          label: folder.name,
          branchName: folder.branchName,
          detached: !folder.branchName,
        },
        contextLabel: folder.name,
      }));
    }

    const linkedWorkspaces = (state.worktreesByWorkspace[folder.id] ?? [])
      .map((worktree) => ({
        worktree,
        workspace: worktree.linkedWorkspaceId
          ? workspacesById.get(worktree.linkedWorkspaceId)
          : undefined,
      }))
      .filter(
        (
          entry,
        ): entry is {
          worktree: NonNullable<(typeof state.worktreesByWorkspace)[string][number]>;
          workspace: WorkspaceRecord;
        } => Boolean(entry.workspace),
      );

    return [
      ...folder.sessions.map((session) => ({
        folderId: folder.id,
        workspaceId: folder.id,
        session,
        environment: {
          kind: "local" as const,
          label: "Local",
        },
        contextLabel: folder.name,
      })),
      ...linkedWorkspaces.flatMap(({ workspace, worktree }) =>
        workspace.sessions.map((session) => ({
          folderId: folder.id,
          workspaceId: workspace.id,
          session,
          environment: {
            kind: "worktree" as const,
            label: worktree.name,
            branchName: worktree.branchName,
            detached: !worktree.branchName,
          },
          contextLabel: `${folder.name} / ${worktree.name}`,
        })),
      ),
    ];
  });
}

export function sessionThreadKey(thread: ThreadListEntry): string {
  return `${thread.workspaceId}:${thread.session.id}`;
}

export function parentThreadKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

/** A child thread nests under its parent; pinned/archived children keep top-level rows. */
function isNestedChild(entry: ThreadListEntry): boolean {
  return entry.child !== undefined;
}

/**
 * Match orchestration child records to their session rows. Children whose
 * session is not in the catalog yet (creation race) are ignored until the
 * next snapshot; pinned and archived sessions keep their top-level rows.
 */
function attachOrchestrationChildren(entries: ThreadListEntry[], state: DesktopAppState): void {
  const bySessionKey = new Map(entries.map((entry) => [sessionThreadKey(entry), entry] as const));
  for (const child of state.orchestrationChildren) {
    if (!child.childSessionId) continue;
    const target = bySessionKey.get(parentThreadKey(child.childWorkspaceId, child.childSessionId));
    if (!target || target.session.archivedAt || target.session.pinnedAt) continue;
    const index = entries.indexOf(target);
    if (index < 0) continue;
    entries[index] = {
      ...target,
      child: {
        id: child.id,
        status: child.status,
        ...(child.mode ? { mode: child.mode } : {}),
        parentKey: parentThreadKey(child.parentWorkspaceId, child.parentSessionId),
      },
    };
  }
}

function groupChildrenByParent(
  entries: readonly ThreadListEntry[],
): ReadonlyMap<string, readonly ThreadListEntry[]> {
  const groups = new Map<string, ThreadListEntry[]>();
  for (const entry of entries) {
    if (!isNestedChild(entry) || !entry.child) continue;
    const bucket = groups.get(entry.child.parentKey) ?? [];
    bucket.push(entry);
    groups.set(entry.child.parentKey, bucket);
  }
  for (const [key, bucket] of groups) {
    groups.set(
      key,
      [...bucket].sort((left, right) =>
        left.session.updatedAt.localeCompare(right.session.updatedAt),
      ),
    );
  }
  return groups;
}

const EMPTY_EXPANDED_HISTORY: ReadonlySet<string> = new Set();

export function workspaceHistoryExpansionKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function recencyHistoryExpansionKey(bucket: RecencyBucketId): string {
  return `bucket:${bucket}`;
}

export interface VisibleThreadShortcutOptions {
  readonly grouping: ThreadGrouping;
  readonly model: ThreadSidebarModel;
  readonly expandedHistory?: ReadonlySet<string>;
  readonly archivedOpen?: boolean;
  /** Folder groups folded shut in the sidebar; their rows are not on screen. */
  readonly collapsedWorkspaceIds?: readonly string[];
}

export function visibleThreadShortcutOrder(
  options: VisibleThreadShortcutOptions,
): readonly ThreadListEntry[] {
  const expandedHistory = options.expandedHistory ?? EMPTY_EXPANDED_HISTORY;
  const collapsedWorkspaceIds = new Set(options.collapsedWorkspaceIds ?? []);
  const unpinned =
    options.grouping === "workspace"
      ? options.model.workspaceGroups
          .filter((group) => !collapsedWorkspaceIds.has(group.workspace.id))
          .flatMap(
            (group) =>
              threadHistoryPreview(
                group.threads,
                expandedHistory.has(workspaceHistoryExpansionKey(group.workspace.id)),
              ).visible,
          )
      : options.model.recencySections.flatMap(
          (section) =>
            threadHistoryPreview(
              section.threads,
              expandedHistory.has(recencyHistoryExpansionKey(section.bucket)),
            ).visible,
        );
  return [
    ...options.model.pinnedThreads,
    ...unpinned,
    ...(options.archivedOpen ? options.model.archivedThreads : []),
  ];
}

export function comparePinnedThreads(
  left: ThreadListEntry,
  right: ThreadListEntry,
  pinnedSessionOrder: readonly string[] = [],
): number {
  const order = new Map(pinnedSessionOrder.map((key, index) => [key, index] as const));
  const leftIndex = order.get(sessionThreadKey(left));
  const rightIndex = order.get(sessionThreadKey(right));
  if (leftIndex !== undefined || rightIndex !== undefined) {
    if (leftIndex === undefined) return 1;
    if (rightIndex === undefined) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  const leftPinnedAt = left.session.pinnedAt ?? "";
  const rightPinnedAt = right.session.pinnedAt ?? "";
  if (leftPinnedAt !== rightPinnedAt) {
    return rightPinnedAt.localeCompare(leftPinnedAt);
  }
  return compareByRecency(left.session, right.session);
}
