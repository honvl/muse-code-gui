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

/** Tools a scout child may never execute. Everything else stays callable. */
export const SCOUT_BLOCKED_TOOLS: readonly string[] = ["edit", "write", "bash", "bash_background"];

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
