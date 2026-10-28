import type { OrchestrationChildThread } from "../../../contracts/desktop-state";
import { sessionKey } from "@pi-gui/session-driver";
import type { SessionUsageSnapshot } from "@pi-gui/session-driver";

export interface LaneUsage {
  /** Sessions in this lane that HAVE usage data. */
  readonly sessions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** 0 when every contributing session is subscription-billed. */
  readonly cost: number;
  /** False when every contributing session is subscription-billed. */
  readonly billable: boolean;
  /** True when a known session in the lane has no usage entry. */
  readonly partial: boolean;
}

const EMPTY_LANE: LaneUsage = {
  sessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cost: 0,
  billable: false,
  partial: false,
};

export function summarizeOrchestrationUsage(
  parentRef: { readonly workspaceId: string; readonly sessionId: string },
  children: readonly OrchestrationChildThread[],
  usageBySession: Readonly<Record<string, SessionUsageSnapshot>>,
): { readonly lead: LaneUsage; readonly delegated: LaneUsage } {
  const parentKey = sessionKey(parentRef);
  // No child records and no parent usage yet (usage hydrates lazily): there is
  // no measurable orchestration, so report an empty lead lane instead of a
  // partial one. Once children exist, a missing parent entry means its spend
  // is uncounted and the lane must read partial.
  const leadKeys =
    children.length === 0 && usageBySession[parentKey] === undefined ? [] : [parentKey];
  return {
    lead: summarizeLane(leadKeys, usageBySession),
    delegated: summarizeLane(collectDelegatedSessionKeys(parentRef, children), usageBySession),
  };
}

/**
 * Session keys of every descendant of `parentRef`, following parent→child
 * links. Grandchildren count: a child that is itself a parent contributes its
 * own subtree. Deduplicated by session key, so repeated child records count
 * once, and cycle-safe: the lead's own key is pre-visited, so a record that
 * points back at an ancestor cannot loop or promote the lead into `delegated`.
 */
export function collectDelegatedSessionKeys(
  parentRef: { readonly workspaceId: string; readonly sessionId: string },
  children: readonly OrchestrationChildThread[],
): readonly string[] {
  const byParentKey = new Map<string, readonly OrchestrationChildThread[]>();
  for (const child of children) {
    if (!child.parentSessionId || !child.childSessionId) {
      continue;
    }
    const parent = sessionKey({
      workspaceId: child.parentWorkspaceId,
      sessionId: child.parentSessionId,
    });
    const bucket = byParentKey.get(parent);
    byParentKey.set(parent, bucket ? [...bucket, child] : [child]);
  }
  const parentKey = sessionKey(parentRef);
  const visited = new Set<string>([parentKey]);
  const ordered: string[] = [];
  const queue: string[] = [parentKey];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) {
      continue;
    }
    for (const child of byParentKey.get(current) ?? []) {
      const childKey = sessionKey({
        workspaceId: child.childWorkspaceId,
        sessionId: child.childSessionId,
      });
      if (visited.has(childKey)) {
        continue;
      }
      visited.add(childKey);
      ordered.push(childKey);
      queue.push(childKey);
    }
  }
  return ordered;
}

function summarizeLane(
  keys: readonly string[],
  usageBySession: Readonly<Record<string, SessionUsageSnapshot>>,
): LaneUsage {
  if (keys.length === 0) {
    return EMPTY_LANE;
  }
  let sessions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cost = 0;
  let billable = false;
  let partial = false;
  for (const key of keys) {
    const snapshot: SessionUsageSnapshot | undefined = usageBySession[key];
    if (!snapshot) {
      // Lazy hydration: usage arrives after the session list, so a known
      // session without an entry is unknown — never zero.
      partial = true;
      continue;
    }
    sessions += 1;
    inputTokens += snapshot.totals.input;
    outputTokens += snapshot.totals.output;
    cacheReadTokens += snapshot.totals.cacheRead;
    if (snapshot.subscription) {
      continue;
    }
    billable = true;
    cost += snapshot.totals.cost;
  }
  return { sessions, inputTokens, outputTokens, cacheReadTokens, cost, billable, partial };
}
