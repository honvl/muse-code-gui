import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Where the official Muse Code CLI lives. An explicit path always wins; then
 * `muse` on PATH; then the documented install location `~/.local/bin/muse`.
 * When nothing resolves, the literal `muse` is returned so the spawn failure
 * names the missing binary instead of failing here.
 */
export function resolveMuseBinaryPath(explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) {
    return trimmed;
  }
  const onPath = findOnPath("muse");
  if (onPath) {
    return onPath;
  }
  const localBin = join(homedir(), ".local", "bin", "muse");
  if (isExecutable(localBin)) {
    return localBin;
  }
  return "muse";
}

export function museBinaryAvailable(binaryPath: string): boolean {
  if (binaryPath.includes("/") || process.platform === "win32") {
    return isExecutable(binaryPath);
  }
  return findOnPath(binaryPath) !== undefined;
}

function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
