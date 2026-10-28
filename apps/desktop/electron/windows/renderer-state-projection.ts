import type { DesktopAppState, OrchestrationChildThread } from "../../contracts/desktop-state";

/**
 * Fields the renderer reads off a child record. Everything else on it — the
 * evidence log, the child transcript and the duplicated goal text — is
 * main-process data used for supervision and persistence.
 *
 * Dropping them from the renderer payload is the difference between a ~1.16MB
 * state publish and a ~13KB one. Streaming publishes up to 20 times a second,
 * so shipping the evidence log cost tens of MB/s of allocation and GC in both
 * processes, which showed up as the UI freezing mid-stream.
 *
 * `latestTranscript` is the exception: it is the child session's short preview
 * string (already truncated upstream), not the transcript. A bounded slice of
 * it per child is negligible next to the megabyte payloads above, and the
 * thread rail needs it to show a line or two of live child output. It must
 * stay a short preview — never ship the transcript/evidence here.
 *
 * The renderer only consumes id/status/mode and the parent/child session keys
 * (`features/threads/thread-groups.ts`); `goal` is blanked rather than removed
 * because the contract requires it.
 */
/** Max chars of a child's preview string forwarded to the renderer. */
export const RENDERER_CHILD_PREVIEW_LIMIT = 240;
function childForRenderer(child: OrchestrationChildThread): OrchestrationChildThread {
  return {
    id: child.id,
    ...(child.sourceToolCallId ? { sourceToolCallId: child.sourceToolCallId } : {}),
    parentWorkspaceId: child.parentWorkspaceId,
    parentSessionId: child.parentSessionId,
    childWorkspaceId: child.childWorkspaceId,
    childSessionId: child.childSessionId,
    title: child.title,
    goal: "",
    ...(child.mode ? { mode: child.mode } : {}),
    ...(child.depth !== undefined ? { depth: child.depth } : {}),
    status: child.status,
    latestTranscript: child.latestTranscript.slice(0, RENDERER_CHILD_PREVIEW_LIMIT),
    transcript: [],
    evidence: [],
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
  };
}

/**
 * Project a state for the renderer. Cached by child-list identity so repeated
 * publishes of an unchanged list hand React the same array, keeping the
 * memoized sidebar model valid.
 */
export function stateForRenderer(
  state: DesktopAppState,
  cache: WeakMap<readonly OrchestrationChildThread[], readonly OrchestrationChildThread[]>,
): DesktopAppState {
  const children = state.orchestrationChildren;
  if (children.length === 0) {
    return state;
  }
  let slim = cache.get(children);
  if (!slim) {
    slim = children.map(childForRenderer);
    cache.set(children, slim);
  }
  return { ...state, orchestrationChildren: slim };
}
