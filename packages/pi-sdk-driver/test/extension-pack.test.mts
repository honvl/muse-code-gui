import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PACK_PACKAGES,
  ensureExtensionPack,
  installPackSkill,
  mergePackExtensions,
  mergePackMcpServers,
  mergePackPackages,
  resolvePackExtensionPaths,
} from "../dist/extension-pack.js";

await test("pack package merge is additive and idempotent", () => {
  const first = mergePackPackages(["npm:something-else"]);
  assert.equal(first.changed, true);
  for (const source of PACK_PACKAGES) {
    assert.ok(first.packages.includes(source), `missing ${source}`);
  }
  assert.equal(first.packages[0], "npm:something-else");

  const second = mergePackPackages(first.packages);
  assert.equal(second.changed, false);
  assert.deepEqual(second.packages, first.packages);

  const fromEmpty = mergePackPackages(undefined);
  assert.equal(fromEmpty.changed, true);
  assert.deepEqual(fromEmpty.packages, [...PACK_PACKAGES]);
});

await test("pack extension merge skips already-registered absolute paths", () => {
  const shipped = ["/ship/muse-usage/index.ts", "/ship/subagents/index.ts"];
  const first = mergePackExtensions(["/user/custom/index.ts"], shipped);
  assert.equal(first.changed, true);
  assert.deepEqual(first.extensions, ["/user/custom/index.ts", ...shipped]);

  const second = mergePackExtensions(first.extensions, shipped);
  assert.equal(second.changed, false);

  assert.deepEqual(resolvePackExtensionPaths("/ship"), [
    join("/ship", "examples/desktop-extensions/muse-usage/index.ts"),
    join("/ship", "examples/desktop-extensions/subagents/index.ts"),
  ]);
});

await test("skill install copies once and never overwrites user edits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-pack-skill-"));
  const source = join(root, "source");
  const agentDir = join(root, "agent");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "# chrome\n");
  await writeFile(join(source, "chrome.js"), "a");
  await writeFile(join(source, "cdp.js"), "b");
  t.after(() =>
    import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })),
  );

  const first = installPackSkill(agentDir, source);
  assert.equal(first.installed, true);
  assert.deepEqual(first.copied, ["SKILL.md", "chrome.js", "cdp.js"]);

  await writeFile(join(agentDir, "skills", "chrome", "chrome.js"), "user edit");
  const second = installPackSkill(agentDir, source);
  assert.equal(second.installed, false);
  assert.deepEqual(second.skipped, ["SKILL.md", "chrome.js", "cdp.js"]);
  assert.equal(
    await readFile(join(agentDir, "skills", "chrome", "chrome.js"), "utf8"),
    "user edit",
  );
});

await test("mcp merge adds servers without touching existing ones", () => {
  const current = { existing: { command: "x" } };
  const merged = mergePackMcpServers(current, [
    { name: "foreground-chrome", command: "npx", args: ["-y", "example"] },
  ]);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.servers.existing, { command: "x" });

  const again = mergePackMcpServers(merged.servers, [
    { name: "foreground-chrome", command: "npx", args: ["-y", "example"] },
  ]);
  assert.equal(again.changed, false);
});

await test("ensureExtensionPack end to end only fills gaps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-pack-ensure-"));
  t.after(() =>
    import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })),
  );
  const shipped = join(root, "ship");
  const skillSource = join(root, "skillsrc");
  const agentDir = join(root, "agent");
  for (const dir of [
    join(shipped, "examples/desktop-extensions/muse-usage"),
    join(shipped, "examples/desktop-extensions/subagents"),
    skillSource,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(shipped, "examples/desktop-extensions/muse-usage/index.ts"), "");
  await writeFile(join(shipped, "examples/desktop-extensions/subagents/index.ts"), "");
  for (const file of ["SKILL.md", "chrome.js", "cdp.js"]) {
    await writeFile(join(skillSource, file), file);
  }
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "meta", packages: ["npm:keep-me"] }, null, 2),
  );

  const first = ensureExtensionPack({
    agentDir,
    shippedRoot: shipped,
    skillSourceDir: skillSource,
    mcpServers: [{ name: "foreground-chrome", command: "example-chrome-mcp" }],
  });
  assert.equal(first.settingsChanged, true);
  assert.deepEqual(first.packagesAdded, PACK_PACKAGES);
  assert.equal(first.extensionsAdded.length, 2);
  assert.equal(first.skill.installed, true);
  assert.deepEqual(first.mcpServersAdded, ["foreground-chrome"]);

  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
    readonly defaultProvider?: unknown;
    readonly packages?: readonly unknown[];
  };
  assert.equal(settings.defaultProvider, "meta");
  assert.equal(settings.packages[0], "npm:keep-me");

  const second = ensureExtensionPack({
    agentDir,
    shippedRoot: shipped,
    skillSourceDir: skillSource,
    mcpServers: [{ name: "foreground-chrome", command: "example-chrome-mcp" }],
  });
  assert.equal(second.settingsChanged, false);
  assert.deepEqual(second.packagesAdded, []);
  assert.deepEqual(second.extensionsAdded, []);
  assert.equal(second.skill.installed, false);
  assert.deepEqual(second.mcpServersAdded, []);
});
