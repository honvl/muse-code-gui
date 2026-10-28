import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The Muse Code GUI extension pack: third-party pi packages, first-party
 * file-based extensions with desktop views, the chrome skill, and MCP
 * servers. Ensured into the user's pi setup on startup (default on, toggle
 * in Settings). Every merge is additive-only: missing pack entries are
 * appended, user entries are never removed, reordered, or rewritten.
 *
 * Pure functions (merge*) are unit-tested; only ensure* touches disk.
 */

/** pi package sources pi installs itself on next session load. */
export const PACK_PACKAGES: readonly string[] = [
  "npm:@injaneity/pi-computer-use",
  "npm:pi-memory",
  "git:github.com/linearuncle/pi-cc-subagent",
];

/**
 * First-party extensions, relative to the shipped root (the repo checkout in
 * dev, the bundled extensions dir in the packaged app). muse-usage shows
 * token usage. Child threads are the app's delegation model, so the old
 * subagents view is no longer shipped.
 */
export const PACK_EXTENSION_RELATIVE_PATHS: readonly string[] = [
  "examples/desktop-extensions/muse-usage/index.ts",
];

/** Skill directory name under `<agentDir>/skills/`, auto-discovered by pi. */
export const PACK_SKILL_NAME = "chrome";

/** Only these files ship; never bundle a live browser profile dir. */
export const PACK_SKILL_FILES: readonly string[] = ["SKILL.md", "chrome.js", "cdp.js"];

export interface PackMcpServer {
  readonly name: string;
  readonly description?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
}

const VALID_MCP_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Default MCP servers ensured into the global mcp.json.
 * Empty until the foreground-Chrome browser-use server definition lands:
 * add `{ name, command, args }` (or `{ name, url }`) here and every fresh
 * and existing install picks it up on next launch.
 */
export const PACK_MCP_SERVERS: readonly PackMcpServer[] = [];

function packageSource(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null && "source" in entry) {
    const source = (entry as { readonly source?: unknown }).source;
    if (typeof source === "string") return source;
  }
  return undefined;
}

/** Pack package sources absent from the current settings list. */
export function missingPackPackages(current: readonly unknown[] | undefined): string[] {
  const have = new Set(
    (current ?? []).map(packageSource).filter((source): source is string => source !== undefined),
  );
  return PACK_PACKAGES.filter((source) => !have.has(source));
}

/** Append missing pack packages; returns the merged list and whether it changed. */
export function mergePackPackages(current: readonly unknown[] | undefined): {
  readonly packages: unknown[];
  readonly changed: boolean;
} {
  const missing = missingPackPackages(current);
  if (missing.length === 0) {
    return { packages: current ? [...current] : [], changed: false };
  }
  return { packages: [...(current ?? []), ...missing], changed: true };
}

/** Absolute extension paths from the shipped root. */
export function resolvePackExtensionPaths(shippedRoot: string): string[] {
  return PACK_EXTENSION_RELATIVE_PATHS.map((relative) => join(shippedRoot, relative));
}

/** Pack extension paths absent from the current settings list. */
export function missingPackExtensions(
  current: readonly unknown[] | undefined,
  shippedPaths: readonly string[],
): string[] {
  const have = new Set(
    (current ?? []).filter((entry): entry is string => typeof entry === "string"),
  );
  return shippedPaths.filter((path) => !have.has(path));
}

export function mergePackExtensions(
  current: readonly unknown[] | undefined,
  shippedPaths: readonly string[],
): { readonly extensions: unknown[]; readonly changed: boolean } {
  const missing = missingPackExtensions(current, shippedPaths);
  if (missing.length === 0) {
    return { extensions: current ? [...current] : [], changed: false };
  }
  return { extensions: [...(current ?? []), ...missing], changed: true };
}

export interface SkillInstallResult {
  /** True when at least one file was copied. */
  readonly installed: boolean;
  /** Files copied on this run. */
  readonly copied: string[];
  /** Files left untouched because they already exist (user edits win). */
  readonly skipped: string[];
}

/**
 * Copy shipped skill files into `<agentDir>/skills/chrome/`, one file at a
 * time, never overwriting. Extra user files in the target dir are ignored.
 */
export function installPackSkill(
  agentDir: string,
  skillSourceDir: string,
  skillName: string = PACK_SKILL_NAME,
  skillFiles: readonly string[] = PACK_SKILL_FILES,
): SkillInstallResult {
  const targetDir = join(agentDir, "skills", skillName);
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const file of skillFiles) {
    const target = join(targetDir, file);
    if (existsSync(target)) {
      skipped.push(file);
      continue;
    }
    const source = join(skillSourceDir, file);
    if (!existsSync(source)) {
      throw new Error(`Pack skill source is missing: ${source}`);
    }
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, target);
    copied.push(file);
  }
  return { installed: copied.length > 0, copied, skipped };
}

function detectIndent(raw: string): string {
  const match = raw.match(/\n([ \t]+)"/);
  return match?.[1] ?? "  ";
}

/** Add missing default MCP servers to a parsed mcp.json object. Mutates nothing. */
export function mergePackMcpServers(
  current: Readonly<Record<string, unknown>> | undefined,
  defaults: readonly PackMcpServer[],
): { readonly servers: Record<string, unknown>; readonly changed: boolean } {
  const servers = { ...(current ?? {}) };
  let changed = false;
  for (const server of defaults) {
    if (!VALID_MCP_NAME.test(server.name)) {
      throw new Error(`Invalid pack MCP server name: ${server.name}`);
    }
    if (servers[server.name] !== undefined) continue;
    if (server.command) {
      servers[server.name] = {
        ...(server.description ? { description: server.description } : {}),
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
      };
    } else if (server.url) {
      servers[server.name] = {
        ...(server.description ? { description: server.description } : {}),
        url: server.url,
      };
    } else {
      throw new Error(`Pack MCP server ${server.name} needs a command or url.`);
    }
    changed = true;
  }
  return { servers, changed };
}

export interface PackEnsureResult {
  readonly packagesAdded: string[];
  readonly extensionsAdded: string[];
  readonly skill: SkillInstallResult;
  readonly mcpServersAdded: string[];
  readonly settingsChanged: boolean;
}

function readJsonFile(path: string): { readonly value: unknown; readonly raw: string } | undefined {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), raw: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Ensure the whole pack against a pi agent dir. Additive-only; safe to run
 * on every launch. `skillSourceDir` holds the shipped SKILL files and
 * `shippedRoot` anchors the file-based extension paths.
 */
export function ensureExtensionPack(options: {
  readonly agentDir: string;
  readonly shippedRoot: string;
  readonly skillSourceDir: string;
  readonly mcpServers?: readonly PackMcpServer[];
}): PackEnsureResult {
  const { agentDir, shippedRoot, skillSourceDir, mcpServers = PACK_MCP_SERVERS } = options;
  const settingsPath = join(agentDir, "settings.json");
  const stored = readJsonFile(settingsPath);
  const settings =
    stored?.value !== undefined && typeof stored.value === "object" && stored.value !== null
      ? { ...(stored.value as Record<string, unknown>) }
      : {};

  const packagesMerge = mergePackPackages(settings.packages as readonly unknown[] | undefined);
  const shippedPaths = resolvePackExtensionPaths(shippedRoot);
  // Only register extensions whose entry file actually shipped; a partial
  // bundle must not poison settings with dangling paths.
  const presentPaths = shippedPaths.filter((path) => existsSync(path));
  const missingExtensions = missingPackExtensions(
    settings.extensions as readonly unknown[] | undefined,
    presentPaths,
  );
  const extensionsMerge = mergePackExtensions(
    settings.extensions as readonly unknown[] | undefined,
    presentPaths,
  );
  const missingPackages = missingPackPackages(settings.packages as readonly unknown[] | undefined);

  let settingsChanged = false;
  if (packagesMerge.changed) {
    settings.packages = packagesMerge.packages;
    settingsChanged = true;
  }
  if (extensionsMerge.changed) {
    settings.extensions = extensionsMerge.extensions;
    settingsChanged = true;
  }
  if (settingsChanged) {
    const indent = stored ? detectIndent(stored.raw) : "  ";
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, indent)}\n`);
  }

  const skill = installPackSkill(agentDir, skillSourceDir);

  const mcpPath = join(agentDir, "mcp.json");
  const mcpStored = readJsonFile(mcpPath);
  const mcpRoot =
    mcpStored?.value !== undefined &&
    typeof mcpStored.value === "object" &&
    mcpStored.value !== null
      ? (mcpStored.value as Record<string, unknown>)
      : {};
  const mcpServersRaw = mcpRoot.mcpServers;
  const mcpMerge = mergePackMcpServers(
    mcpServersRaw !== undefined && typeof mcpServersRaw === "object" && mcpServersRaw !== null
      ? (mcpServersRaw as Record<string, unknown>)
      : undefined,
    mcpServers,
  );
  let mcpServersAdded: string[] = [];
  if (mcpMerge.changed) {
    mcpServersAdded = mcpServers.map((server) => server.name);
    const indent = mcpStored ? detectIndent(mcpStored.raw) : "  ";
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(
      mcpPath,
      `${JSON.stringify({ ...mcpRoot, mcpServers: mcpMerge.servers }, null, indent)}\n`,
    );
  }

  return {
    packagesAdded: missingPackages,
    extensionsAdded: missingExtensions,
    skill,
    mcpServersAdded,
    settingsChanged,
  };
}
