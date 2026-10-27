# Subagents

A pi sidebar extension that shows **what your subagents are doing**,
Claude-Desktop-style: live runs with elapsed time plus per-run activity
summaries (turns, tool mix, files touched, last reply). It tracks the `agent`
tool from the pi-cc-subagent extension: each `agent`-tool call is one subagent
run. It reads pi's own session data; nothing is sent anywhere.

- **Running**: `agent`-tool calls executing in the thread hosting the view, via
  `tool_execution_start/end` — description, agent type, background/worktree
  badges, ticking elapsed time.
- **Recent**: every `agent`-tool call in this folder's transcripts, paired with
  its result (`durationMs`, `agentId`) and newest first. Expanding a run shows
  its inner activity, read from the subagent's own session file
  (`*<agentId>.jsonl`): turns, tool mix, files read/written, last reply excerpt
  and the `agentId` to resume it.
- **Terminal fallback**: `/subagents`, a short text summary.

Token and allowance totals live in the companion **Muse Usage** extension
(`examples/desktop-extensions/muse-usage`); this view is about activity, not
tokens.

```sh
node examples/desktop-extensions/subagents/build.mjs
node --experimental-strip-types --test examples/desktop-extensions/subagents/test/*.test.mts
node node_modules/typescript/bin/tsc -p examples/desktop-extensions/subagents/tsconfig.json
node examples/desktop-extensions/subagents/build.mjs --check
```

In pi-gui: **Extensions → Refresh**, then **Add tab → Subagents**. Browser edits
need `build.mjs` + **Reload view**; backend edits need `/reload` in the task.

## Limits

- `MAX_SESSIONS = 200` newest sessions, `MAX_SESSION_BYTES = 64 MiB` per
  transcript, `MAX_SUMMARY_BYTES = 8 MiB` per subagent session,
  `MAX_RUNS = 30` recent runs with inner summaries for the newest
  `MAX_SUMMARIES = 12`. Oversize session files count as unreadable.
- Live rows only cover `agent`-tool calls in the thread hosting the view.
  Unpaired calls in other threads list as done without a duration.
- Background-task state lives in the pi-cc-subagent extension's memory and is
  not queryable here; runs are reconstructed from transcripts instead.
