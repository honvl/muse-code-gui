import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Repo-local Git worktrees for orchestration children started with
 * `isolation: "worktree"`.
 *
 * Each child gets `<main checkout>/.worktrees/<name>` on a new branch
 * `child/<name>` from the parent checkout's current HEAD. `/.worktrees/` is
 * added to the repository's `info/exclude` (never to a tracked .gitignore).
 * The app never merges, removes, or prunes these worktrees or branches:
 * landing and cleanup stay with the lead and the user.
 */
export const CHILD_WORKTREES_DIR = ".worktrees";
export const CHILD_BRANCH_PREFIX = "child/";
const EXCLUDE_ENTRY = `/${CHILD_WORKTREES_DIR}/`;
const EXCLUDE_EQUIVALENTS = new Set([
  EXCLUDE_ENTRY,
  `${CHILD_WORKTREES_DIR}/`,
  `/${CHILD_WORKTREES_DIR}`,
  CHILD_WORKTREES_DIR,
]);
const DIFF_STAT_FILE_LINES = 20;

export interface ChildWorktree {
  readonly path: string;
  readonly branch: string;
  /** The parent's HEAD the branch started from; the report diffs against it. */
  readonly baseCommit: string;
}

/** Create the child's worktree and branch from the parent checkout's HEAD. */
export async function createChildWorktree(
  parentPath: string,
  name: string,
): Promise<ChildWorktree> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`Invalid child worktree name: ${name}`);
  }
  let baseCommit: string;
  try {
    baseCommit = await gitLine(parentPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    throw new Error(
      `isolation "worktree" needs a Git checkout with at least one commit; ${parentPath} has none.`,
    );
  }
  const repoRoot = await mainCheckoutRoot(parentPath);
  const path = join(repoRoot, CHILD_WORKTREES_DIR, name);
  const branch = `${CHILD_BRANCH_PREFIX}${name}`;
  // Parallel spawns in one repository take turns on its exclude file and refs.
  await serialized(repoRoot, async () => {
    await ensureChildWorktreesExcluded(parentPath);
    await mkdir(dirname(path), { recursive: true });
    await git(repoRoot, ["worktree", "add", "-b", branch, path, baseCommit]);
  });
  return { path, branch, baseCommit };
}

/**
 * True for a worktree this module created: `<repo>/.worktrees/<name>` with
 * `child/<name>` checked out. Reads the worktree's `.git` file and HEAD only.
 */
export async function isChildWorktreePath(path: string): Promise<boolean> {
  const name = basename(path);
  if (basename(dirname(path)) !== CHILD_WORKTREES_DIR) {
    return false;
  }
  try {
    const dotGit = (await readFile(join(path, ".git"), "utf8")).trim();
    const gitDir = /^gitdir:\s*(.+)$/.exec(dotGit)?.[1]?.trim();
    if (!gitDir) {
      return false;
    }
    const head = (await readFile(join(resolve(path, gitDir), "HEAD"), "utf8")).trim();
    return head === `ref: refs/heads/${CHILD_BRANCH_PREFIX}${name}`;
  } catch {
    return false;
  }
}

/**
 * Lines for the child's report: branch, commits ahead of its base, whether
 * uncommitted work remains, and `git diff --stat` of the worktree against the
 * base (committed plus uncommitted tracked changes; untracked files counted).
 */
export async function childWorktreeSummary(worktree: ChildWorktree): Promise<readonly string[]> {
  const base = worktree.baseCommit;
  try {
    const [ahead, status, stat] = await Promise.all([
      gitLine(worktree.path, ["rev-list", "--count", `${base}..HEAD`]),
      git(worktree.path, ["status", "--porcelain"]),
      git(worktree.path, ["diff", "--stat", base]),
    ]);
    const statusLines = status.split("\n").filter(Boolean);
    const untracked = statusLines.filter((line) => line.startsWith("??")).length;
    const statLines = stat.split("\n").filter((line) => line.trim());
    const summary = statLines.pop();
    const shown = statLines.slice(0, DIFF_STAT_FILE_LINES).map((line) => line.trimEnd());
    const hidden = statLines.length - shown.length;
    return [
      `branch: ${worktree.branch} (${ahead} commit${ahead === "1" ? "" : "s"} ahead of ${base.slice(0, 12)}` +
        (statusLines.length > 0 ? "; uncommitted changes" : "") +
        ")",
      `worktree: ${worktree.path}`,
      `diff --stat vs base:${summary ? "" : " no changes"}`,
      ...shown,
      ...(hidden > 0 ? [` … ${hidden} more file${hidden === 1 ? "" : "s"}`] : []),
      ...(summary ? [summary.trimEnd()] : []),
      ...(untracked > 0
        ? [` + ${untracked} untracked file${untracked === 1 ? "" : "s"} not in the stat`]
        : []),
    ];
  } catch (error) {
    return [
      `branch: ${worktree.branch}`,
      `worktree: ${worktree.path}`,
      `diff --stat unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/** Root of the repository's main checkout, so linked parents share one `.worktrees`. */
async function mainCheckoutRoot(parentPath: string): Promise<string> {
  const commonDir = resolve(
    parentPath,
    await gitLine(parentPath, ["rev-parse", "--git-common-dir"]),
  );
  if (basename(commonDir) === ".git") {
    return dirname(commonDir);
  }
  // Bare or unusual layout: fall back to the parent's own checkout.
  return gitLine(parentPath, ["rev-parse", "--show-toplevel"]);
}

/** Add `/.worktrees/` to the shared `info/exclude` once. */
export async function ensureChildWorktreesExcluded(checkoutPath: string): Promise<void> {
  const excludePath = resolve(
    checkoutPath,
    await gitLine(checkoutPath, ["rev-parse", "--git-path", "info/exclude"]),
  );
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    await mkdir(dirname(excludePath), { recursive: true });
  }
  if (current.split(/\r?\n/).some((line) => EXCLUDE_EQUIVALENTS.has(line.trim()))) {
    return;
  }
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(excludePath, `${separator}${EXCLUDE_ENTRY}\n`, "utf8");
}

const queues = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task with the same key has settled. */
async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const settled = run.catch(() => undefined);
  queues.set(key, settled);
  try {
    return await run;
  } finally {
    if (queues.get(key) === settled) {
      queues.delete(key);
    }
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout;
}

/** Inherited routing variables (from a hook, say) must not redirect these calls. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}

async function gitLine(cwd: string, args: readonly string[]): Promise<string> {
  return (await git(cwd, args)).trim();
}
