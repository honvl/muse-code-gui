/**
 * Pure auto-update decisions for pi-gui's fork release feed.
 *
 * This module has no Electron imports, so the feed URL, the "is this version
 * newer" comparison, and the notify-vs-install decision can be unit-tested in
 * plain Node. `update-checker.ts` (main process) reuses these and adds the
 * Electron wiring (autoUpdater, Notification, shell).
 */

export const UPDATE_OWNER = "honvl";
export const UPDATE_REPO = "muse-code-gui";

export type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
};

/** Human-facing releases page for the fork (opened from notifications). */
export function releasesPageUrl(): string {
  return `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`;
}

/** Canonical page for one release tag on the fork. */
export function releaseTagUrl(tag: string): string {
  return `${releasesPageUrl()}/tag/${encodeURIComponent(tag)}`;
}

/**
 * api.github.com URL for the latest stable release. `/releases/latest` skips
 * drafts and prereleases, so stable installs are only told about stable
 * releases.
 */
export function latestReleaseApiUrl(): string {
  return `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;
}

export function releaseUrlFor(release: GitHubRelease): string {
  const tag = release.tag_name;
  if (!tag) {
    return releasesPageUrl();
  }

  const canonicalUrl = releaseTagUrl(tag);
  if (!release.html_url) {
    return canonicalUrl;
  }

  try {
    const candidate = new URL(release.html_url);
    const canonical = new URL(canonicalUrl);
    if (
      candidate.protocol === canonical.protocol &&
      candidate.host === canonical.host &&
      candidate.pathname === canonical.pathname &&
      candidate.username === "" &&
      candidate.password === "" &&
      candidate.search === "" &&
      candidate.hash === ""
    ) {
      return candidate.toString();
    }
  } catch {
    // Fall through to the repository's canonical URL for this exact tag.
  }
  return canonicalUrl;
}

/** Trim whitespace and tolerate a `v`/`V` prefix (`v1.2.3` -> `1.2.3`). */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** True only when `latest` is actually newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(normalizeVersion(latest), normalizeVersion(current)) > 0;
}

/**
 * Compare two semver strings. Returns a negative number when `a < b`, zero when
 * equal, positive when `a > b`. Handles prerelease precedence per semver
 * (a release outranks its own prereleases); unparseable inputs compare equal so
 * we never claim an update we can't verify.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return 0;
  }
  if (pa.nums[0] !== pb.nums[0]) {
    return pa.nums[0] < pb.nums[0] ? -1 : 1;
  }
  if (pa.nums[1] !== pb.nums[1]) {
    return pa.nums[1] < pb.nums[1] ? -1 : 1;
  }
  if (pa.nums[2] !== pb.nums[2]) {
    return pa.nums[2] < pb.nums[2] ? -1 : 1;
  }
  return comparePrerelease(pa.pre, pb.pre);
}

function parseSemver(
  version: string,
): { nums: [number, number, number]; pre: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A version without a prerelease tag has higher precedence than one with it.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) {
        return delta < 0 ? -1 : 1;
      }
    } else if (leftNumeric) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

export type UpdateStage = "available" | "downloaded";

export type UpdateNotice =
  | { kind: "downloading"; version: string }
  | { kind: "ready-install-on-quit"; version: string }
  | { kind: "none" };

/**
 * Stable key for one surfaced notice. Keying on stage means each version
 * notifies at most once that it is downloading and at most once that it is
 * downloaded and installs on quit.
 */
export function updateNoticeKey(stage: UpdateStage, version: string): string {
  return `${stage}:${normalizeVersion(version)}`;
}

/**
 * Pure notify-vs-install decision for an autoUpdater event.
 *
 * - `available` + unseen version -> notify that the update is downloading.
 * - `downloaded` + unseen version -> notify that it installs on quit.
 * - anything already in `seen` (or an empty version) -> stay silent.
 *
 * Install-on-quit is therefore only ever surfaced for a fully downloaded
 * update, and each version notifies at most once per stage. The caller records
 * `updateNoticeKey(stage, version)` in `seen` after notifying.
 */
export function decideUpdateNotice(
  stage: UpdateStage,
  version: string,
  seen: ReadonlySet<string> | readonly string[],
): UpdateNotice {
  const normalized = normalizeVersion(version);
  if (!normalized) {
    return { kind: "none" };
  }
  const key = updateNoticeKey(stage, normalized);
  const seenKeys = seen instanceof Set ? seen : new Set(seen);
  if (seenKeys.has(key)) {
    return { kind: "none" };
  }
  if (stage === "downloaded") {
    return { kind: "ready-install-on-quit", version: normalized };
  }
  return { kind: "downloading", version: normalized };
}
