import assert from "node:assert/strict";
import test from "node:test";
import {
  decideChildToolCall,
  isDeniedBashCommand,
  isDeniedEnvWrite,
  isOutsideWorkspace,
  matchIsolationPattern,
} from "../dist/child-isolation.js";

const scout = { mode: "scout" as const, workspacePath: "/work/app", depth: 1 };
const worker = { mode: "worker" as const, workspacePath: "/work/app", depth: 1 };

await test("scout blocks edits, writes, and shell but allows reads", () => {
  for (const tool of ["edit", "write", "bash", "bash_background"]) {
    const decision = decideChildToolCall(
      tool,
      { file_path: "/work/app/src/a.ts", command: "echo hi" },
      scout,
    );
    assert.equal(decision.allowed, false, tool);
    assert.match(decision.reason ?? "", /scout/);
  }
  assert.equal(
    decideChildToolCall("read", { file_path: "/work/app/src/a.ts" }, scout).allowed,
    true,
  );
  assert.equal(
    decideChildToolCall("grep", { path: "/work/app", pattern: "todo" }, scout).allowed,
    true,
  );
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
