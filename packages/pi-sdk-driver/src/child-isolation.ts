import { isAbsolute, normalize, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

/**
 * OpenCode-style subagent isolation for pi-gui child threads.
 *
 * Context isolation already exists (separate session transcript, prompt-only
 * handoff). This module adds the remaining two legs:
 * - permission isolation: scout (read-only) vs worker (full), plus
 *   deny-lists that apply to every child (destructive bash, .env writes,
 *   paths outside the workspace).
 * - recursion isolation: a depth cap so a child cannot spin up an unbounded
 *   delegation chain.
 *
 * Enforcement runs as a hidden inline extension on pi's `tool_call` hook
 * (released API, same pattern as the invalid-tool-call guard). Prompt text
 * alone is not a boundary: the gate blocks before the tool executes and the
 * model receives a visible reason.
 */

export type ChildThreadMode = "scout" | "worker";

export interface ChildIsolationInfo {
  readonly mode: ChildThreadMode;
  readonly workspacePath: string;
  readonly depth: number;
}

/** Delegation chains deeper than this are rejected. Mirrors the desktop owner. */
export const MAX_CHILD_DEPTH = 3;

/**
 * Tools a scout child may never execute. Everything else stays callable.
 *
 * `bash` is intentionally NOT listed: scouts may run read-only shell commands
 * (see `isScoutReadOnlyBashCommand`). `bash_background` stays blocked — a
 * read-only sweep has no reason to outlive its turn.
 */
export const SCOUT_BLOCKED_TOOLS: readonly string[] = ["edit", "write", "bash_background"];

/** File tools whose path argument is checked against the workspace root. */
const FILE_PATH_TOOLS: readonly string[] = ["read", "edit", "write", "ls", "grep", "find"];

/** Bash commands that are never allowed inside a child thread. */
const DENIED_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+[^;|&]*-rf?\b\s*(["']?)(\/|\/\*|~\/\*?|~|\$HOME)(["'\s;|&]|$)/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;?\s*:/,
];

export interface ChildToolDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(input: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** Argument a permission pattern is matched against, per tool. */
export function extractChildToolArg(toolName: string, input: unknown): string | undefined {
  switch (toolName) {
    case "bash":
    case "bash_background":
    case "powershell":
    case "shell":
      return stringField(input, "command");
    case "read":
    case "edit":
    case "write":
    case "apply_patch":
    case "ls":
      return stringField(input, "file_path", "path");
    case "grep":
    case "find":
      return stringField(input, "path", "pattern");
    default:
      return stringField(input, "path", "file_path", "command", "pattern", "url");
  }
}

/** Glob match with `*` (no `/` crossing) and `**` (crosses `/`). */
export function matchIsolationPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === value;
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "") break;
    if (char === "*" && (pattern[i + 1] ?? "") === "*") {
      if ((pattern[i + 2] ?? "") === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else if ("+.^${}()|[]\\".includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  return new RegExp(`^${regex}$`).test(value);
}

function workspaceRoot(workspacePath: string): string {
  const normalized = normalize(workspacePath);
  return normalized.endsWith(sep) ? normalized : `${normalized}${sep}`;
}

/** True when the tool's path argument escapes the workspace root. */
export function isOutsideWorkspace(workspacePath: string, rawArg: string | undefined): boolean {
  if (!rawArg) return false;
  const trimmed = rawArg.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("~")) return true;
  // Check the literal prefix before any glob: a glob cannot excuse escaping.
  const globIndex = trimmed.search(/[*?[]/);
  const literal = globIndex >= 0 ? trimmed.slice(0, globIndex) : trimmed;
  const probe = literal === "" || literal.endsWith("/") ? `${literal}probe` : literal;
  const resolved = isAbsolute(probe) ? normalize(probe) : resolve(workspacePath, probe);
  const root = workspaceRoot(workspacePath);
  return !(resolved === normalize(workspacePath) || resolved.startsWith(root));
}

function basenameOf(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const last = normalized.lastIndexOf("/");
  return last >= 0 ? normalized.slice(last + 1) : normalized;
}

/** `.env` writes are denied except for the checked-in example template. */
export function isDeniedEnvWrite(toolName: string, rawArg: string | undefined): boolean {
  if (toolName !== "edit" && toolName !== "write") return false;
  if (!rawArg) return false;
  const base = basenameOf(rawArg.trim());
  if (base === ".env.example") return false;
  return (
    matchIsolationPattern(".env", base) || matchIsolationPattern(".env.*", base) || base === ".env"
  );
}

export function isDeniedBashCommand(command: string | undefined): boolean {
  if (!command) return false;
  return DENIED_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Read-only shell policy for scout threads.
 *
 * A scout `bash` command is allowed only when every `|` / `&&` / `;` /
 * newline segment is a pure reader: its first token is in
 * {@link SCOUT_READ_ONLY_TOOLS} and the segment has no output redirection
 * (`>`, including `>>`), no command substitution (`$(...)` / backticks),
 * and no subshell grouping. `sed`/`find`/`git` get extra guards because
 * each has a mutating mode behind an allowlisted name. Package managers
 * (npm/pnpm/yarn/brew/pip), file mutators (rm/mv/cp/chmod/chown), killers
 * (kill), network tools (curl/wget/ssh), and everything else (sudo, docker,
 * open, node, echo, tee, xargs, …) deny by default: anything not explicitly
 * classified as read-only is not read-only.
 *
 * Two inert redirections are scrubbed before parsing because they are part
 * of the canonical read-only idiom: fd duplication (`2>&1`) and the null
 * sink (`>/dev/null`, `2>/dev/null`). Both discard output without writing
 * anything persistent.
 *
 * Read-only is not enough on its own: a scout `bash` command is additionally
 * confined to the child workspace (see `scoutBashWorkspaceViolation`). Every
 * segment's path-like arguments must resolve inside the workspace root, and
 * `$` expansions are denied outright because they cannot be resolved
 * statically (`$HOME` may point anywhere). Worker mode is untouched.
 */

/** First-token allowlist for scout `bash`: pure readers and text filters. */
export const SCOUT_READ_ONLY_TOOLS: readonly string[] = [
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "sed",
  "awk",
  "gawk",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "diff",
  "stat",
  "file",
  "pwd",
  "git",
  "gh",
];

/** `git` subcommands a scout may run. Writes (commit/push/…) deny by default. */
export const SCOUT_READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = [
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "blame",
  "grep",
  "tag",
];

/** `gh` (GitHub CLI) group/subcommand pairs a scout may run: views, lists, and GET API calls. */
export const SCOUT_READ_ONLY_GH_COMMANDS: readonly (readonly [group: string, sub: string])[] = [
  ["run", "view"],
  ["run", "list"],
  ["release", "view"],
  ["release", "list"],
  ["repo", "view"],
  ["pr", "view"],
  ["pr", "list"],
];

/** `gh` flags that consume the following token as a value (`gh -R owner/repo run view`). */
const GH_FLAGS_WITH_VALUE: readonly string[] = ["-R", "--repo"];

/** `git tag` flags that create, delete, or sign tags (`git tag --list` stays read-only). */
const DENIED_GIT_TAG_FLAGS: readonly string[] = [
  "-a",
  "--annotate",
  "-s",
  "--sign",
  "-u",
  "--local-user",
  "-d",
  "--delete",
  "-f",
  "--force",
  "-m",
  "--message",
  "-F",
  "--file",
];

/** `git` flags that consume the following token as a value (`git -C <path> log`).
 * `-c`/`--config` are deliberately absent: they deny outright (see `checkScoutGit`). */
const GIT_FLAGS_WITH_VALUE: readonly string[] = ["-C", "--git-dir", "--work-tree"];

/** `find` primaries that can create, delete, or execute (`-exec`, `-delete`, …). */
const DENIED_FIND_PRIMARIES: readonly string[] = [
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
];

function scrubInertRedirections(command: string): string {
  return command.replace(/\d?>\s*&\d+/g, "").replace(/\d?>>?\s*\/dev\/null/g, "");
}

/** Split on unquoted `|`, `&&`, `||`, `;`, `&`, and newlines. Undefined = unbalanced quotes. */
function splitScoutSegments(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  let escaped = false;
  const push = (): void => {
    segments.push(current);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (single) {
      if (ch === "'") single = false;
      current += ch;
      continue;
    }
    if (double) {
      if (ch === '"') double = false;
      current += ch;
      continue;
    }
    if (ch === "'") {
      single = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      double = true;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      push();
      continue;
    }
    if (ch === "&") {
      if ((command[i + 1] ?? "") === "&") i++;
      push();
      continue;
    }
    if (ch === "|") {
      if ((command[i + 1] ?? "") === "|") i++;
      push();
      continue;
    }
    current += ch;
  }
  if (single || double || escaped) return undefined;
  segments.push(current);
  return segments;
}

interface ScoutSegmentScan {
  readonly tokens: string[];
  readonly hasRedirect: boolean;
  readonly hasGroup: boolean;
}

/** Tokenize one segment (quotes removed, backslash honored) and flag unquoted `>`/`(`/`)`. */
function scanScoutSegment(segment: string): ScoutSegmentScan {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let hasRedirect = false;
  let hasGroup = false;
  let single = false;
  let double = false;
  let escaped = false;
  const flush = (): void => {
    if (hasToken) {
      tokens.push(current);
      current = "";
      hasToken = false;
    }
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (escaped) {
      current += ch;
      hasToken = true;
      escaped = false;
      continue;
    }
    if (single) {
      if (ch === "'") single = false;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (double) {
      if (ch === '"') double = false;
      else if (ch === "\\") escaped = true;
      else current += ch;
      hasToken = true;
      continue;
    }
    switch (ch) {
      case "\\":
        escaped = true;
        hasToken = true;
        break;
      case "'":
        single = true;
        hasToken = true;
        break;
      case '"':
        double = true;
        hasToken = true;
        break;
      case ">":
        hasRedirect = true;
        flush();
        break;
      case "(":
      case ")":
        hasGroup = true;
        flush();
        break;
      case " ":
      case "\t":
      case "\r":
      case "\f":
      case "\v":
        flush();
        break;
      default:
        current += ch;
        hasToken = true;
        break;
    }
  }
  flush();
  return { tokens, hasRedirect, hasGroup };
}

/** First real token, skipping `KEY=value` env prefixes. */
function firstScoutToken(tokens: readonly string[]): string | undefined {
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (isScoutEnvAssignment(token)) continue;
    return token;
  }
  return undefined;
}

function checkScoutGit(tokens: readonly string[]): string | undefined {
  let skipValue = false;
  let sawCommand = false;
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (!sawCommand) {
      // Skip `KEY=value` env prefixes; the first real token is the `git` binary itself.
      if (isScoutEnvAssignment(token)) continue;
      sawCommand = true;
      continue;
    }
    // `-c`/`--config*` can point git at arbitrary executables
    // (`core.fsmonitor`, `core.pager`), so they deny outright. `-C` and
    // `--git-dir`/`--work-tree` stay allowed: their values are workspace-checked.
    if (token === "-c" || token.startsWith("--config")) {
      return `"${token}" can change git behavior and is not allowed.`;
    }
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (GIT_FLAGS_WITH_VALUE.includes(token)) {
      skipValue = true;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (!SCOUT_READ_ONLY_GIT_SUBCOMMANDS.includes(token)) {
      return `"git ${token}" is not a read-only git subcommand.`;
    }
    if (token === "tag") {
      return checkScoutGitTag(tokens);
    }
    return undefined;
  }
  return "no git subcommand was provided.";
}

/**
 * `git tag` lists tags only with `--list`/`-l`. A bare `git tag <name>`
 * creates a tag, so anything without an explicit list flag denies, as do
 * the create/delete/sign flags even alongside `--list`.
 */
function checkScoutGitTag(tokens: readonly string[]): string | undefined {
  let listed = false;
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (token === "--list" || token === "-l") {
      listed = true;
      continue;
    }
    if (DENIED_GIT_TAG_FLAGS.includes(token) || token.startsWith("--local-user=")) {
      return `"git tag ${token}" can mutate tags and is not allowed.`;
    }
  }
  if (!listed) {
    return `"git tag" without --list can create a tag; use "git tag --list".`;
  }
  return undefined;
}

/**
 * `gh` allows read-only views/lists plus `gh api` with GET (the default
 * when no method flag is present). Anything else — `release create`,
 * `pr create`, `run cancel`, `workflow run`, non-GET `api` — denies.
 * Positional arguments (ids, filters) and unrelated flags are ignored;
 * `-R`/`--repo` consume their value so `owner/repo` is not misread as
 * the command pair.
 */
function checkScoutGh(tokens: readonly string[]): string | undefined {
  let sawGh = false;
  let skipValue = false;
  let group: string | undefined;
  let sub: string | undefined;
  let method: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.length === 0) continue;
    if (!sawGh) {
      // Skip `KEY=value` env prefixes; the first real token is the `gh` binary itself.
      if (isScoutEnvAssignment(token)) continue;
      sawGh = true;
      continue;
    }
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (GH_FLAGS_WITH_VALUE.includes(token)) {
      skipValue = true;
      continue;
    }
    if (token === "-X" || token === "--method") {
      const value = tokens[index + 1];
      if (typeof value !== "string" || value.trim().length === 0) {
        return `"gh api" has a method flag without a value.`;
      }
      method = value;
      skipValue = true;
      continue;
    }
    if (token.startsWith("-X") && token.length > 2) {
      method = token.slice(2);
      continue;
    }
    if (token.startsWith("--method=")) {
      method = token.slice("--method=".length);
      continue;
    }
    if (token.startsWith("-")) continue;
    if (group === undefined) {
      group = token;
      continue;
    }
    if (sub === undefined) {
      sub = token;
      continue;
    }
    // Further positionals (ids, JSON fields, filters) are ignored.
  }
  if (group === undefined) return "no gh subcommand was provided.";
  if (group === "api") {
    if (method !== undefined && method.trim().toUpperCase() !== "GET") {
      return `"gh api -X ${method.trim()}" can mutate and is not allowed.`;
    }
    return undefined;
  }
  if (sub === undefined) return `"gh ${group}" needs a read-only subcommand.`;
  if (!SCOUT_READ_ONLY_GH_COMMANDS.some(([g, s]) => g === group && s === sub)) {
    return `"gh ${group} ${sub}" is not a read-only gh command.`;
  }
  return undefined;
}

function checkScoutSed(segment: string, tokens: readonly string[]): string | undefined {
  for (const token of tokens.slice(1)) {
    if (token === "--in-place" || token.startsWith("--in-place=")) {
      return `"sed --in-place" modifies files and is not allowed.`;
    }
    if (token.startsWith("-") && !token.startsWith("--") && token.includes("i")) {
      return `"sed ${token}" modifies files in place and is not allowed.`;
    }
  }
  // Best-effort guard for the `w file` write command (`/re/w out`, `1w out`,
  // `$w out`). Deny on uncertainty; plain print scripts never match this.
  if (/(^|[;{]|\/\s*|\$\s*|[0-9,]\s+)w\s+\S/.test(segment)) {
    return `"sed w" writes to a file and is not allowed.`;
  }
  return undefined;
}

function checkScoutFind(tokens: readonly string[]): string | undefined {
  for (const token of tokens.slice(1)) {
    if (DENIED_FIND_PRIMARIES.includes(token)) {
      return `"find ${token}" can modify files and is not allowed.`;
    }
  }
  return undefined;
}

/** Undefined (empty) detail means the segment is allowed. */
function checkScoutSegment(segment: string): string | undefined {
  const scan = scanScoutSegment(segment);
  if (scan.hasRedirect) return "output redirection (>) is not allowed.";
  if (scan.hasGroup) return "subshells and grouping are not allowed.";
  for (const token of scan.tokens) {
    if (!isScoutEnvAssignment(token)) break;
    const name = token.slice(0, token.indexOf("="));
    if (!SCOUT_SAFE_ENV_NAMES.includes(name)) {
      return `"${name}" environment overrides are not allowed.`;
    }
  }
  const first = firstScoutToken(scan.tokens);
  if (!first) return "no command was provided.";
  const base = first.split("/").pop() ?? "";
  if (base.length === 0) return "no command was provided.";
  if (!SCOUT_READ_ONLY_TOOLS.includes(base)) return `"${base}" is not read-only.`;
  if (base === "git") return checkScoutGit(scan.tokens);
  if (base === "gh") return checkScoutGh(scan.tokens);
  if (base === "sed") return checkScoutSed(segment, scan.tokens);
  if (base === "find") return checkScoutFind(scan.tokens);
  return undefined;
}

function scoutBashVerdict(command: string | undefined): {
  readonly allowed: boolean;
  readonly detail: string;
} {
  const raw = command?.trim() ?? "";
  if (raw.length === 0) return { allowed: false, detail: "no command was provided." };
  // Substitution executes even inside double quotes, so deny on any occurrence
  // rather than trying to guess whether a quoting context neutralizes it.
  if (raw.includes("$(") || raw.includes("`")) {
    return { allowed: false, detail: "command substitution is not allowed." };
  }
  const segments = splitScoutSegments(scrubInertRedirections(raw));
  if (!segments) {
    return { allowed: false, detail: "the command could not be parsed safely." };
  }
  const meaningful = segments.filter((segment) => segment.trim().length > 0);
  if (meaningful.length === 0) return { allowed: false, detail: "no command was provided." };
  for (const segment of meaningful) {
    const detail = checkScoutSegment(segment);
    if (detail) return { allowed: false, detail };
  }
  return { allowed: true, detail: "" };
}

/** True when a scout thread may run this `bash` command (read-only policy).
 * Workspace confinement is applied separately in `decideChildToolCall`. */
export function isScoutReadOnlyBashCommand(command: string | undefined): boolean {
  return scoutBashVerdict(command).allowed;
}

/** A token that looks like a filesystem path: contains `/`, is `.`/`..`, or starts with `~`. */
function isScoutPathLike(token: string): boolean {
  return token.includes("/") || token === "." || token === ".." || token.startsWith("~");
}

const SCOUT_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `KEY=value` shell env prefix (leading position only; mid-argv `A=b` is a pattern). */
function isScoutEnvAssignment(token: string): boolean {
  const eq = token.indexOf("=");
  return eq > 0 && SCOUT_ENV_NAME.test(token.slice(0, eq));
}

/**
 * Env prefixes a scout may set: locale/output shaping only. Anything else
 * (`GIT_PAGER`, `GIT_SSH`, `LD_PRELOAD`, `PATH`, …) can redirect execution
 * to an unvetted binary, so it denies — report back and let the parent run it.
 */
const SCOUT_SAFE_ENV_NAMES: readonly string[] = [
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
];

/**
 * Path arguments of one segment's argv. The command itself (first real
 * token) is skipped — binaries live outside the workspace — but leading
 * `KEY=value` env prefixes contribute their values (`GIT_DIR=/tmp/x` must
 * not smuggle a repo) and `flag=value` forms contribute the value
 * (`--git-dir=/tmp/x`). Search patterns that merely look relative resolve
 * inside the workspace and stay allowed; absolute-looking patterns deny
 * (deny on uncertainty).
 */
function scoutPathCandidates(tokens: readonly string[]): string[] {
  const candidates: string[] = [];
  let sawCommand = false;
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (!sawCommand) {
      const eq = token.indexOf("=");
      if (isScoutEnvAssignment(token)) {
        const value = token.slice(eq + 1);
        if (isScoutPathLike(value)) candidates.push(value);
        continue;
      }
      sawCommand = true;
      continue;
    }
    if (token.startsWith("-")) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        const value = token.slice(eq + 1);
        if (isScoutPathLike(value)) candidates.push(value);
      }
      continue;
    }
    if (isScoutPathLike(token)) candidates.push(token);
  }
  return candidates;
}

/**
 * True when a segment contains a `$` expansion outside single quotes.
 * Single-quoted `$` is literal text; everything else (`$HOME`, `${x}`,
 * `$1` in double quotes, …) expands at runtime to something static analysis
 * cannot resolve, so it denies. Backslash-escaped `\$` is literal and safe.
 */
function hasScoutExpansion(segment: string): boolean {
  let single = false;
  let escaped = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (single) {
      if (ch === "'") single = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      single = true;
      continue;
    }
    if (ch === "$") {
      const next = segment[i + 1] ?? "";
      if (/[A-Za-z0-9_{(!#?*@$\-'"`]/.test(next)) return true;
    }
  }
  return false;
}

/**
 * Workspace confinement for scout bash (worker mode is untouched).
 * Every segment's path-like arguments must resolve inside the workspace
 * root (via `isOutsideWorkspace`, which already handles absolute paths,
 * `..` traversal, `~`, and globs); `$` expansions deny outright.
 * Returns the offending argument, or undefined when confined. Unparseable
 * input returns undefined — the read-only policy already denies that.
 */
function scoutBashWorkspaceViolation(workspacePath: string, command: string): string | undefined {
  const segments = splitScoutSegments(scrubInertRedirections(command));
  if (!segments) return undefined;
  for (const segment of segments) {
    if (segment.trim().length === 0) continue;
    const { tokens } = scanScoutSegment(segment);
    if (hasScoutExpansion(segment)) {
      return tokens.find((token) => token.includes("$")) ?? "$";
    }
    for (const candidate of scoutPathCandidates(tokens)) {
      if (isOutsideWorkspace(workspacePath, candidate)) return candidate;
    }
  }
  return undefined;
}

/** Requested child mode from `create_child_thread` input; absent means worker. */
export function requestedChildMode(input: unknown): ChildThreadMode | undefined {
  if (!isRecord(input)) return undefined;
  const mode = input.mode;
  if (mode === "scout" || mode === "worker") return mode;
  return undefined;
}

/**
 * Decide whether a tool call may run inside a child session.
 * Non-child sessions are not gated (resolver returns undefined upstream).
 */
export function decideChildToolCall(
  toolName: string,
  input: unknown,
  isolation: ChildIsolationInfo,
): ChildToolDecision {
  if (toolName === "create_child_thread") {
    if (isolation.depth >= MAX_CHILD_DEPTH) {
      return {
        allowed: false,
        reason: `Permission denied: delegation depth ${isolation.depth} reached the limit of ${MAX_CHILD_DEPTH}; summarize instead of spawning another child.`,
      };
    }
    const requested = requestedChildMode(input) ?? "worker";
    if (isolation.mode === "scout" && requested === "worker") {
      return {
        allowed: false,
        reason:
          'Permission denied: a scout (read-only) thread cannot spawn a worker thread; request mode "scout" or report back to the parent.',
      };
    }
    return { allowed: true };
  }

  if (isolation.mode === "scout" && SCOUT_BLOCKED_TOOLS.includes(toolName)) {
    return {
      allowed: false,
      reason: `Permission denied: scout (read-only) threads cannot use "${toolName}"; report findings to the parent instead.`,
    };
  }

  const arg = extractChildToolArg(toolName, input);
  if (toolName === "bash" && isolation.mode === "scout") {
    const verdict = scoutBashVerdict(arg);
    if (!verdict.allowed) {
      return {
        allowed: false,
        reason: `Permission denied: scout (read-only) threads may run read-only shell commands (rg, grep, ls, git log …); ${verdict.detail} Report findings to the parent instead.`,
      };
    }
    const escaped =
      typeof arg === "string"
        ? scoutBashWorkspaceViolation(isolation.workspacePath, arg)
        : undefined;
    if (escaped) {
      return {
        allowed: false,
        reason: `Permission denied: scout (read-only) threads are confined to the workspace; "${escaped}" is outside it.`,
      };
    }
  }
  if (FILE_PATH_TOOLS.includes(toolName) && isOutsideWorkspace(isolation.workspacePath, arg)) {
    return {
      allowed: false,
      reason: `Permission denied: "${toolName}" cannot access paths outside the workspace (${arg ?? "unknown path"}).`,
    };
  }
  if (isDeniedEnvWrite(toolName, arg)) {
    return {
      allowed: false,
      reason: `Permission denied: "${toolName}" cannot write dotenv files (${arg ?? "unknown path"}); the parent must apply secrets explicitly.`,
    };
  }
  if ((toolName === "bash" || toolName === "bash_background") && isDeniedBashCommand(arg)) {
    return {
      allowed: false,
      reason: `Permission denied: destructive shell command blocked (${(arg ?? "").trim().slice(0, 80)}).`,
    };
  }
  return { allowed: true };
}

/** Hidden inline extension: blocks gated child tool calls before execution. */
export function createChildIsolationExtension(
  resolveIsolation: (ctx: ExtensionContext) => ChildIsolationInfo | undefined,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event, ctx) => {
      const isolation = resolveIsolation(ctx);
      if (!isolation) return undefined;
      const input = (event as { readonly input?: unknown }).input ?? {};
      const toolName = (event as { readonly toolName?: unknown }).toolName;
      if (typeof toolName !== "string" || toolName.length === 0) return undefined;
      const decision = decideChildToolCall(toolName, input, isolation);
      if (decision.allowed) return undefined;
      return { block: true, reason: decision.reason ?? `Permission denied: "${toolName}".` };
    });
  };
}
