import { homedir } from "node:os";

/**
 * Single-writer scope helpers (phase A).
 *
 * A child brief's optional `scope` field names the files/areas the child may
 * write. Each scope is a set of path tokens; every token is a path prefix:
 * `apps/desktop` covers `apps/desktop/src/x.ts`, while `apps/desktop/src`
 * does not cover `apps/desktop/electron`.
 *
 * Scopes are free text written by a model, so parsing keeps only path tokens:
 * - parenthetical/bracketed asides are dropped;
 * - a comma/semicolon-separated item that is a single word (`docs`) is a path;
 *   inside prose items only path-shaped tokens count (containing `/`, a file
 *   extension, or a leading dot);
 * - absolute (`/…`, `~/…`) paths inside the workspace become
 *   workspace-relative; ones outside it are reported in `outsideWorkspace`
 *   and never become tokens; a token naming the workspace root adds nothing.
 *
 * A scope with no path tokens (`undefined`/`""`/prose only/only the root)
 * means the whole workspace and therefore overlaps everything. Comparison is
 * case-insensitive; leading `./` and trailing `/` are stripped.
 *
 * Workers with disjoint scopes share one checkout, so scopes are advisory for
 * shared artifacts: build outputs, lockfiles and the Git index can still
 * collide. Each worker's claimed scope is persisted on its child record
 * (`writeScopes`).
 */

export interface AnalyzedWriteScope {
  /** Normalized, de-duplicated, workspace-relative path tokens. */
  readonly tokens: readonly string[];
  /** Absolute paths from the scope that lie outside the workspace, as written. */
  readonly outsideWorkspace: readonly string[];
}

/** Parse a raw scope string into normalized, de-duplicated path tokens. */
export function parseWriteScope(
  raw: string | undefined,
  workspacePath?: string,
): readonly string[] {
  return analyzeWriteScope(raw, workspacePath).tokens;
}

/**
 * Parse a raw scope and report absolute paths that fall outside the
 * workspace. Without `workspacePath`, absolute paths are kept as absolute
 * tokens (leading `/`), so they never collide with relative ones.
 */
export function analyzeWriteScope(
  raw: string | undefined,
  workspacePath?: string,
): AnalyzedWriteScope {
  const text = stripAsides(raw ?? "").trim();
  if (!text) {
    return { tokens: [], outsideWorkspace: [] };
  }
  const root = workspacePath ? normalizeAbsolute(workspacePath) : undefined;
  const seen = new Set<string>();
  const tokens: string[] = [];
  const outsideWorkspace: string[] = [];
  for (const item of text.split(/[,;\n]+/)) {
    const words = item
      .split(/\s+/)
      .map(cleanWord)
      .filter((word) => word.length > 0);
    // A lone word item ("docs") is a path; in prose only path-shaped words count.
    const candidates = words.length === 1 ? words : words.filter(isPathShaped);
    for (const candidate of candidates) {
      let relative: string;
      if (root !== undefined) {
        // Resolve against the workspace so `..` and absolute paths compare alike.
        const absolute = normalizeAbsolute(
          isAbsoluteLike(candidate) ? candidate : `${root}/${candidate}`,
        );
        if (absolute === root) {
          continue; // The workspace root itself: no narrower claim.
        }
        if (!absolute.startsWith(`${root}/`)) {
          outsideWorkspace.push(candidate);
          continue;
        }
        relative = absolute.slice(root.length + 1);
      } else if (isAbsoluteLike(candidate)) {
        relative = normalizeAbsolute(candidate);
      } else {
        relative = normalizeWriteScopeToken(candidate);
      }
      if (!relative || relative === "/" || seen.has(relative)) {
        continue;
      }
      seen.add(relative);
      tokens.push(relative);
    }
  }
  return { tokens, outsideWorkspace };
}

/** Drop `( … )`, `[ … ]` and `{ … }` asides, including an unclosed trailing one. */
function stripAsides(value: string): string {
  let result = value;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/g, " ");
  } while (result !== previous);
  return result.replace(/[([{].*$/s, " ");
}

/** Trim quotes, backticks and sentence punctuation around a word. */
function cleanWord(word: string): string {
  return word.replace(/^[\s"'`<]+/, "").replace(/[\s"'`>.:!?]+$/, "");
}

function isPathShaped(word: string): boolean {
  return (
    word.includes("/") ||
    word.includes("\\") ||
    word.startsWith("~") ||
    /^\.[\w-]/.test(word) ||
    /^[\w@-][\w.@-]*\.[a-z0-9]{1,10}$/i.test(word)
  );
}

function isAbsoluteLike(word: string): boolean {
  return word.startsWith("/") || word === "~" || word.startsWith("~/");
}

/**
 * Lowercased absolute path with `~` expanded, `.`/empty segments dropped,
 * `..` resolved, and everything from the first glob segment on cut off.
 */
function normalizeAbsolute(value: string): string {
  const expanded =
    value === "~" || value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value;
  const segments: string[] = [];
  for (const segment of pathSegments(expanded)) {
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** Workspace-relative token without a workspace to resolve against; `..` drops it. */
function normalizeWriteScopeToken(token: string): string {
  const segments = pathSegments(token);
  return segments.includes("..") ? "" : segments.join("/");
}

function pathSegments(value: string): string[] {
  const segments: string[] = [];
  for (const raw of value.replace(/\\/g, "/").toLowerCase().split("/")) {
    const segment = raw.trim();
    if (!segment || segment === ".") continue;
    if (/[*?]/.test(segment)) break;
    segments.push(segment);
  }
  return segments;
}

/**
 * True when two parsed scopes overlap: either side is empty (whole
 * workspace), or any token pair is equal or one is a path-prefix of the
 * other (segment-aware, so `apps/desktop` does not cover `apps/desktop2`).
 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return true;
  }
  for (const left of a) {
    for (const right of b) {
      if (left === right || isPathPrefixOf(left, right) || isPathPrefixOf(right, left)) {
        return true;
      }
    }
  }
  return false;
}

function isPathPrefixOf(prefix: string, full: string): boolean {
  return full.length > prefix.length && full.startsWith(prefix) && full[prefix.length] === "/";
}
