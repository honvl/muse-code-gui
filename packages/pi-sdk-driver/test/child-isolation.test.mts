import assert from "node:assert/strict";
import test from "node:test";
import {
  decideChildToolCall,
  isDeniedBashCommand,
  isDeniedEnvWrite,
  isOutsideWorkspace,
  isScoutReadOnlyBashCommand,
  matchIsolationPattern,
} from "../dist/child-isolation.js";

const scout = { mode: "scout" as const, workspacePath: "/work/app", depth: 1 };
const worker = { mode: "worker" as const, workspacePath: "/work/app", depth: 1 };

await test("scout blocks edits, writes, and background shell but allows reads", () => {
  for (const tool of ["edit", "write", "bash_background"]) {
    const decision = decideChildToolCall(
      tool,
      { file_path: "/work/app/src/a.ts", command: "echo hi" },
      scout,
    );
    assert.equal(decision.allowed, false, tool);
    assert.match(decision.reason ?? "", /scout/);
  }
  // `bash` is no longer blanket-blocked: the read-only policy decides.
  assert.equal(decideChildToolCall("bash", { command: 'rg -n "foo" apps/' }, scout).allowed, true);
  const denied = decideChildToolCall("bash", { command: "echo hi" }, scout);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? "", /scout/);
  assert.equal(
    decideChildToolCall("read", { file_path: "/work/app/src/a.ts" }, scout).allowed,
    true,
  );
  assert.equal(
    decideChildToolCall("grep", { path: "/work/app", pattern: "todo" }, scout).allowed,
    true,
  );
});

await test("scout bash allows read-only commands", () => {
  for (const command of [
    'rg -n "foo" apps/',
    "ls -la",
    "git log --oneline -5",
    "git diff",
    "cat package.json",
    "head -20 README.md",
    "rg foo apps/ | head -20",
    "git -C /work/app log --oneline",
    "find . -name '*.ts' 2>/dev/null | head",
    "rg x 2>&1 | head -5",
    "pwd",
    "tail -50 app.log | grep error",
    "git show HEAD --stat",
    "sed -n '1,10p' README.md",
    "awk '{print $1}' file | sort | uniq -c",
    "LC_ALL=C rg -n foo apps/",
  ]) {
    assert.equal(decideChildToolCall("bash", { command }, scout).allowed, true, command);
    assert.equal(isScoutReadOnlyBashCommand(command), true, command);
  }
});

await test("scout bash denies mutating, network, and unclassifiable commands", () => {
  for (const command of [
    "rm -rf x",
    "echo hi > file",
    "rg x | tee out",
    "git commit -m x",
    "git push",
    "pnpm install",
    "curl https://x",
    "$(whoami)",
    "frobnicate --yes",
    "sudo ls",
    "sed -i 's/a/b/' file",
    "find . -delete",
    "find . -exec rm {} \\;",
    "git checkout main",
    "npm run build",
    "echo `id`",
    "rg a && rm b",
    "ls; git push",
    "cat /etc/passwd | xargs echo",
    "(rg foo apps/)",
    "GIT_DIR=/tmp/x git log",
    "FOO=1 rg x apps/",
    "git -c core.pager=cat log",
    "git --config-env=core.pager=cat log",
  ]) {
    const decision = decideChildToolCall("bash", { command }, scout);
    assert.equal(decision.allowed, false, command);
    assert.match(decision.reason ?? "", /scout \(read-only\)/);
    assert.match(decision.reason ?? "", /parent instead/);
    assert.equal(isScoutReadOnlyBashCommand(command), false, command);
  }
});

await test("scout bash is confined to the workspace", () => {
  for (const command of [
    "cat package.json",
    'rg -n "foo" apps/desktop',
    "git -C . log",
    "head -20 ./README.md",
    "sed -n '1,5p' src/index.ts",
    "rg foo apps/ | head -20",
    "ls",
    "git log --oneline -5",
    "find . -name '*.ts' | head",
    "awk '{print $1}' file",
  ]) {
    assert.equal(decideChildToolCall("bash", { command }, scout).allowed, true, command);
  }
});

await test("scout bash denies paths outside the workspace", () => {
  for (const [command, offender] of [
    ["cat ~/.ssh/id_rsa", "~/.ssh/id_rsa"],
    ["cat /etc/passwd", "/etc/passwd"],
    ["rg secrets /Users/honvl", "/Users/honvl"],
    ["git -C /tmp/x log", "/tmp/x"],
    ["head -5 ../../outside.txt", "../../outside.txt"],
    ["ls ..", ".."],
    ["cat $HOME/.ssh/id_rsa", "$HOME/.ssh/id_rsa"],
    ["ls $HOME", "$HOME"],
    ["git --git-dir=/tmp/x log", "/tmp/x"],
    ["rg foo /etc/ | head", "/etc/"],
  ] as const) {
    const decision = decideChildToolCall("bash", { command }, scout);
    assert.equal(decision.allowed, false, command);
    assert.match(decision.reason ?? "", /confined to the workspace/);
    assert.ok(
      (decision.reason ?? "").includes(`"${offender}"`),
      `${command} must name ${offender}`,
    );
  }
});

await test("worker bash is not workspace-confined", () => {
  for (const command of ["cat /etc/passwd", "git -C /tmp/x log", "ls $HOME"]) {
    assert.equal(decideChildToolCall("bash", { command }, worker).allowed, true, command);
  }
});

await test("worker bash still follows worker rules, not the scout policy", () => {
  assert.equal(decideChildToolCall("bash", { command: 'rg -n "foo" apps/' }, worker).allowed, true);
  assert.equal(decideChildToolCall("bash", { command: "pnpm install" }, worker).allowed, true);
  assert.equal(decideChildToolCall("bash", { command: "curl https://x" }, worker).allowed, true);
  const blocked = decideChildToolCall("bash", { command: "rm -rf /" }, worker);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /destructive/);
});

await test("scout cannot escalate to a worker child", () => {
  const blocked = decideChildToolCall(
    "create_child_thread",
    { prompt: "x", mode: "worker" },
    scout,
  );
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /scout/);
  assert.equal(
    decideChildToolCall("create_child_thread", { prompt: "x", mode: "scout" }, scout).allowed,
    true,
  );
});

await test("depth cap blocks further delegation", () => {
  const deep = { ...worker, depth: 3 };
  const blocked = decideChildToolCall("create_child_thread", { prompt: "x" }, deep);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /depth 3/);
  assert.equal(
    decideChildToolCall("create_child_thread", { prompt: "x" }, { ...worker, depth: 2 }).allowed,
    true,
  );
});

await test("paths outside the workspace are blocked", () => {
  assert.equal(isOutsideWorkspace("/work/app", "/work/app/src/a.ts"), false);
  assert.equal(isOutsideWorkspace("/work/app", "/etc/passwd"), true);
  assert.equal(isOutsideWorkspace("/work/app", "../outside.txt"), true);
  assert.equal(isOutsideWorkspace("/work/app", "~/secret"), true);
  const blocked = decideChildToolCall("read", { file_path: "/etc/passwd" }, worker);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /outside the workspace/);
});

await test("dotenv writes are denied except the example template", () => {
  assert.equal(isDeniedEnvWrite("write", "/work/app/.env"), true);
  assert.equal(isDeniedEnvWrite("edit", "/work/app/.env.local"), true);
  assert.equal(isDeniedEnvWrite("write", "/work/app/.env.example"), false);
  assert.equal(isDeniedEnvWrite("read", "/work/app/.env"), false);
  const blocked = decideChildToolCall("write", { file_path: "/work/app/.env" }, worker);
  assert.equal(blocked.allowed, false);
});

await test("destructive shell commands are denied", () => {
  assert.equal(isDeniedBashCommand("rm -rf /"), true);
  assert.equal(isDeniedBashCommand("rm -rf ~/"), true);
  assert.equal(isDeniedBashCommand("rm -rf /tmp/cache"), false);
  assert.equal(isDeniedBashCommand("echo hi"), false);
  const blocked = decideChildToolCall("bash", { command: "rm -rf /" }, worker);
  assert.equal(blocked.allowed, false);
});

await test("pattern matcher handles OpenCode-style globs", () => {
  assert.equal(matchIsolationPattern("*", "anything"), true);
  assert.equal(matchIsolationPattern("*.env", ".env"), true);
  assert.equal(matchIsolationPattern("*.env", "dir/.env"), false);
  assert.equal(matchIsolationPattern("**/*.env", "a/b/.env"), true);
});

await test("scout bash allows read-only gh commands and chained read-only segments", () => {
  for (const command of [
    "gh run view 123 --json status",
    "gh release list",
    "git log --oneline -3 && gh run view 1",
    "git diff --stat",
    "git tag --list",
    "git rev-parse HEAD",
    "git branch --show-current",
    "gh -R owner/repo run view 1",
    "gh repo view",
    "gh pr list",
  ]) {
    assert.equal(decideChildToolCall("bash", { command }, scout).allowed, true, command);
    assert.equal(isScoutReadOnlyBashCommand(command), true, command);
  }
  // Plain `gh api` defaults to GET: read-only by policy (workspace
  // confinement still applies to its absolute path argument separately).
  assert.equal(isScoutReadOnlyBashCommand("gh api /repos/o/r/releases/latest"), true);
});

await test("scout bash denies mutating gh commands and tag writes", () => {
  for (const command of [
    "gh release create v1",
    "gh api -X POST /repos/x",
    "gh pr create",
    "gh run cancel 1",
    "git tag -a v1 -m x",
    "git tag v1",
    "gh workflow run ci.yml",
    "gh api -X DELETE /repos/x",
    "gh release delete v1",
  ]) {
    const decision = decideChildToolCall("bash", { command }, scout);
    assert.equal(decision.allowed, false, command);
    assert.equal(isScoutReadOnlyBashCommand(command), false, command);
  }
});
