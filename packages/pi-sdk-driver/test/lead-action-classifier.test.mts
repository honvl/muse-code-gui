import assert from "node:assert/strict";
import test from "node:test";
import { classifyLeadBashCommand, classifyLeadToolCall } from "../dist/lead-action-classifier.js";

// Real lead commands that the old gate (scout read-only allowlist) counted as
// "direct edits" and blocked. They are reads or diagnostics: never counted.
const READS = [
  "cd /Users/me/pi-gui && sed -n '60,170p' apps/desktop/electron/platform/update-checker.ts",
  "cd /Users/me/pi-gui && find apps/desktop -name 'app-store*.ts' -not -path '*/node_modules/*' | xargs wc -l; ls apps/desktop/electron/orchestration",
  'cd /Users/me/pi-gui\ngit log --oneline -2\necho "--- files in commit ---"\ngit show --stat --oneline HEAD | tail -n 5',
  "cd /Users/me/pi-gui && sed -n \"$(grep -n 'function isLeadDirectMutation' src/orchestrator-mode.ts | cut -d: -f1),+45p\" src/orchestrator-mode.ts",
  'cd /Users/me/pi-gui\ndate "+now: %H:%M:%S"\nps -eo pid,lstart,command | grep "MacOS/pi-gui$" | grep -v grep | head -n 2',
  'cd /Users/me/pi-gui && git log --oneline -3 && echo "=== release ===" && gh run view 40770280612 --json status -q .status',
  "cd /Users/me/companion && pgrep -afl '[d]eps/cli-|[c]argo test' ; echo \"rc=$?\"",
  "cd /Users/me/pi-gui\npython3 - <<'PY'\nimport json, os\nui=json.load(open(os.path.expanduser('~/x/ui-state.json')))\nprint(len(ui))\nPY",
  'ARGS=""; for p in $(cat /tmp/pg-main /tmp/pg-rend); do ARGS="$ARGS -pid $p"; done\ntop -l 40 -s 1 $ARGS',
  "rg -n 'foo > bar' src 2>/dev/null | head",
  'grep -n "pnpm test" package.json',
  "ps -eo pid,command | grep pi-gui | awk '{print $1}' > /tmp/pg-main",
  "git diff --stat && git diff | head -150",
  "git add -A && git commit -m 'checkpoint' && git push",
  "git merge --ff-only child/81e5bb59",
  "cd /Users/me/pi-gui && git merge --ff-only child/81e5bb59",
  "git cherry-pick 1a84917",
  "git worktree add /Users/me/pi-gui/.worktrees/feat-1 -b feat-1",
  "git worktree remove /Users/me/pi-gui/.worktrees/feat-1 --force",
  "cd /Users/me/pi-gui/.worktrees/81e5bb59 && git rebase main",
  "git -C /Users/me/pi-gui/.worktrees/81e5bb59 rebase main",
  "mv /Applications/X.app ~/Applications/X.app.backup-*",
  "ditto /Users/me/build/X.app /Applications/X.app",
  "cd /Users/me/pi-gui/.worktrees/81e5bb59 && pnpm install --frozen-lockfile --prefer-offline",
  "git reset --soft HEAD~1 && git restore --staged src/a.ts",
  "cp src/app-store.ts /tmp/app-store.before.ts",
  "cd /tmp && rm -rf scratch && mkdir scratch && cat > t.ts <<'EOF'\nconst x = 1 > 0;\nEOF",
  "sed -i '' 's/a/b/' /tmp/bench.mjs",
  "chmod +x /tmp/install.sh && sh -n /tmp/install.sh",
  "rustfmt --version",
  "",
];

const VERIFICATIONS: readonly (readonly [string, RegExp])[] = [
  ["pnpm --filter @pi-gui/desktop run typecheck 2>&1 | tail -n 20", /typecheck/],
  ["cd pkg && pnpm exec tsc -p tsconfig.json && node --test test/a.test.mts", /tsc/],
  [
    "pnpm exec playwright test -c apps/desktop/playwright.config.ts tests/unit/a.spec.ts",
    /playwright/,
  ],
  [
    'cd /x && PATH="$HOME/.cargo/bin:$PATH" nice -n 10 cargo test -p bridge_jobs -j 4 2>&1 | tail -12',
    /cargo test/,
  ],
  ["cd /x && perl -e 'alarm 120; exec @ARGV' cargo test -p bridge_cli --test cli", /cargo test/],
  ["swift test --filter PGSSubtitlesTests 2>&1 | tail", /swift test/],
  ["xcodebuild -project Viewer.xcodeproj -scheme Viewer build", /xcodebuild/],
  ["pnpm test:desktop-unit", /test:desktop-unit/],
  ["cd /Users/me/pi-gui/.worktrees/81e5bb59 && pnpm build:shared", /build:shared/],
  ["pnpm exec prettier --check src/a.ts", /prettier/],
  ["npx vitest run", /vitest/],
  ["python3 -m pytest -q", /pytest/],
];

const MUTATIONS: readonly (readonly [string, RegExp])[] = [
  [
    "cd /x/ViewerKit && python3 - <<'PY'\np='Tests/A.swift'\ns=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nPY",
    /script that writes files/,
  ],
  ["python3 - <<'EOF'\nimport pathlib\npathlib.Path('src/a.ts').write_text('x')\nEOF", /script/],
  ["node -e \"require('fs').writeFileSync('package.json', '{}')\"", /script/],
  [
    "cat >> apps/desktop/tests/unit/a.spec.ts <<'EOF'\ntest('x', () => {});\nEOF",
    /write to apps\/desktop/,
  ],
  ["echo hi > notes.txt", /write to notes.txt/],
  ["rm -rf dist", /rm -rf dist/],
  ["mv src/a.ts src/b.ts", /mv/],
  ["sed -i '' 's/a/b/' src/a.ts", /sed -i/],
  ["perl -pi -e 's/a/b/' src/a.ts", /perl/],
  ["git stash push -- src/a.ts && pnpm test", /git stash/],
  ["cd /Users/me/pi-gui && git merge origin/main", /git merge/],
  ["cd /Users/me/pi-gui && git rebase main", /git rebase/],
  ["rm -rf /Applications/X.app", /rm -rf \/Applications/],
  ["cd /Users/me/pi-gui && pnpm install --frozen-lockfile --prefer-offline", /pnpm install/],
  ["mv ./build/X.app /tmp/X.app", /mv/],
  ["git checkout -- src/a.ts", /git checkout/],
  ["pnpm exec prettier --write src/a.ts", /prettier --write/],
  ["pnpm add lodash", /pnpm add/],
  ["cargo fmt", /cargo fmt/],
  ["printf x | tee src/a.txt", /tee/],
  ["cd /tmp && cp scratch.ts /Users/me/pi-gui/src/a.ts", /cp/],
];

await test("lead reads, diagnostics, and scratch work never count", () => {
  for (const command of READS) {
    assert.equal(classifyLeadBashCommand(command).kind, "read", `must be a read: ${command}`);
  }
});

await test("builds, tests, typechecks, and lint checks classify as verification", () => {
  for (const [command, label] of VERIFICATIONS) {
    const action = classifyLeadBashCommand(command);
    assert.equal(action.kind, "verification", `must be verification: ${command}`);
    assert.match(action.label, label);
  }
});

await test("commands that change project files classify as mutations", () => {
  for (const [command, label] of MUTATIONS) {
    const action = classifyLeadBashCommand(command);
    assert.equal(action.kind, "mutation", `must be a mutation: ${command}`);
    assert.match(action.label, label);
  }
});

await test("a mutation anywhere in a command outranks verification", () => {
  assert.equal(classifyLeadBashCommand("pnpm test && rm -rf build").kind, "mutation");
  assert.equal(classifyLeadBashCommand("git log -1 && pnpm test").kind, "verification");
});

await test("file tools are mutations with their path; other tools are reads", () => {
  assert.deepEqual(classifyLeadToolCall("edit", { path: "src/a.ts", edits: [] }), {
    kind: "mutation",
    label: "edit src/a.ts",
    path: "src/a.ts",
  });
  assert.equal(classifyLeadToolCall("write", { file_path: "src/b.ts" }).path, "src/b.ts");
  assert.equal(classifyLeadToolCall("apply_patch", {}).kind, "mutation");
  for (const tool of ["read", "grep", "find", "ls", "read_thread", "create_child_thread"]) {
    assert.equal(classifyLeadToolCall(tool, { path: "src" }).kind, "read", tool);
  }
  assert.equal(classifyLeadToolCall("bash", { command: "pnpm test" }).kind, "verification");
  assert.equal(classifyLeadToolCall("bash", undefined).kind, "read");
});
