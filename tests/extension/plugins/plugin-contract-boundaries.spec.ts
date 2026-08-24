import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { parsePluginManifest } from "../../../src/extension/plugins/config/parsePluginManifest.js";
import { validateMarketplaceName } from "../../../src/extension/plugins/config/validateMarketplaceName.js";
import { validatePluginSourcePath } from "../../../src/extension/plugins/config/validatePluginSource.js";
import { resolvePluginDirectories } from "../../../src/extension/plugins/discovery/PluginDirectoryResolver.js";
import { discoverPluginPaths, discoverSkillPaths } from "../../../src/extension/plugins/discovery/discoverLocalPlugins.js";
import { loadPluginHooks } from "../../../src/extension/plugins/loading/PluginHookLoader.js";
import { PluginRegistry } from "../../../src/extension/plugins/runtime/PluginRegistry.js";
import { defaultPluginReloadPolicy } from "../../../src/extension/plugins/runtime/PluginReloadPolicy.js";
import { truncateMcpInstructionString, MAX_MCP_INSTRUCTION_LENGTH } from "../../../src/extension/plugins/runtime/truncateMcpString.js";
import type { PilotDeckLoadedPlugin } from "../../../src/extension/plugins/protocol/plugin.js";

test("parsePluginManifest normalizes optional fields and rejects malformed roots", () => {
  assert.throws(() => parsePluginManifest(null), /must be an object/);
  assert.throws(() => parsePluginManifest({}), /must contain a name/);
  const manifest = parsePluginManifest({
    name: "demo",
    version: 3,
    commands: ["one", "two"],
    agents: "agent.md",
    hooks: "hooks.json",
    marketplace: { name: "community", plugin: "demo", source: "git", version: "1.0.0" },
    mcpb: "server.mcpb",
    settings: { enabled: true },
  });
  assert.deepEqual(manifest, {
    name: "demo",
    version: undefined,
    description: undefined,
    commands: ["one", "two"],
    agents: "agent.md",
    skills: undefined,
    hooks: "hooks.json",
    mcpServers: undefined,
    lspServers: undefined,
    outputStyles: undefined,
    marketplace: { name: "community", plugin: "demo", version: "1.0.0", source: "git", url: undefined },
    mcpb: "server.mcpb",
    settings: { enabled: true },
  });
});

test("plugin name and source validators enforce marketplace and workspace boundaries", () => {
  for (const invalid of ["", "a b", "a/b", "a\\b", "..", ".", "inline", "builtin", "官方"]) {
    assert.ok(validateMarketplaceName(invalid));
  }
  assert.equal(validateMarketplaceName("community-1"), undefined);
  assert.equal(validatePluginSourcePath("/workspace/plugins/demo", "/workspace/plugins"), true);
  assert.equal(validatePluginSourcePath("/workspace/plugins-other/demo", "/workspace/plugins"), false);
});

test("plugin discovery finds directories and standalone skills while isolating missing entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-plugin-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugins = join(root, "plugins");
  await mkdir(join(plugins, "demo"), { recursive: true });
  await mkdir(join(plugins, "skill"), { recursive: true });
  await writeFile(join(plugins, "skill", "SKILL.md"), "# skill\n", "utf8");
  await writeFile(join(plugins, "plain.txt"), "not a directory", "utf8");

  assert.deepEqual(await discoverPluginPaths([{ path: plugins, source: "project" }]), [
    { path: join(plugins, "demo"), source: "project" },
    { path: join(plugins, "skill"), source: "project" },
  ]);
  assert.deepEqual(await discoverSkillPaths([{ path: plugins, source: "project" }]), [
    { path: join(plugins, "skill"), source: "project" },
  ]);
  assert.deepEqual(await discoverPluginPaths([{ path: join(root, "missing"), source: "global" }]), []);
  const paths = resolvePluginDirectories({ projectRoot: join(root, "project"), pilotHome: join(root, "home") });
  assert.match(paths.projectPluginsDir, /project/);
});

test("plugin registry replaces by source identity and hook loader annotates ownership", () => {
  const plugin = (name: string, source: "builtin" | "project"): PilotDeckLoadedPlugin => ({
    name,
    path: `/plugins/${name}`,
    source,
    manifest: { name },
    hooksConfig: {
      UserPromptSubmit: [{ type: "prompt", prompt: "guard" }],
    },
  });
  const registry = new PluginRegistry();
  registry.replaceAll([plugin("demo", "project"), plugin("demo", "builtin")]);
  assert.equal(registry.list().length, 2);
  registry.replaceAll([plugin("demo", "project")]);
  assert.equal(registry.list().length, 1);
  assert.deepEqual(loadPluginHooks(registry.list()).UserPromptSubmit?.[0], {
    type: "prompt",
    prompt: "guard",
    pluginName: "demo",
    pluginId: "demo@project",
    pluginRoot: "/plugins/demo",
  });
  assert.equal(defaultPluginReloadPolicy.pruneRemovedImmediately, true);
  assert.equal(truncateMcpInstructionString("short"), "short");
  assert.equal(
    truncateMcpInstructionString("x".repeat(MAX_MCP_INSTRUCTION_LENGTH + 1)).length,
    MAX_MCP_INSTRUCTION_LENGTH + "… [truncated]".length,
  );
});
