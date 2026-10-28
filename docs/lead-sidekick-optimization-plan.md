# Lead/sidekick optimization plan

Status: **proposed**, not implemented. Written October 28, 2026 against `0a3e74a4`.

pi-gui's Lead mode follows Cognition's Fusion design ([Devin Fusion](https://cognition.com/blog/devin-fusion), [Fusion in Devin Desktop & CLI](https://cognition.com/blog/local-fusion)): a frontier **lead** owns the plan, ambiguity and review; a cheaper **sidekick** explores, implements, tests and reports. Each keeps its own cached context, and they exchange only briefs, results and feedback. This plan lists the gaps between that design and the current implementation, in priority order. Each work item is a self-contained, separately committable change with its own acceptance criteria and the narrowest proof.

## What already matches Fusion

| Fusion principle                             | pi-gui today                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontier lead, cost-effective sidekick       | Per-thread lead model plus sidekick model; scouts use the app-wide scout model (`app-store-orchestration.ts:421-424`).                                 |
| Lead owns plan/review, delegates by default  | `ORCHESTRATOR_SYSTEM_PROMPT` (`packages/pi-sdk-driver/src/orchestrator-mode.ts:41-48`) plus a soft gate after 3 direct mutations per run (`:116-183`). |
| Briefs with constraints and success criteria | `composeChildBrief` (`orchestration-runtime.ts:409-423`) with host defaults for criteria/verify.                                                       |
| Results, not transcripts, flow back          | `reportChildCompletion` injects one `pi-gui.child-report` custom message and wakes the lead (`app-store-orchestration.ts:1294-1396`).                  |
| Separate contexts and caches                 | Every child is its own Pi session; reports and tool results only append to the lead's context, so its cached prefix survives.                          |
| Lead can take work back                      | `send_message_to_thread` steers or interrupts a child; the lead keeps its full toolset.                                                                |

## Priority 1: lead token diet

**Why:** Fusion's main lever is that "the main agent should take minimal actions, and only read what is absolutely necessary." Every lead token is frontier-priced. The current prompts repeat themselves, contradict each other in ways that invite extra reads, and allow unbounded tool output.

### Findings

1. **Duplicated guidance.** "Children report back / don't poll read_thread" appears six times: `orchestrator-mode.ts:46`, `:145-149`, `orchestration-runtime.ts:143`, `:238`, `:240`, plus the tool description at `:135`. "Reuse a child" appears at `orchestrator-mode.ts:43` and `orchestration-runtime.ts:140`. "Tokens are expensive / verify by diff" appears at `orchestrator-mode.ts:42`, `:47` and again in the per-run guideline at `:146-149`. Brief guidance appears at `:45` and `orchestration-runtime.ts:142`.
2. **Contradictions that cause extra reads:**
   - `orchestration-runtime.ts:147`: "Prefer reading a child thread before summarizing its status back to the user." This conflicts with "act on the report."
   - `formatCreateChildThreadResult` (`app-store-orchestration.ts:2193`) ends every spawn with "call read_thread once with wait_seconds." In Lead mode the report wakes the lead automatically, so this nudge spends a blocking tool call and its output.
   - The `read_thread` running/timeout notices (`:964-970`) again suggest calling `read_thread`.
3. **Lead-only guidance reaches everyone.** Tool `promptGuidelines` in `orchestration-runtime.ts` are static, so the delegation-strategy text (spawn proactively, scout vs worker, brief like a stranger, report contract) is sent to solo threads and to **every child**, on the sidekick's budget too.
4. **Unbounded or oversized tool output:**
   - `read_thread` returns up to 60 messages × 2,000 chars (about 120k chars) per call (`app-store-orchestration.ts:57-60`, `:952`, `:976`). It also includes tool and system rows (`transcriptText`, `:2639`) and converts the whole transcript before slicing (`:948`).
   - `list_threads` returns every non-archived session in the workspace, each with a preview, with no count or length cap (`listThreadsForContext`, `:2022-2096`; `formatThreadList`, `:2143-2155`).
5. **Report padding.** `childCompletionReportText` (`:1367-1396`) repeats the `goal` (up to 400 chars, which the lead wrote itself) and allows 4,000 chars of body, while the child is told "under ~1200 characters" (`CHILD_REPORT_SUFFIX`, `orchestration-runtime.ts:386-387`).

### Changes

- **1a. One source of lead guidance.** Keep delegation strategy only in the lead-only `orchestrator_mode` section (`ORCHESTRATOR_SYSTEM_PROMPT`). Reduce each tool's `promptGuidelines` to factual usage (arguments, what it returns, isolation limits). Remove the per-run lead guideline at `orchestrator-mode.ts:145-149`, which duplicates the section. Keep `SOLO_SYSTEM_GUIDELINE` as the only solo text.
- **1b. Remove the read-inviting text.**
  - Delete `orchestration-runtime.ts:147`.
  - In Lead mode, end `formatCreateChildThreadResult` with "This child reports back when its run ends." Keep the `wait_seconds` hint only for non-lead parents, which receive no report (`:1326`).
  - Reword the `read_thread` running notice the same way for lead parents.
- **1c. Bound `read_thread`.**
  - Default window: the latest **8** messages, at most 1,500 chars each, and at most **8,000 chars** for the whole result. `full:true` raises the window but keeps a hard cap of about 24k chars.
  - Drop `system` rows, and collapse tool rows to one line each (`toolName: label [status]`).
  - Slice before converting rather than converting the whole transcript.
  - Always state how many messages were omitted.
- **1d. Bound `list_threads`.** Return the current thread and its children first, then at most 10 other workspace threads, with previews cut to 160 chars and "+N more" at the end. Add an optional `query` parameter (title substring) so the lead can find an older thread without listing everything.
- **1e. Tighten reports.**
  - Drop the `goal` line when the parent is the lead that wrote it. Keep the title and `thread_id`.
  - Lower `CHILD_REPORT_MESSAGE_LIMIT` to **2,000** chars, still with the explicit truncation note.
  - Keep the 1,200-char request in `CHILD_REPORT_SUFFIX`.

### Acceptance criteria

- The assembled lead system prompt contains each policy sentence exactly once. A solo thread's prompt and a child's prompt contain no delegation-strategy text. Prove this with a driver-level test that captures `systemPromptOptions` for lead, solo and child sessions.
- No lead-mode tool result tells the lead to call `read_thread` for completion.
- `read_thread` (default and `full:true`) and `list_threads` output stays under the caps above for a 500-message transcript and a 200-thread workspace.
- Reports keep their header, `thread_id (run N)`, status and truncation note.

### Proof (scoped)

- Desktop unit: `pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/unit/orchestration-child-report.spec.ts apps/desktop/tests/unit/orchestration-read-wait.spec.ts apps/desktop/tests/unit/orchestration-child-brief.spec.ts`. Add a new `orchestration-tool-output-bounds.spec.ts` for 1c and 1d.
- Driver: in `packages/pi-sdk-driver`, run `pnpm exec tsc -p tsconfig.json && node --test test/orchestrator-mode.test.mts` (tests import `../dist`).
- Electron core: the `orchestration-runtime-tools.spec.ts` and `orchestration-child-report.spec.ts` specs in the core lane (see `apps/desktop/package.json` `test:e2e:core`, filtered to these two files).
- Real provider, once, through the [verification skill](../.agents/skills/verify-pi-gui/SKILL.md): a Lead thread delegates one scout task. Record the lead's token usage from the session rail before and after the change for the same prompt.

## Priority 1: host hot-path performance

**Why:** orchestration bookkeeping runs on the Electron main thread on every session event. As threads accumulate, it grows with _all parents × all transcript lines_, which shows up as main-thread stalls while children stream tool calls.

### Findings

1. `app-store.ts:3771-3783`: every non-token event for any parent or child calls `projectOrchestrationChildrenForSession` (`app-store-orchestration.ts:1103-1115`). That function rebuilds `parentEvidenceIndex` (`:2245-2268`), which runs `evidenceFromParentTranscript` (`:2330-2391`, with a per-line regex in `explicitAcceptanceEvidenceFromParentMessage`) over **every parent's full transcript**, just to re-project one child.
2. `listThreadsToolResult` (`:835`) and `refreshParentOrchestrationEvidence` (`:1827`) re-project **all** children. Each projection filters the full child transcript, runs `hasStartedRun` (`:2579`) and merges and sorts evidence (`:2210`).
3. `resolveThreadTarget` (`:2108-2141`) rebuilds and sorts the whole `listThreadsForContext` list on every call. `readThreadToolResult` calls it up to three times per call (`:907`, `:916` inside a loop predicate, `:943`).
4. `persistUiState()` runs synchronously on every `runCompleted`/`runFailed` (`app-store.ts:3797-3802`) and after every message sent to a child (`app-store-orchestration.ts:1061-1063`). With many children finishing close together, that's a burst of full-state writes.
5. Renderer: `thread-rail-column.tsx:45-58` recomputes `summarizeOrchestrationUsage` and `collectDelegatedSessionKeys` (a BFS) on every render, without memoization.

### Changes

- **2a. Incremental parent-evidence index.** Keep, per parent session key, `{ transcriptLength, lastMessageId, recordsByChildId }`. When a parent event arrives, scan only the messages appended since `transcriptLength`; rebuild fully only if `lastMessageId` no longer matches (tree navigation or compaction). A child event reads the cached bucket without scanning any parent transcript. Store the index in the orchestration owner, not in `DesktopAppStore`; the [state-owner guard](../scripts/state-owner-boundary.test.mjs) must stay green.
- **2b. Re-project only the affected children.** Replace the full re-projections in `listThreadsToolResult` and `refreshParentOrchestrationEvidence` with re-projection of the calling parent's children only.
- **2c. Resolve once.** Build the thread list once per `read_thread` and `send_message_to_thread` call, and make `liveChildStatus` look up the child record by id (a `Map`) rather than re-listing.
- **2d. Coalesce persistence.** Route child-originated `runCompleted`/`runFailed` and child message sends through `schedulePersistUiState()` (debounced). Keep the immediate `persistUiState()` for `sessionClosed` and for runs of non-child threads. Quit already flushes pending writes.
- **2e. Memoize the rail.** Wrap the lane-usage and delegated-keys computations in `useMemo`, keyed on `orchestrationChildren`, `sessionUsageBySession` and the session ref.

### Acceptance criteria

- With 10 parents of 2,000 transcript rows each and 30 children, one child `toolFinished` event costs O(new rows), not O(all parent rows). Prove it with a unit test that counts `evidenceFromParentTranscript` invocations or scanned rows through a test seam.
- Child statuses, evidence records and reports stay identical to today. The existing `orchestration-children-stability`, `orchestration-restart-status` and `orchestration-child-hydration` unit specs pass unchanged.
- Five children that finish within 100 ms produce one UI-state write, not five, and a quit right after still persists their terminal statuses.
- No `noteSlowOperation` warnings for `session event toolFinished` during a 4-child real-provider run (diagnostic, not a CI threshold).

### Proof (scoped)

- Desktop unit: the three stability specs above, `orchestration-usage.spec.ts`, `session-rail-children.spec.ts`, and a new `orchestration-evidence-index.spec.ts`.
- Electron core: `orchestration-child-report.spec.ts`, plus `persistence.spec.ts` for 2d (`pnpm --filter @pi-gui/desktop test:core:persistence`).
- `node --test scripts/state-owner-boundary.test.mjs` (the state-owner guard), because 2a adds owner state.

## Priority 1: tool-name collision between orchestration and cross-session

### Findings (verified)

- Two extensions register `list_threads` and `read_thread` in **every** session:
  - the desktop built-in `pi-gui-thread-orchestration` (`apps/desktop/electron/main.ts:1065-1071`);
  - the driver's hidden `pi-gui-cross-session` (`packages/pi-sdk-driver/src/cross-session.ts:8-10`, loaded at `session-supervisor.ts:407-422`).
- Pi keeps both, records a `Tool "…" conflicts with …` error in the resource loader's extension diagnostics (`pi-coding-agent/dist/core/resource-loader.js:583-590`, `:974-992`), and resolves by load order: **first registration wins** (`dist/core/extensions/runner.js:411-420`). Built-ins load before cross-session (`session-supervisor.ts:396-422`), so the orchestration tools win and the cross-session `list_threads`/`read_thread` are dead code while orchestration is enabled.
- Built-ins can be disabled (`gatedBuiltinExtensions`, `session-supervisor.ts:364-367`). With "Thread orchestration" off, the cross-session tools take over. So they are a fallback, not pure dead code.
- `message_thread` (cross-session) and `send_message_to_thread` (orchestration) have different names, so both are active together. `send_message_to_thread` already reaches any non-archived workspace thread (`listThreadsForContext`), which makes `message_thread` redundant: two tools with two guideline sets for the same action in every prompt.

### Change

- **3a.** Add an optional `supersedesTools?: readonly string[]` to the driver's `BuiltinExtension` contract. The desktop declares `["list_threads", "read_thread", "message_thread"]` on `pi-gui-thread-orchestration`.
- **3b.** `SessionSupervisor` collects `supersedesTools` from **enabled** built-ins and passes them to `createCrossSessionRuntimeExtension` as an omit list, so the cross-session extension registers only tools that nothing supersedes. The driver stays generic: it never hard-codes desktop tool names.

### Acceptance criteria

- Orchestration enabled: no conflict diagnostics; exactly one `list_threads`, one `read_thread`, one `send_message_to_thread`, and no `message_thread` in the active tool set.
- Orchestration disabled: the cross-session trio is registered and works as today.

### Proof

- Driver: extend `test/cross-session.test.mts` and `test/builtin-extensions.test.mts` with both cases (build first, as above).

## Priority 2: persistent sidekick (warm cache)

**Why:** this is Fusion's core cost mechanism: "both the main model and sidekick model maintain their own persistent, cached contexts." pi-gui creates a **fresh** session for every `create_child_thread` (`app-store-orchestration.ts:426`), so each task pays a cold prefix plus re-exploration. Reuse depends only on the lead choosing `send_message_to_thread` (`orchestrator-mode.ts:43`).

### Change

- **4a. Host-routed reuse.** When a lead calls `create_child_thread` with mode `worker`, the host first looks for that lead's most recent worker child that is idle (terminal status), under the generation limit, on the same model, and whose last run ended within the cache window (default 4 minutes, `PI_APP_SIDEKICK_REUSE_WINDOW_MS`). If it finds one, it delivers the composed brief there as a follow-up (the existing `send_message_to_thread` path, bumping `generation`) and returns `{ reused: true, childThreadId }`. Otherwise it spawns as today.
- **4b. Opt-out.** Add a `fresh: true` parameter for parallel or unrelated slices. Parallel calls in one assistant turn must never collapse onto one child: only the first can reuse, and the rest spawn.
- **4c. Scope interaction.** Reuse must pass the writer-scope check that a fresh spawn would face (follow-ups currently skip it; see Priority 2b).
- **4d. Context budget.** Do not reuse a child whose context is above a threshold (for example 60% of its model window) or that has compacted twice. Spawn fresh instead, with a one-line note in the tool result.
- Update the lead prompt from "reuse a child…" to "the host reuses your sidekick automatically; pass fresh:true for parallel slices."

### Acceptance criteria

- Two sequential worker briefs within the window land in one child session, and the second run shows cache-read tokens in that child's usage.
- Parallel `create_child_thread` calls in one turn still produce separate children.
- The budget counts reused deliveries as continuations, not as new children.

### Proof

- Unit spec for the reuse decision, as a pure function over child records, timestamps and context usage.
- Electron core: an `orchestration-runtime-tools.spec.ts` case for sequential versus parallel spawn.
- Real provider: compare the child's `cacheRead` tokens between the two runs.

### Open question

Pi's prompt-cache expiry is provider-defined (often 5 minutes). Fusion notes this explicitly. Decide whether to keep a reused sidekick warm (a cheap keep-alive costs tokens) or accept a cold restart after the window. The recommendation is to accept the cold restart; re-explore is still cheaper on the sidekick model.

## Priority 2: parallel scoped workers

**Why:** the lead prompt promises "parallel workers need disjoint scopes" (`orchestrator-mode.ts:45`), but `existingChildWriteScopes` always returns `[]` (`app-store-orchestration.ts:288-290`). So **any** active worker blocks **every** new worker, and Lead mode serializes all implementation. Follow-ups through `send_message_to_thread` bypass the check entirely.

### Change

- **5a.** Persist `writeScopes: string[]` on `OrchestrationChildThread` (a desktop contract plus UI-state field; bump the UI-state version with a migration where a missing value means `[]`, the whole workspace). This follows the existing UI-state migration rules in [architecture](architecture.md#persistent-data).
- **5b.** `existingChildWriteScopes(child)` returns `child.writeScopes ?? []`. `scopesOverlap` (`writer-scope.ts`) already handles the rest.
- **5c.** Run the same check for `send_message_to_thread` to an idle worker (it re-acquires the writer slot) and for sidekick reuse (Priority 2a).
- Keep the strict rule that an unscoped worker claims the whole workspace.

### Acceptance criteria

- Workers scoped `apps/a` and `apps/b` run concurrently; `apps/a` and `apps/a/src` conflict; an unscoped worker conflicts with everything.
- An older ui-state file without `writeScopes` loads and treats existing workers as whole-workspace.

### Proof

- `orchestration-writer-scope.spec.ts` (extend it), `pnpm --filter @pi-gui/desktop test:core:persistence`, and the UI-state decoder unit tests.

### Risk

Disjoint path scopes in one checkout still share build outputs, lockfiles and the Git index. Document that scopes are advisory for shared artifacts. Worktree-per-worker isolation (the "phase B" in the code comment) stays a separate decision.

## Priority 3: effort per lane and mid-session routing

**Why:** Fusion tunes the lead's effort and the sidekick per pairing, and switches models during compaction, where the cache is lost anyway, so the switch costs nothing extra. pi-gui fixes model and thinking level at spawn: children get no thinking level (`app-store-orchestration.ts:421-426`), and a missing sidekick silently falls back to the workspace default, which may be the frontier lead model.

### Change

- **6a.** Add sidekick and scout **thinking-level** settings next to the existing sidekick and scout model pickers (`settings-models-section.tsx`, `sidekick-picker`), and apply them in `createChildThreadRecord` through the existing session-config setter.
- **6b.** Warn in the composer's Lead badge when the effective sidekick model equals the lead model ("Sidekick is the lead model; no savings").
- **6c (exploratory).** Add a hidden driver extension on `session_before_compact` (`pi-coding-agent` `ExtensionAPI.on("session_before_compact")`) that lets the desktop swap a child's model at compaction time, for example escalating a sidekick that has failed twice. Gate it behind a flag and measure it before making it a default.

### Proof

- `default-scout-model` and `orchestration-child-sidekick-model` unit specs (extend them), `sidekick-picker.spec.ts` (core), and one real-provider run for 6c.

## Out of scope / flagged for the owner

- **Uncommitted `child-isolation.ts` change (not part of this plan):** the working-tree diff allows `gh api` for read-only scouts whenever `-X` is absent. `gh api` switches to POST when `-f`, `-F`, `--field`, `--raw-field` or `--input` is present, so a scout could make write calls. The author should reject those flags (and `--method`) for scouts and add cases to `test/child-isolation.test.mts`.
- In-memory maps that never shrink (`childGenerationByThreadId`, read cursors, `reportedRuns`, `leadMutationBySession`) are small. Prune them when a child is archived as part of 2a, without treating it as a separate project.
- Solo parents get no unsolicited child reports (`app-store-orchestration.ts:1326`). This is intentional (they await tool results); keep it.

## Suggested commit order

1. Priority 1c and 1d (output bounds), with their unit spec.
2. Priority 1a, 1b and 1e (prompt and report diet), with the driver prompt test.
3. Priority 1, tool-name collision (3a, 3b), driver only.
4. Priority 1 host performance 2a and 2b, then 2c, then 2d, then 2e (four small commits).
5. Real-provider Lead verification, recording lead/sidekick token usage before and after.
6. Priority 2 parallel scoped workers (contract and migration).
7. Priority 2 persistent sidekick (depends on 6 for the scope check on reuse).
8. Priority 3, after measuring 1–7.

Every step keeps Pi-runtime behavior in Pi: the driver changes are limited to prompt sections, tool registration and the cross-session omit list, per [`packages/pi-sdk-driver/AGENTS.md`](../packages/pi-sdk-driver/AGENTS.md).
