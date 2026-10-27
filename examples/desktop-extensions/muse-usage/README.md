# Muse Usage

A pi sidebar extension that shows your **Muse (meta provider) usage** and
**what your subagents are doing**. It reads pi's own session data; nothing is
sent anywhere.

- **Muse usage**: token totals for the `meta` provider (Muse Spark / Muse Wonder)
  across every saved thread of the current folder, bucketed per day so the view
  can filter Today / 7 days / 30 days / All time. Replies from a subscription
  plan (OAuth with a subscription provider, as pi-gui's footer decides) count
  tokens but no cost; a period whose replies all cost zero shows
  **Subscription**. Other providers are listed separately so totals reconcile.
- **Terminal fallback**: `/muse-usage`, a short text summary.

Subagent activity lives in the companion **Subagents** extension
(`examples/desktop-extensions/subagents`), which tracks `agent`-tool runs:
what each subagent is doing right now plus per-run activity summaries.

## Allowance

The **Allowance** section shells out to `muse usage --json` (about 1s, cached
60s) and shows the subscription tier plus window/weekly utilization with reset
times. The CLI owns auth, so the extension never handles credentials; a failed
call degrades to a hint and never blocks usage data. Binary resolution:
`MUSE_BIN` env var, then `~/.local/bin/muse`, then `muse` on `PATH`.

```sh
node examples/desktop-extensions/muse-usage/build.mjs
node --experimental-strip-types --test examples/desktop-extensions/muse-usage/test/*.test.mts
node node_modules/typescript/bin/tsc -p examples/desktop-extensions/muse-usage/tsconfig.json
node examples/desktop-extensions/muse-usage/build.mjs --check
```

In pi-gui: **Extensions → Refresh**, then **Add tab → Muse Usage**. Browser edits
need `build.mjs` + **Reload view**; backend edits need `/reload` in the task.

## Limits

- `MAX_SESSIONS = 200` newest sessions, `MAX_SESSION_BYTES = 64 MiB`;
  oversize session files count as unreadable.
