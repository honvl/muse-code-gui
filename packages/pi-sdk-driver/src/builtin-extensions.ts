import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";

/** A pi-gui-owned pi extension that users can switch off in Settings. */
export interface BuiltinExtension {
  /** Stable id; pi reports the loaded extension at `<inline:name>`. */
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly factory: ExtensionFactory;
  /**
   * Tool names this built-in replaces elsewhere (e.g. the driver's hidden
   * cross-session tools). The driver omits them from the superseded
   * extension so pi never reports a `Tool "…" conflicts` diagnostic.
   * Only honored while this built-in is enabled.
   */
  readonly supersedesTools?: readonly string[];
}

export type BuiltinExtensionEnabled = (name: string) => boolean;

export function builtinExtensionPath(name: string): string {
  return `<inline:${name}>`;
}

export function findBuiltinExtension(
  builtins: readonly BuiltinExtension[],
  path: string,
): BuiltinExtension | undefined {
  return builtins.find((builtin) => builtinExtensionPath(builtin.name) === path);
}

/**
 * Tool names superseded by currently enabled built-ins. Only enabled
 * built-ins contribute, so switching one off restores the tools it replaced.
 */
export function collectSupersededToolNames(
  builtins: readonly BuiltinExtension[],
  isEnabled: BuiltinExtensionEnabled,
): readonly string[] {
  const names: string[] = [];
  for (const builtin of builtins) {
    if (builtin.supersedesTools && isEnabled(builtin.name)) {
      names.push(...builtin.supersedesTools);
    }
  }
  return names;
}

/**
 * Pi runs inline factories again on every reload, so checking the preference inside the factory
 * lets an open session drop or regain a built-in's tools on its next reload.
 */
export function gatedBuiltinExtensions(
  builtins: readonly BuiltinExtension[],
  isEnabled: BuiltinExtensionEnabled,
): InlineExtension[] {
  return builtins.map((builtin) => ({
    name: builtin.name,
    factory: (pi) => (isEnabled(builtin.name) ? builtin.factory(pi) : undefined),
  }));
}
