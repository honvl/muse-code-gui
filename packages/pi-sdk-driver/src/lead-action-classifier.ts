import { extractChildToolArg } from "./child-isolation.js";

/**
 * Cost classification of a lead-mode tool call.
 *
 * This is NOT a safety boundary (that is the scout policy in child-isolation,
 * which denies anything it cannot prove read-only). The lead keeps its full
 * toolset; this only decides what spends the lead's direct-work budget, so it
 * fails open: a command counts only when it clearly changes project files or
 * runs a build/test/typecheck. Everything else — `cd`, pipes, loops, `$(...)`,
 * `ps`, diagnostics — is a read and stays free.
 */
export type LeadActionKind = "read" | "mutation" | "verification";

export interface LeadAction {
  readonly kind: LeadActionKind;
  /** Short human label for gate messages, e.g. `edit src/a.ts` or `pnpm test`. */
  readonly label: string;
  /** Target file of an edit/write/apply_patch call, for the worker scope hint. */
  readonly path?: string;
}

const READ: LeadAction = { kind: "read", label: "" };

const FILE_TOOLS = new Set(["edit", "write", "apply_patch"]);
const SHELL_TOOLS = new Set(["bash", "bash_background", "shell"]);

export function classifyLeadToolCall(toolName: string, input: unknown): LeadAction {
  if (FILE_TOOLS.has(toolName)) {
    const path = extractChildToolArg(toolName, input)?.trim();
    return path
      ? { kind: "mutation", label: `${toolName} ${path}`, path }
      : { kind: "mutation", label: toolName };
  }
  if (SHELL_TOOLS.has(toolName)) {
    return classifyLeadBashCommand(extractChildToolArg(toolName, input));
  }
  return READ;
}

export function classifyLeadBashCommand(command: string | undefined): LeadAction {
  const raw = command?.trim() ?? "";
  if (!raw) return READ;
  const { text, bodies } = stripHeredocBodies(raw);
  const segments = splitSegments(neutralizeQuotes(text));
  const cdTargets = segments.flatMap((segment) => {
    const [head, target] = segment.split(/\s+/);
    return head === "cd" && target ? [target] : [];
  });
  // Scratch work: every cd goes to a temp dir, so relative writes stay there.
  const scratchOnly = cdTargets.length > 0 && cdTargets.every(isTempPath);
  if (!scratchOnly && scriptWritesFiles(raw, bodies)) {
    return { kind: "mutation", label: `script that writes files (${firstWords(raw)})` };
  }
  let verification: LeadAction | undefined;
  let cwdIsTemp = false;
  for (const segment of segments) {
    const [head, target] = segment.split(/\s+/);
    if (head === "cd") {
      if (target?.startsWith("/") || target?.startsWith("~")) cwdIsTemp = isTempPath(target);
      continue;
    }
    const action = classifySegment(segment, cwdIsTemp);
    if (action.kind === "mutation") return action;
    if (action.kind === "verification") verification ??= action;
  }
  return verification ?? READ;
}

/* ── Shell scanning ─────────────────────────────────────────── */

/** Remove heredoc bodies (their text is data, not commands) and return them separately. */
function stripHeredocBodies(command: string): { text: string; bodies: string[] } {
  const lines = command.split("\n");
  const kept: string[] = [];
  const bodies: string[] = [];
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  let body: string[] = [];
  for (const line of lines) {
    const current = pending[0];
    if (current) {
      const candidate = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate.trim() === current.delimiter) {
        pending.shift();
        bodies.push(body.join("\n"));
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) {
      pending.push({ delimiter: match[3] ?? "", stripTabs: match[1] === "-" });
    }
  }
  if (body.length > 0) bodies.push(body.join("\n"));
  return { text: kept.join("\n"), bodies };
}

const SCRIPT_RUNTIME = /(^|[\s/;&|(])(python3?|node|ruby|perl|deno|bun|swift)(\s|$)/;
const SCRIPT_WRITE =
  /\bopen\([^)]*,\s*\\?['"](?:w|a|x|r\+)b?\+?\\?['"]|\.write_(?:text|bytes)\(|\b(?:writeFileSync|appendFileSync|writeFile|appendFile|rmSync|unlinkSync|renameSync|copyFileSync)\(|\bshutil\.(?:copy\w*|move|rmtree)\(|\bos\.(?:remove|unlink|rename|replace)\(|\bFile\.write\(/;

/** Inline/heredoc scripts can't be parsed; a write-API call in one is a strong mutation signal. */
function scriptWritesFiles(raw: string, bodies: readonly string[]): boolean {
  if (!SCRIPT_RUNTIME.test(raw)) return false;
  return SCRIPT_WRITE.test(raw) || bodies.some((body) => SCRIPT_WRITE.test(body));
}

/**
 * Drop quote characters and replace every shell metacharacter or space inside
 * quotes with `_`, so quoted text stays one inert token that cannot split
 * segments or look like a redirect.
 */
function neutralizeQuotes(text: string): string {
  let out = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"') {
        index += 1;
        out += "_";
      } else {
        out += /[A-Za-z0-9/._~+=:,@%-]/.test(char) ? char : "_";
      }
      continue;
    }
    if (char === "\\") {
      out += "_";
      index += 1;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else {
      out += char;
    }
  }
  return out;
}

function splitSegments(text: string): string[] {
  const scrubbed = text
    .replace(/&>>?/g, " >")
    .replace(/\d*[<>]&(?:\d+|-)/g, " ")
    .replace(/\|&/g, "|")
    .replace(/\$\(/g, "\n");
  return scrubbed
    .split(/&&|\|\||[;|&\n(){}`]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

const TEMP_TARGET = /^(?:\/dev\/|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|_?_?TMPDIR|\/tmp$)/;

function isTempPath(path: string): boolean {
  return TEMP_TARGET.test(path) || path.includes("TMPDIR");
}

interface ParsedSegment {
  readonly tokens: readonly string[];
  readonly redirectTargets: readonly string[];
}

function parseSegment(segment: string): ParsedSegment {
  const words = segment.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  const redirectTargets: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const at = word.indexOf(">");
    if (at < 0) {
      tokens.push(word);
      continue;
    }
    const prefix = word.slice(0, at);
    if (prefix && !/^\d+$/.test(prefix)) tokens.push(prefix);
    let target = word.slice(at).replace(/^>{1,2}\|?/, "");
    if (!target) {
      target = words[index + 1] ?? "";
      index += 1;
    }
    if (target) redirectTargets.push(target);
  }
  return { tokens, redirectTargets };
}

/* ── Command classification ─────────────────────────────────── */

const WRAPPERS = new Set([
  "sudo",
  "env",
  "time",
  "nice",
  "nohup",
  "command",
  "exec",
  "xargs",
  "timeout",
  "caffeinate",
  "stdbuf",
]);
const LEADING_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);

function effectiveCommand(tokens: readonly string[]): readonly string[] {
  let index = 0;
  let afterWrapper = false;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || LEADING_KEYWORDS.has(token)) {
      index += 1;
    } else if (WRAPPERS.has(baseName(token))) {
      afterWrapper = true;
      index += 1;
    } else if (
      afterWrapper &&
      (token.startsWith("-") || /^\d+[smhd]?$/.test(token) || token === "{}")
    ) {
      index += 1;
    } else {
      break;
    }
  }
  return tokens.slice(index);
}

function baseName(token: string): string {
  return token.split("/").pop() ?? token;
}

function firstWords(text: string, count = 6): string {
  const words = text.trim().split(/\s+/).slice(0, count).join(" ");
  return words.length > 60 ? `${words.slice(0, 57)}…` : words;
}

function action(kind: LeadActionKind, argv: readonly string[]): LeadAction {
  return { kind, label: firstWords(argv.join(" ")) };
}

/**
 * In a temp working directory only an absolute non-temp path can touch the
 * project; everything relative (redirects, file ops, git, formatters) is scratch.
 */
function classifySegment(segment: string, cwdIsTemp: boolean): LeadAction {
  const { tokens, redirectTargets } = parseSegment(segment);
  const argv = effectiveCommand(tokens);
  const isAbsolute = (path: string) => path.startsWith("/") || path.startsWith("~");
  const touchesProject = (path: string) => !isTempPath(path) && (!cwdIsTemp || isAbsolute(path));
  const fileTarget = redirectTargets.find(touchesProject);
  if (fileTarget) {
    return { kind: "mutation", label: `write to ${fileTarget}` };
  }
  const result = classifyArgv(argv);
  if (cwdIsTemp && result.kind === "mutation") {
    const reachesProject = argv
      .slice(1)
      .some((arg) => !arg.startsWith("-") && isAbsolute(arg) && touchesProject(arg));
    return reachesProject ? result : READ;
  }
  return result;
}

const FILE_MUTATORS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "truncate",
  "install",
  "unlink",
  "rsync",
  "patch",
  "tee",
  "shred",
]);

const MODE_FIRST = new Set(["chmod", "chown", "chgrp"]);
const DESTINATION_ONLY = new Set(["cp", "ln", "install", "rsync"]);

const DIRECT_VERIFIERS = new Set([
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "ava",
  "pytest",
  "tox",
  "nox",
  "mypy",
  "pyright",
  "xcodebuild",
  "ninja",
  "gradle",
  "gradlew",
  "mvn",
  "rspec",
  "phpunit",
  "ctest",
  "playwright",
]);

function classifyArgv(argv: readonly string[]): LeadAction {
  const head = argv[0];
  if (!head) return READ;
  const cmd = baseName(head);
  const args = argv.slice(1);

  if (FILE_MUTATORS.has(cmd)) {
    const operands = args.filter((arg) => !arg.startsWith("-"));
    // chmod/chown/chgrp take a mode or owner before the paths; copy-like
    // commands only change their destination (the last operand).
    const paths = MODE_FIRST.has(cmd)
      ? operands.slice(1)
      : DESTINATION_ONLY.has(cmd)
        ? operands.slice(-1)
        : operands;
    if (cmd === "tee" && paths.length === 0) return READ;
    return paths.length > 0 && paths.every(isTempPath) ? READ : action("mutation", argv);
  }
  if (cmd === "dd") {
    const out = args.find((arg) => arg.startsWith("of="));
    return out && !isTempPath(out.slice(3)) ? action("mutation", argv) : READ;
  }
  if (cmd === "perl" && args[0] === "-e" && /exec_@ARGV/.test(args[1] ?? "")) {
    // `perl -e 'alarm N; exec @ARGV' cmd …` is the macOS timeout idiom: classify the wrapped command.
    return classifyArgv(args.slice(2));
  }
  if (cmd === "sed" || cmd === "perl" || cmd === "ruby") {
    const inPlace = args.some((arg) => /^-[A-Za-z0-9]*i/.test(arg) || arg.startsWith("--in-place"));
    // Operands after the script are the edited files; editing only temp files is scratch.
    const files = args.filter((arg) => !arg.startsWith("-")).slice(1);
    return inPlace && !(files.length > 0 && files.every(isTempPath))
      ? action("mutation", argv)
      : READ;
  }
  if (cmd === "curl") {
    const flag = args.findIndex((arg) => arg === "-o" || arg === "--output");
    if (flag >= 0) return isTempPath(args[flag + 1] ?? "") ? READ : action("mutation", argv);
    return args.some((arg) => arg === "-O" || arg === "--remote-name")
      ? action("mutation", argv)
      : READ;
  }
  if (cmd === "git") return classifyGit(argv);
  if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) return classifyPackageManager(argv);
  if (["npx", "pnpx", "bunx"].includes(cmd)) return classifyArgv(stripLeadingFlags(args));
  if (DIRECT_VERIFIERS.has(cmd)) return action("verification", argv);
  if (cmd === "make") {
    return args.some((arg) => /^(install|format|fmt)$/.test(arg))
      ? action("mutation", argv)
      : action("verification", argv);
  }
  if (cmd === "node" || cmd === "deno") {
    return args[0] === "--test" || args[0] === "test" ? action("verification", argv) : READ;
  }
  if (cmd === "python" || cmd === "python3") {
    const module = args[0] === "-m" ? args[1] : undefined;
    if (!module) return READ;
    if (module === "pip") {
      return /^(install|uninstall)$/.test(args[2] ?? "") ? action("mutation", argv) : READ;
    }
    return classifyArgv(args.slice(1));
  }
  if (cmd === "pip" || cmd === "pip3" || cmd === "brew") {
    return /^(install|uninstall|upgrade|reinstall)$/.test(args[0] ?? "")
      ? action("mutation", argv)
      : READ;
  }
  if (cmd === "cargo") return classifySubcommand(argv, args[0], CARGO);
  if (cmd === "go") return classifySubcommand(argv, args[0], GO);
  if (cmd === "swift") return classifySubcommand(argv, args[0], SWIFT);
  if (cmd === "dotnet" || cmd === "bazel" || cmd === "bazelisk") {
    return /^(test|build)$/.test(args[0] ?? "") ? action("verification", argv) : READ;
  }
  return classifyFormatter(cmd, argv) ?? READ;
}

const CARGO: Record<string, LeadActionKind> = {
  test: "verification",
  build: "verification",
  check: "verification",
  clippy: "verification",
  nextest: "verification",
  bench: "verification",
  add: "mutation",
  remove: "mutation",
  install: "mutation",
  update: "mutation",
};
const GO: Record<string, LeadActionKind> = {
  test: "verification",
  build: "verification",
  vet: "verification",
  get: "mutation",
  generate: "mutation",
  fmt: "mutation",
};
const SWIFT: Record<string, LeadActionKind> = {
  test: "verification",
  build: "verification",
};

function classifySubcommand(
  argv: readonly string[],
  sub: string | undefined,
  table: Readonly<Record<string, LeadActionKind>>,
): LeadAction {
  if (!sub) return READ;
  if (sub === "fmt") {
    return action(argv.includes("--check") ? "verification" : "mutation", argv);
  }
  if (sub === "mod" && argv.includes("tidy")) return action("mutation", argv);
  const kind = table[sub];
  return kind ? action(kind, argv) : READ;
}

/** Formatters and linters: writing modes mutate, checking modes verify. */
function classifyFormatter(cmd: string, argv: readonly string[]): LeadAction | undefined {
  const has = (...flags: string[]) => flags.some((flag) => argv.includes(flag));
  if (has("--version", "-V", "--help", "-h")) return READ;
  switch (cmd) {
    case "prettier":
      return action(has("--write", "-w") ? "mutation" : "verification", argv);
    case "eslint":
      return action(has("--fix") ? "mutation" : "verification", argv);
    case "biome":
      return action(has("--write", "--fix", "--apply") ? "mutation" : "verification", argv);
    case "ruff":
      if (argv[1] === "format") return action(has("--check") ? "verification" : "mutation", argv);
      return action(has("--fix") ? "mutation" : "verification", argv);
    case "black":
    case "rustfmt":
      return action(has("--check", "--diff") ? "verification" : "mutation", argv);
    case "swiftformat":
      return action(has("--lint") ? "verification" : "mutation", argv);
    case "gofmt":
    case "clang-format":
    case "isort":
    case "autopep8":
      return has("-w", "-i", "--in-place") ? action("mutation", argv) : undefined;
    default:
      return undefined;
  }
}

/* ── git and package managers ───────────────────────────────── */

/** git operations that rewrite working-tree files. Bookkeeping (add, commit, push, branch, tag) stays free. */
const GIT_WORKTREE_WRITERS = new Set([
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "merge",
  "mv",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "switch",
]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function classifyGit(argv: readonly string[]): LeadAction {
  let index = 1;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (GIT_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
    } else if (token.startsWith("-")) {
      index += 1;
    } else {
      break;
    }
  }
  const sub = argv[index];
  if (!sub) return READ;
  // These forms move HEAD or the index only; working-tree files are untouched.
  if (sub === "reset" && argv.includes("--soft")) return READ;
  if (sub === "restore" && argv.includes("--staged") && !argv.includes("--worktree")) return READ;
  if (GIT_WORKTREE_WRITERS.has(sub)) return action("mutation", argv);
  if (sub === "stash") {
    const op = argv[index + 1];
    return op === undefined || /^(push|pop|apply|drop|clear|save)$/.test(op)
      ? action("mutation", argv)
      : READ;
  }
  return READ;
}

const PM_OPTIONS_WITH_VALUE = new Set([
  "--filter",
  "-F",
  "--dir",
  "-C",
  "--prefix",
  "--workspace",
  "--cwd",
]);
const PM_MUTATING = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "un",
  "update",
  "up",
  "upgrade",
  "link",
  "unlink",
  "dedupe",
  "prune",
  "ci",
  "import",
  "patch-commit",
]);

function stripLeadingFlags(args: readonly string[]): readonly string[] {
  let index = 0;
  while (index < args.length && (args[index] ?? "").startsWith("-")) index += 1;
  return args.slice(index);
}

function classifyPackageManager(argv: readonly string[]): LeadAction {
  let index = 1;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (PM_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
    } else if (token.startsWith("-")) {
      index += 1;
    } else {
      break;
    }
  }
  const sub = argv[index];
  if (!sub) return READ;
  if (PM_MUTATING.has(sub)) return action("mutation", argv);
  if (sub === "exec" || sub === "dlx" || sub === "x") {
    return classifyArgv(stripLeadingFlags(argv.slice(index + 1)));
  }
  const script = sub === "run" ? argv[index + 1] : sub;
  if (!script) return READ;
  if (/^(format|fmt|fix)(:|$)/.test(script) || /:(fix|write)$/.test(script)) {
    return action("mutation", argv);
  }
  if (/^(test|tests|typecheck|type-check|tsc|lint|build|check|e2e|verify)(:|-|$)/.test(script)) {
    return action("verification", argv);
  }
  return /test/.test(script) ? action("verification", argv) : READ;
}
