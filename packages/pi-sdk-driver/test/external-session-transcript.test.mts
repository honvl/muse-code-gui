import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import { SessionSupervisor } from "../dist/session-supervisor.js";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

async function makeSupervisor() {
  const root = await mkdtemp(join(tmpdir(), "pi-external-session-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = join(root, "agent");
  const supervisor = new SessionSupervisor({
    catalogStorage: new JsonCatalogStore({ catalogFilePath: join(root, "catalogs.json") }),
  });
  return {
    root,
    supervisor,
    async cleanup() {
      if (previous === undefined) {
        delete process.env[AGENT_DIR_ENV];
      } else {
        process.env[AGENT_DIR_ENV] = previous;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function userText(text: string) {
  return { role: "user", content: [{ type: "text", text }] } as never;
}

function assistantText(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: Date.now(),
  } as never;
}

await test("finds a subagent session by name in the workspace cwd", async () => {
  const { root, supervisor, cleanup } = await makeSupervisor();
  try {
    const workspacePath = join(root, "workspace");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspacePath, { recursive: true });
    const { workspaceId, path: canonicalPath } =
      await supervisor.registerWorkspace(workspacePath);

    const manager = SessionManager.create(canonicalPath);
    const agentId = manager.getSessionId();
    manager.appendSessionInfo("agent:explore: Explore auth flow");
    manager.appendMessage(userText("summarize the auth flow"));
    manager.appendMessage(assistantText("The auth flow lives in src/auth.ts."));

    const found = await supervisor.readExternalSessionTranscript({
      workspaceId,
      sessionName: "agent:explore: Explore auth flow",
    });
    assert.ok(found, "expected the subagent session to be found");
    assert.equal(found.sessionId, agentId);
    assert.equal(found.sessionName, "agent:explore: Explore auth flow");
    const text = JSON.stringify(found.transcript);
    assert.ok(text.includes("The auth flow lives in src/auth.ts."));
  } finally {
    await cleanup();
  }
});

await test("prefers the agentId match and searches isolated worktree cwds", async () => {
  const { root, supervisor, cleanup } = await makeSupervisor();
  try {
    const { mkdir } = await import("node:fs/promises");
    const workspacePath = join(root, "workspace");
    const worktreeDir = join(root, "pi-subagent-agent-explore-1-abcd");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
    const { workspaceId } = await supervisor.registerWorkspace(workspacePath);

    const manager = SessionManager.create(worktreeDir);
    const agentId = manager.getSessionId();
    manager.appendSessionInfo("agent:explore: Renamed later");
    manager.appendMessage(assistantText("isolated worktree result"));

    const withoutCwd = await supervisor.readExternalSessionTranscript({
      workspaceId,
      sessionName: "agent:explore: Renamed later",
    });
    assert.equal(withoutCwd, undefined, "worktree sessions are invisible without their cwd");

    const withCwd = await supervisor.readExternalSessionTranscript({
      workspaceId,
      sessionName: "agent:explore: Renamed later",
      extraCwds: [worktreeDir, "relative/ignored", worktreeDir],
    });
    assert.ok(withCwd, "expected the worktree session to be found via extraCwds");
    assert.ok(JSON.stringify(withCwd.transcript).includes("isolated worktree result"));

    const byId = await supervisor.readExternalSessionTranscript({
      workspaceId,
      sessionName: "agent:explore: something else entirely",
      agentId,
      extraCwds: [worktreeDir],
    });
    assert.ok(byId, "expected the agentId match to win over the name");
    assert.equal(byId.sessionId, agentId);
  } finally {
    await cleanup();
  }
});

await test("returns undefined for unknown workspaces and missing sessions", async () => {
  const { root, supervisor, cleanup } = await makeSupervisor();
  try {
    const { mkdir } = await import("node:fs/promises");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const { workspaceId } = await supervisor.registerWorkspace(workspacePath);

    assert.equal(
      await supervisor.readExternalSessionTranscript({
        workspaceId: "no-such-workspace",
        sessionName: "agent:explore: x",
      }),
      undefined,
    );
    assert.equal(
      await supervisor.readExternalSessionTranscript({
        workspaceId,
        sessionName: "agent:explore: never ran",
      }),
      undefined,
    );
  } finally {
    await cleanup();
  }
});
