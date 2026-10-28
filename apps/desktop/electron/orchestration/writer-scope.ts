/**
 * Single-writer scope helpers (phase A).
 *
 * A child brief's optional `scope` field names the files/areas the child may
 * write. Each scope is a set of path-ish tokens; every token is a path prefix:
 * `apps/desktop` covers `apps/desktop/src/x.ts`, while `apps/desktop/src`
 * does not cover `apps/desktop/electron`.
 *
 * An empty scope (`undefined`/`""`/no tokens) means the whole workspace and
 * therefore overlaps everything. Comparison is case-insensitive; leading `./`
 * and trailing `/` are stripped.
 *
 * Workers with disjoint scopes share one checkout, so scopes are advisory for
 * shared artifacts: build outputs, lockfiles and the Git index can still
 * collide. Each worker's claimed scope is persisted on its child record
 * (`writeScopes`).
 */

/** Parse a raw scope string into normalized, de-duplicated path tokens. */
export function parseWriteScope(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  // Commas, semicolons, and any whitespace separate tokens. Scope inputs are
  // short paths ("apps/desktop", "packages/foo/src"), so a simple split keeps
  // phase A cheap; prose around paths degrades to conservative overlap (safe).
  const parts = trimmed.split(/[\s,;]+/);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of parts) {
    const normalized = normalizeWriteScopeToken(part);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    tokens.push(normalized);
  }
  return tokens;
}

function normalizeWriteScopeToken(token: string): string {
  let value = token.trim().toLowerCase();
  // Strip leading "./" runs and stray leading/trailing slashes so "./apps/x/",
  // "/apps/x", and "apps/x" compare equal. Collapse empty segments ("a//b").
  while (value.startsWith("./")) {
    value = value.slice(2);
  }
  const segments = value
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");
  return segments.join("/");
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
