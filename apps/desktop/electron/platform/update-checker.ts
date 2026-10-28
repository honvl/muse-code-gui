import { app, net, Notification, shell } from "electron";
import { autoUpdater } from "electron-updater";
import {
  decideUpdateNotice,
  isNewerVersion,
  latestReleaseApiUrl,
  normalizeVersion,
  releaseTagUrl,
  releaseUrlFor,
  releasesPageUrl,
  updateNoticeKey,
} from "./update-decision";
import type { GitHubRelease, UpdateStage } from "./update-decision";

export type { GitHubRelease };
export { compareSemver, releaseUrlFor } from "./update-decision";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 15_000; // 15 seconds after launch
const FETCH_TIMEOUT_MS = 10_000; // give up on a hung request

export type UpdateCheckResult =
  | { status: "up-to-date"; currentVersion: string; latestVersion: string }
  | {
      status: "update-available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    }
  | { status: "error"; message: string };

export function openReleasesPage(releaseUrl = releasesPageUrl()): Promise<void> {
  return shell.openExternal(releaseUrl);
}

export function showUpdateNotification(
  currentVersion: string,
  latestVersion: string,
  releaseUrl: string,
  stage: UpdateStage = "available",
): void {
  if (!Notification.isSupported()) {
    return;
  }
  const notification = new Notification({
    title: stage === "downloaded" ? "pi-gui Update Ready" : "pi-gui Update Available",
    body:
      stage === "downloaded"
        ? `Version ${latestVersion} downloaded — it installs when you quit pi-gui (you have ${currentVersion}). Click for release notes.`
        : `Version ${latestVersion} is available (you have ${currentVersion}). Downloading now — click for release notes.`,
  });
  notification.on("click", () => {
    void openReleasesPage(releaseUrl).catch((error: unknown) => {
      console.error("[update-checker] openReleasesPage failed", error);
    });
  });
  notification.show();
}

/**
 * Manual update check for the menu path — performs the network request and
 * version comparison but never shows UI. Callers decide how to surface the
 * result (the menu shows a dialog). The automatic path below uses
 * electron-updater instead so a found update is actually downloaded and
 * installed on quit.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await net.fetch(latestReleaseApiUrl(), {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The update check timed out."
        : error instanceof Error
          ? error.message
          : "The update check could not reach GitHub.";
    return { status: "error", message };
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 404) {
    return { status: "error", message: "No stable pi-gui release has been published yet." };
  }
  if (!res.ok) {
    return {
      status: "error",
      message: `GitHub Releases returned ${res.status}.`,
    };
  }

  let release: GitHubRelease;
  try {
    release = (await res.json()) as GitHubRelease;
  } catch {
    return { status: "error", message: "GitHub Releases returned an unreadable response." };
  }

  if (!release?.tag_name) {
    return {
      status: "error",
      message: "GitHub Releases did not return any published versions.",
    };
  }

  const latest = normalizeVersion(release.tag_name);
  const current = app.getVersion();

  // Only an actually newer published version counts as an update — a proper
  // semver compare avoids misfiring on prereleases or newer-local dev builds.
  if (isNewerVersion(latest, current)) {
    return {
      status: "update-available",
      currentVersion: current,
      latestVersion: latest,
      releaseUrl: releaseUrlFor(release),
    };
  }

  return {
    status: "up-to-date",
    currentVersion: current,
    latestVersion: latest,
  };
}

/**
 * Automatic updates via electron-updater: check 15 s after launch and every
 * 4 h, download in the background, install on quit. Notifications are deduped
 * per version so a still-unactioned update doesn't re-notify on every poll.
 * Errors are logged, never thrown.
 */
export function initUpdateChecker(): () => void {
  if (!app.isPackaged) {
    console.log("[update-checker] skipping auto-update: unpackaged (dev) build");
    return () => undefined;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const seenNotices = new Set<string>();
  const currentVersion = app.getVersion();

  autoUpdater.on("update-available", (info) => {
    const decision = decideUpdateNotice("available", info.version, seenNotices);
    if (decision.kind !== "downloading") {
      return;
    }
    seenNotices.add(updateNoticeKey("available", decision.version));
    showUpdateNotification(
      currentVersion,
      decision.version,
      releaseTagUrl(`v${decision.version}`),
      "available",
    );
  });

  autoUpdater.on("update-downloaded", (info) => {
    const decision = decideUpdateNotice("downloaded", info.version, seenNotices);
    if (decision.kind !== "ready-install-on-quit") {
      return;
    }
    seenNotices.add(updateNoticeKey("downloaded", decision.version));
    showUpdateNotification(
      currentVersion,
      decision.version,
      releaseTagUrl(`v${decision.version}`),
      "downloaded",
    );
  });

  autoUpdater.on("error", (error) => {
    console.warn("[update-checker] auto-update error:", error?.message ?? String(error));
  });

  const runAutoCheck = () => {
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.warn(
        "[update-checker] checkForUpdates failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const timeout = setTimeout(runAutoCheck, INITIAL_DELAY_MS);
  const interval = setInterval(runAutoCheck, CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(timeout);
    clearInterval(interval);
  };
}
