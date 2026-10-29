import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionModelSelection } from "@pi-gui/session-driver";
import type { OrchestrationChildRuntime } from "../../contracts/desktop-state";

/**
 * Which driver runs a sidekick/scout child's session. `pi` is the built-in
 * pi-sdk-driver; `muse-cli` shells out to the official Muse Code CLI, which
 * is the supported route for Meta-subscription (`meta/*`, OAuth) sidekicks:
 * subscription requests must carry Muse Code's own tool declarations, so
 * pi-sdk-driver children on those models fail with 403.
 */

export type { OrchestrationChildRuntime };

export const SIDEKICK_RUNTIME_ENV_VAR = "PI_APP_SIDEKICK_RUNTIME";

export type SidekickRuntimeOverride = "pi" | "muse-cli" | "auto";

/** `PI_APP_SIDEKICK_RUNTIME=pi|muse-cli|auto`, defaulting to auto; junk falls back to auto. */
export function resolveSidekickRuntimeOverride(
  env: NodeJS.ProcessEnv = process.env,
): SidekickRuntimeOverride {
  const raw = env[SIDEKICK_RUNTIME_ENV_VAR]?.trim().toLowerCase();
  if (raw === "pi" || raw === "muse-cli" || raw === "auto") {
    return raw;
  }
  return "auto";
}

export function isMetaModelSelection(selection: SessionModelSelection | undefined): boolean {
  return selection?.provider === "meta";
}

/**
 * The stored Meta credential type from pi's own auth file (`meta.type`).
 * Returns undefined when the file is missing or unparseable. Only the type
 * field is read; secrets never leave the file.
 */
/** pi's agent dir: its override env var, else ~/.pi/agent (mirrors pi's getAgentDir). */
export function defaultAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) {
    return envDir;
  }
  return join(homedir(), ".pi", "agent");
}

export function readMetaCredentialType(agentDir: string = defaultAgentDir()): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const meta = (parsed as Record<string, unknown>).meta;
    if (!meta || typeof meta !== "object") {
      return undefined;
    }
    const type = (meta as Record<string, unknown>).type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

export interface SidekickRuntimeDecision {
  /** The model the child (scout: scout model, else sidekick model) will run. */
  readonly model: SessionModelSelection | undefined;
  /** True when the Meta credential is an OAuth subscription. */
  readonly metaOAuth: boolean;
  /** True when a `muse` binary resolves. */
  readonly museAvailable: boolean;
}

/**
 * Tag a new child with its driver. An explicit override always wins; auto
 * picks the Muse CLI exactly when the child would run a `meta/*` model on an
 * OAuth subscription (and a binary exists), otherwise pi.
 */
export function decideChildRuntime(
  override: SidekickRuntimeOverride,
  decision: SidekickRuntimeDecision,
): OrchestrationChildRuntime {
  if (override === "pi") {
    return "pi";
  }
  if (override === "muse-cli") {
    return "muse-cli";
  }
  if (!isMetaModelSelection(decision.model) || !decision.metaOAuth || !decision.museAvailable) {
    return "pi";
  }
  return "muse-cli";
}

/** Sessions without a tag (every pre-v22 record) run on pi. */
export function childRuntimeOf(child: {
  readonly runtime?: OrchestrationChildRuntime;
}): OrchestrationChildRuntime {
  return child.runtime === "muse-cli" ? "muse-cli" : "pi";
}
