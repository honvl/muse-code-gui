import { expect, test } from "@playwright/test";
import {
  compareSemver,
  decideUpdateNotice,
  isNewerVersion,
  latestReleaseApiUrl,
  releaseTagUrl,
  releaseUrlFor,
  releasesPageUrl,
  updateNoticeKey,
} from "../../electron/platform/update-decision";

/**
 * Unit coverage for the fork's auto-update decisions. Pure only — imports the
 * Electron-free `update-decision` module, so this runs in plain Node with no
 * app. The feed must point at the fork (honvl/muse-code-gui); the upstream
 * repo never publishes fork releases, so an upstream feed means silent,
 * never-updating installs.
 */

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

test("release feed and pages point at the fork, not upstream", () => {
  expect(latestReleaseApiUrl()).toBe(
    "https://api.github.com/repos/honvl/muse-code-gui/releases/latest",
  );
  expect(releasesPageUrl()).toBe("https://github.com/honvl/muse-code-gui/releases");
  expect(releaseTagUrl("v1.2.1")).toBe(
    "https://github.com/honvl/muse-code-gui/releases/tag/v1.2.1",
  );
});

test("releaseUrlFor keeps the fork release URL and falls back to the fork tag", () => {
  expect(
    releaseUrlFor({
      tag_name: "v1.2.1",
      html_url: "https://github.com/honvl/muse-code-gui/releases/tag/v1.2.1",
    }),
  ).toBe("https://github.com/honvl/muse-code-gui/releases/tag/v1.2.1");
  expect(releaseUrlFor({ tag_name: "v1.2.1" })).toBe(
    "https://github.com/honvl/muse-code-gui/releases/tag/v1.2.1",
  );
  expect(
    releaseUrlFor({
      tag_name: "v1.2.1",
      html_url: "https://example.com/releases/tag/v1.2.1",
    }),
  ).toBe("https://github.com/honvl/muse-code-gui/releases/tag/v1.2.1");
  expect(releaseUrlFor({})).toBe("https://github.com/honvl/muse-code-gui/releases");
});

test("isNewerVersion orders multi-digit patch versions", () => {
  expect(isNewerVersion("1.2.10", "1.2.9")).toBe(true);
  expect(isNewerVersion("1.2.9", "1.2.10")).toBe(false);
});

test("isNewerVersion is false for equal versions", () => {
  expect(isNewerVersion("1.2.1", "1.2.1")).toBe(false);
  expect(isNewerVersion("v1.2.1", "1.2.1")).toBe(false);
});

test("isNewerVersion tolerates the v prefix", () => {
  expect(isNewerVersion("v1.2.2", "1.2.1")).toBe(true);
  expect(isNewerVersion("v1.2.1", "v1.2.2")).toBe(false);
});

test("isNewerVersion respects prerelease ordering", () => {
  expect(isNewerVersion("1.2.1", "1.2.1-beta.1")).toBe(true);
  expect(isNewerVersion("1.2.1-beta.2", "1.2.1-beta.1")).toBe(true);
  expect(isNewerVersion("1.2.1-beta.1", "1.2.1")).toBe(false);
  // A newer-local build (e.g. dev 1.2.2) is never "behind" the feed.
  expect(isNewerVersion("1.2.1", "1.2.2")).toBe(false);
});

test("compareSemver keeps its ordering guarantees", () => {
  expect(sign(compareSemver("0.80.4", "0.80.3"))).toBe(1);
  expect(sign(compareSemver("0.80.3", "0.80.4"))).toBe(-1);
  expect(sign(compareSemver("0.80.3", "0.80.3"))).toBe(0);
  expect(sign(compareSemver("1.0.0", "0.99.99"))).toBe(1);
  expect(sign(compareSemver("0.9.0", "0.10.0"))).toBe(-1);
  expect(sign(compareSemver("0.81.0", "0.81.0-beta.1"))).toBe(1);
  expect(sign(compareSemver("0.81.0-beta.1", "0.81.0-beta.10"))).toBe(-1);
  expect(compareSemver("weird", "0.80.3")).toBe(0);
});

test("decision helper notifies downloading on available, install-on-quit only on downloaded", () => {
  const seen = new Set<string>();
  expect(decideUpdateNotice("available", "1.2.1", seen)).toEqual({
    kind: "downloading",
    version: "1.2.1",
  });
  // Merely available never promises an install-on-quit.
  expect(decideUpdateNotice("available", "9.9.9", seen).kind).not.toBe("ready-install-on-quit");
  expect(decideUpdateNotice("downloaded", "1.2.1", seen)).toEqual({
    kind: "ready-install-on-quit",
    version: "1.2.1",
  });
});

test("decision helper notifies only once per version per stage", () => {
  const seen = new Set<string>([updateNoticeKey("available", "1.2.1")]);
  expect(decideUpdateNotice("available", "1.2.1", seen)).toEqual({ kind: "none" });
  expect(decideUpdateNotice("available", "v1.2.1", seen)).toEqual({ kind: "none" });
  // The downloaded stage is a separate notice: the install-on-quit prompt
  // still fires once even though the downloading notice already went out.
  expect(decideUpdateNotice("downloaded", "1.2.1", seen).kind).toBe("ready-install-on-quit");
  const seenBoth = new Set<string>([
    updateNoticeKey("available", "1.2.1"),
    updateNoticeKey("downloaded", "1.2.1"),
  ]);
  expect(decideUpdateNotice("downloaded", "1.2.1", seenBoth)).toEqual({ kind: "none" });
  // A newer version starts a fresh notice cycle.
  expect(decideUpdateNotice("available", "1.2.2", seenBoth).kind).toBe("downloading");
});

test("decision helper stays silent for an empty version", () => {
  expect(decideUpdateNotice("available", "", new Set())).toEqual({ kind: "none" });
  expect(decideUpdateNotice("downloaded", "  ", new Set())).toEqual({ kind: "none" });
});
