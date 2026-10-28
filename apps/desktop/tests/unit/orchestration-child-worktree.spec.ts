import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { SessionRef, WorkspaceRef } from "@pi-gui/session-driver";
import type { OrchestrationChildThread, TranscriptMessage } from "../../contracts/desktop-state";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";
import { appWorktreeRootMatcher } from "../../electron/platform/worktrees/app-worktree-roots";
import {
  childWorktreeSummary,
  createChildWorktree,
  isChildWorktreePath,
} from "../../electron/platform/worktrees/child-worktree";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function makeRepo(name: string): Promise<string> {
  const repo = join(await realpath(await mkdtemp(join(tmpdir(), "child-worktree-"))), name);
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Pi App Tests");
  await git(repo, "config", "user.email", "pi-gui-tests@example.com");
  await writeFile(join(repo, "README.md"), "# repo\n");
  await writeFile(join(repo, "a.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "init");
  return repo;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test("creates <repo>/.worktrees/<name> on child/<name> from the parent's HEAD", async () => {
  const repo = await makeRepo("repo");
  const head = await git(repo, "rev-parse", "HEAD");

  const first = await createChildWorktree(repo, "abcd1234");
  expect(first).toEqual({
    path: join(repo, ".worktrees", "abcd1234"),
    branch: "child/abcd1234",
    baseCommit: head,
  });
  expect(await git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("child/abcd1234");
  expect(await git(first.path, "rev-parse", "HEAD")).toBe(head);
  await createChildWorktree(repo, "efgh5678");

  // Excluded through info/exclude once, not through a tracked .gitignore.
  const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  expect(exclude.split("\n").filter((line) => line === "/.worktrees/")).toHaveLength(1);
  expect(await exists(join(repo, ".gitignore"))).toBe(false);
  expect(await git(repo, "status", "--porcelain")).toBe("");
});

test("a linked parent's child goes under the main checkout and branches from the parent's HEAD", async () => {
  const repo = await makeRepo("repo");
  const lane = join(repo, ".worktrees", "lane");
  await git(repo, "worktree", "add", "-b", "lane/x", lane);
  await writeFile(join(lane, "lane.txt"), "lane\n");
  await git(lane, "add", "-A");
  await git(lane, "commit", "-m", "lane work");
  const laneHead = await git(lane, "rev-parse", "HEAD");

  const child = await createChildWorktree(lane, "1234abcd");
  expect(child.path).toBe(join(repo, ".worktrees", "1234abcd"));
  expect(child.baseCommit).toBe(laneHead);

  // Only app-made children nest as app worktrees; the user's own lane does not.
  expect(await isChildWorktreePath(child.path)).toBe(true);
  expect(await isChildWorktreePath(lane)).toBe(false);
  expect(await isChildWorktreePath(repo)).toBe(false);
  const matcher = appWorktreeRootMatcher(join(repo, "..", "profile-worktrees"));
  expect(await matcher(child.path)).toBe(true);
  expect(await matcher(lane)).toBe(false);
});

test("a folder without commits is refused with a clear message", async () => {
  const bare = join(await realpath(await mkdtemp(join(tmpdir(), "child-worktree-none-"))), "x");
  await mkdir(bare, { recursive: true });
  await expect(createChildWorktree(bare, "abcd1234")).rejects.toThrow(
    /needs a Git checkout with at least one commit/,
  );
});

test("the summary names the branch, commits ahead, and diff --stat against the base", async () => {
  const repo = await makeRepo("repo");
  const worktree = await createChildWorktree(repo, "abcd1234");
  await writeFile(join(worktree.path, "a.txt"), "one\ntwo\n");
  await git(worktree.path, "commit", "-am", "child work");
  await writeFile(join(worktree.path, "README.md"), "# changed\n");
  await writeFile(join(worktree.path, "new.txt"), "new\n");

  const lines = await childWorktreeSummary(worktree);
  expect(lines[0]).toBe(
    `branch: child/abcd1234 (1 commit ahead of ${worktree.baseCommit.slice(0, 12)}; uncommitted changes)`,
  );
  expect(lines[1]).toBe(`worktree: ${worktree.path}`);
  expect(lines.join("\n")).toMatch(/a\.txt\s+\| 1 \+/);
  expect(lines.join("\n")).toMatch(/README\.md\s+\| 2 \+-/);
  expect(lines.join("\n")).toMatch(/2 files changed/);
  expect(lines.at(-1)).toBe(" + 1 untracked file not in the stat");

  const clean = await createChildWorktree(repo, "cafe0001");
  expect(await childWorktreeSummary(clean)).toEqual([
    `branch: child/cafe0001 (0 commits ahead of ${clean.baseCommit.slice(0, 12)})`,
    `worktree: ${clean.path}`,
    "diff --stat vs base: no changes",
  ]);
});

/* ── Orchestration owner: record, writer slot, report, restart ── */

const createdAt = "2026-10-28T00:00:00.000Z";
const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
const prompt = "Do the overlapping work.";

function seedChild(
  n: number,
  overrides?: Partial<OrchestrationChildThread>,
): OrchestrationChildThread {
  return {
    id: `seed-child-${n}`,
    parentWorkspaceId: "ws",
    parentSessionId: "parent",
    childWorkspaceId: "ws",
    childSessionId: `child-session-${n}`,
    title: `Seed child ${n}`,
    goal: `Seed goal ${n}`,
    mode: "worker",
    depth: 1,
    status: "running",
    latestTranscript: `Seed goal ${n}`,
    transcript: [],
    evidence: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function message(id: string, role: "user" | "assistant", text: string): TranscriptMessage {
  return { kind: "message", role, id, text, createdAt };
}

function makeHost(repo: string, children: OrchestrationChildThread[] = []) {
  const state = {
    children,
    sessionStatus: {} as Record<string, "running" | "idle">,
    transcripts: {} as Record<string, TranscriptMessage[]>,
  };
  const createSessionCalls: WorkspaceRef[] = [];
  const isolation: Array<{ sessionId: string; workspacePath: string }> = [];
  const submitted: Array<{ ref: SessionRef; text: string }> = [];
  const reports: string[] = [];
  const worktreeWorkspaces = new Map<string, WorkspaceRef>();
  let counter = 0;
  const host = {
    driver: {
      cancelCurrentRun: async () => {},
      createSession: async (workspace: WorkspaceRef) => {
        counter += 1;
        createSessionCalls.push(workspace);
        const sessionId = `spawned-${counter}`;
        state.sessionStatus[sessionId] = "running";
        return {
          ref: { workspaceId: workspace.workspaceId, sessionId },
          title: `Spawned ${counter}`,
          preview: "",
          status: "running",
          updatedAt: createdAt,
        };
      },
      setChildIsolation: (ref: SessionRef, info: { workspacePath: string }) => {
        isolation.push({ sessionId: ref.sessionId, workspacePath: info.workspacePath });
      },
      sendCustomMessage: async (_ref: SessionRef, custom: { text: string }) => {
        reports.push(custom.text);
      },
      getSessionTree: async () => ({ nodes: [] }),
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [],
      orchestrationChildren: state.children,
    }),
    replaceOrchestrationChildren: (next: readonly OrchestrationChildThread[]) => {
      state.children = [...next];
    },
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    schedulePersistUiState: () => {},
    workspaceRefFromState: (workspaceId: string) =>
      workspaceId === "ws"
        ? { workspaceId: "ws", path: repo, displayName: "repo" }
        : worktreeWorkspaces.get(workspaceId),
    createChildWorktree: async (parentWorkspaceId: string, name: string) => {
      expect(parentWorkspaceId).toBe("ws");
      const worktree = await createChildWorktree(repo, name);
      const workspace = {
        workspaceId: worktree.path,
        path: worktree.path,
        displayName: worktree.branch,
      };
      worktreeWorkspaces.set(workspace.workspaceId, workspace);
      return { workspace, worktree };
    },
    sessionFromState: (ref: SessionRef) => {
      if (ref.sessionId === parentRef.sessionId) {
        return { status: "running", title: "Parent", updatedAt: createdAt };
      }
      const status = state.sessionStatus[ref.sessionId];
      return status ? { status, title: "Child", updatedAt: createdAt } : undefined;
    },
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: (ref: SessionRef) => ref.sessionId === parentRef.sessionId,
    sidekickModelFor: () => undefined,
    defaultScoutModel: () => undefined,
    sidekickThinkingLevelFor: () => undefined,
    defaultScoutThinkingLevel: () => undefined,
    sessionModelFor: () => undefined,
    sessionThinkingLevelFor: () => undefined,
    sessionUsageFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: (ref: SessionRef) => state.transcripts[ref.sessionId] ?? [],
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (ref: SessionRef, text: string) => {
      submitted.push({ ref, text });
      // The stub "runs" the prompt: it lands in the child's transcript.
      const transcript = (state.transcripts[ref.sessionId] ??= []);
      transcript.push(message(`u${transcript.length + 1}`, "user", text));
      return {} as never;
    },
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, state, createSessionCalls, isolation, submitted, reports };
}

test("two overlapping worktree workers run past an unscoped writer, each in its own checkout", async () => {
  const repo = await makeRepo("repo");
  const head = await git(repo, "rev-parse", "HEAD");
  // An unscoped shared-checkout writer claims the whole workspace.
  const { owner, state, createSessionCalls, isolation, submitted } = makeHost(repo, [
    seedChild(1, { title: "Whole-workspace writer", writeScopes: [] }),
  ]);
  state.sessionStatus["child-session-1"] = "running";

  const results = await Promise.all(
    ["call-wt-1", "call-wt-2"].map((toolCallId) =>
      owner.createChildThreadToolResult(parentRef, {
        prompt,
        scope: "apps/desktop",
        isolation: "worktree",
        fresh: true,
        toolCallId,
      }),
    ),
  );
  expect(results.map((result) => result.details.error)).toEqual([undefined, undefined]);
  const spawned = results.map((result) =>
    state.children.find((child) => child.id === result.details.childThreadId)!,
  );
  expect(new Set(spawned.map((child) => child.worktreePath)).size).toBe(2);
  for (const [index, child] of spawned.entries()) {
    const short = child.id.slice(0, 8);
    expect(child).toMatchObject({
      worktreePath: join(repo, ".worktrees", short),
      branch: `child/${short}`,
      baseCommit: head,
      childWorkspaceId: join(repo, ".worktrees", short),
    });
    // A worktree child claims no shared scope.
    expect(child.writeScopes).toBeUndefined();
    // The two spawns run in parallel, so their sessions open in either order.
    expect(createSessionCalls.map((workspace) => workspace.path)).toContain(child.worktreePath);
    expect(isolation.find((entry) => entry.sessionId === child.childSessionId)?.workspacePath).toBe(
      child.worktreePath,
    );
    // The result names the worktree and branch for the lead.
    const text = results[index]!.content.map((part) => ("text" in part ? part.text : "")).join("");
    expect(text).toContain(`worktree: ${child.worktreePath}`);
    expect(text).toContain(`branch: ${child.branch}`);
  }
  // Each brief tells the worker where it runs and that landing is the lead's.
  for (const child of spawned) {
    const brief = submitted.find((entry) => entry.ref.sessionId === child.childSessionId)?.text;
    expect(brief).toMatch(
      new RegExp(
        `^Worktree: you work in your own Git worktree ${child.worktreePath} on branch ${child.branch}`,
      ),
    );
    expect(brief).toContain("The lead lands it.");
    expect(brief).toContain(prompt);
  }

  // Running worktree children never block a shared-checkout writer either.
  state.children = state.children.filter((child) => child.id !== "seed-child-1");
  const shared = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    scope: "apps/desktop",
    fresh: true,
    toolCallId: "call-shared",
  });
  expect(shared.details.error).toBeUndefined();
  expect(
    state.children.find((child) => child.id === shared.details.childThreadId)?.writeScopes,
  ).toEqual(["apps/desktop"]);
});

test("a scout never gets a worktree", async () => {
  const repo = await makeRepo("repo");
  const { owner, state, createSessionCalls } = makeHost(repo);
  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    mode: "scout",
    isolation: "worktree",
    toolCallId: "call-scout",
  });
  expect(result.details.error).toBeUndefined();
  expect(state.children[0]?.worktreePath).toBeUndefined();
  expect(createSessionCalls[0]?.path).toBe(repo);
  expect(await exists(join(repo, ".worktrees"))).toBe(false);
});

test("a worktree spawn outside Git is refused as a tool result", async () => {
  const folder = join(await realpath(await mkdtemp(join(tmpdir(), "child-worktree-plain-"))), "x");
  await mkdir(folder, { recursive: true });
  const { owner, createSessionCalls } = makeHost(folder);
  const result = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    isolation: "worktree",
    toolCallId: "call-no-git",
  });
  expect(createSessionCalls).toHaveLength(0);
  expect(result.details.error).toMatch(
    /Could not create the child worktree: .*at least one commit/,
  );
});

test("the report names the branch and diff stat; the worktree and branch are kept", async () => {
  const repo = await makeRepo("repo");
  const { owner, state, reports } = makeHost(repo);
  const created = await owner.createChildThreadToolResult(parentRef, {
    prompt,
    isolation: "worktree",
    toolCallId: "call-report",
  });
  const child = state.children.find((entry) => entry.id === created.details.childThreadId)!;
  await writeFile(join(child.worktreePath!, "a.txt"), "one\nchanged\n");
  await git(child.worktreePath!, "commit", "-am", "child work");
  state.sessionStatus[child.childSessionId] = "idle";
  state.transcripts[child.childSessionId] = [
    message("u1", "user", prompt),
    message("a1", "assistant", "Changed a.txt."),
  ];

  await owner.reportChildCompletion({
    workspaceId: child.childWorkspaceId,
    sessionId: child.childSessionId,
  });

  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report).toContain(
    `branch: ${child.branch} (1 commit ahead of ${child.baseCommit!.slice(0, 12)})`,
  );
  expect(report).toContain(`worktree: ${child.worktreePath}`);
  expect(report).toMatch(/a\.txt\s+\| 1 \+/);
  expect(report).toContain("the host never merges or removes this worktree");
  // Cleanup policy: the host never deletes the worktree or its branch.
  expect(await exists(child.worktreePath!)).toBe(true);
  expect(await git(repo, "branch", "--list", child.branch!)).toContain(child.branch!);
  expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("init");
});

test("after a restart a worktree child is continued in its worktree, past the writer slot", async () => {
  const repo = await makeRepo("repo");
  const worktree = await createChildWorktree(repo, "beef0001");
  const restored = seedChild(2, {
    title: "Worktree worker",
    status: "complete",
    childWorkspaceId: worktree.path,
    worktreePath: worktree.path,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit,
  });
  const { owner, state, submitted } = makeHost(repo, [
    seedChild(1, { title: "Whole-workspace writer", writeScopes: [] }),
    restored,
  ]);
  state.sessionStatus["child-session-1"] = "running";
  state.sessionStatus["child-session-2"] = "idle";

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "seed-child-2",
    message: "Also cover the edge case.",
  });
  expect(result.details.error).toBeUndefined();
  expect(submitted).toEqual([
    {
      ref: { workspaceId: worktree.path, sessionId: "child-session-2" },
      text: "Also cover the edge case.",
    },
  ]);
});
