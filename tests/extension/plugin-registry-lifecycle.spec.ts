import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PluginRegistry, PluginRuntime } from "../../src/extension/index.js";
import type { PilotDeckLoadedPlugin } from "../../src/extension/index.js";
import type { PilotDeckToolDefinition } from "../../src/tool/index.js";

function plugin(name: string, dispose?: () => void | Promise<void>): PilotDeckLoadedPlugin {
  return {
    name,
    path: `/plugins/${name}`,
    source: "project",
    manifest: { name, version: "1.0.0" },
    ...(dispose ? { dispose } : {}),
  };
}

test("plugin replacement publishes one generation and disposes only removed plugins", async () => {
  const registry = new PluginRegistry();
  let disposed = 0;
  registry.replaceAll([plugin("old", () => { disposed += 1; })]);
  const replacement = registry.replaceAll([plugin("new")]);

  assert.equal(replacement.generation, 2);
  assert.deepEqual(replacement.removed.map((item) => item.name), ["old"]);
  assert.deepEqual(registry.list().map((item) => item.name), ["new"]);
  assert.equal(disposed, 0);
  await replacement.disposeRemoved();
  assert.equal(disposed, 1);
});

test("plugin replacement waits for a contribution lease before disposing the retired instance", async () => {
  const registry = new PluginRegistry();
  let disposed = 0;
  const old = plugin("old", () => { disposed += 1; });
  registry.replaceAll([old]);
  const lease = registry.acquire();

  const replacement = registry.replaceAll([plugin("new")]);
  const retirement = replacement.disposeRemoved();
  await Promise.resolve();

  assert.equal(replacement.retiringLeaseCount, 1);
  assert.equal(disposed, 0, "an active session snapshot retains the old plugin");

  await lease.release();
  await retirement;
  assert.equal(disposed, 1);
});

test("same-name reload retires the previous plugin instance after its lease drains", async () => {
  const registry = new PluginRegistry();
  let disposed = 0;
  const previous = plugin("same", () => { disposed += 1; });
  registry.replaceAll([previous]);
  const lease = registry.acquire();

  const replacement = registry.replaceAll([plugin("same")]);
  assert.deepEqual(replacement.removed, [], "the logical plugin key remains present");
  assert.deepEqual(replacement.retired, [previous], "the replaced instance still retires");

  const retirement = replacement.disposeRemoved();
  await Promise.resolve();
  assert.equal(disposed, 0);

  await lease.release();
  await retirement;
  assert.equal(disposed, 1);
});

test("retired disposer failure does not roll back the published generation", async () => {
  const registry = new PluginRegistry();
  const old = plugin("old", () => { throw new Error("old teardown failed"); });
  registry.replaceAll([old]);
  const lease = registry.acquire();

  const replacement = registry.replaceAll([plugin("new")]);
  const retirement = replacement.disposeRemoved();
  await assert.rejects(() => lease.release(), /old teardown failed/);
  await assert.rejects(() => retirement, /old teardown failed/);

  assert.deepEqual(registry.list().map((entry) => entry.name), ["new"]);
  assert.equal(registry.currentGeneration, 2);
});

test("plugin registry disposal stops new leases and drains the active generation", async () => {
  const registry = new PluginRegistry();
  let disposed = 0;
  registry.replaceAll([plugin("active", () => { disposed += 1; })]);
  const lease = registry.acquire();

  const disposal = registry.dispose();
  await Promise.resolve();
  assert.equal(registry.state, "draining");
  assert.equal(disposed, 0);
  assert.throws(() => registry.acquire(), /plugin registry is draining/);

  await lease.release();
  await disposal;
  assert.equal(registry.state, "disposed");
  assert.equal(disposed, 1);
});

test("plugin registry shutdown reclaims a retired instance even when its replacement handle was not consumed", async () => {
  const registry = new PluginRegistry();
  const disposed: string[] = [];
  registry.replaceAll([plugin("old", () => { disposed.push("old"); })]);
  registry.replaceAll([plugin("new", () => { disposed.push("new"); })]);

  await registry.dispose();
  assert.deepEqual(disposed.sort(), ["new", "old"]);
});

test("disposed plugin registry rejects late replacement", async () => {
  const registry = new PluginRegistry();
  registry.replaceAll([plugin("one")]);
  await registry.dispose();
  assert.equal(registry.state, "disposed");
  assert.throws(() => registry.replaceAll([plugin("two")]), /plugin registry is disposed/);
});

test("plugin refresh is single-flight so concurrent callers share one generation", async () => {
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/pilotdeck-plugin-test-project",
    pilotHome: "/tmp/pilotdeck-plugin-test-home",
    builtinPlugins: [plugin("builtin")],
  });
  const [first, second] = await Promise.all([
    runtime.refreshWithReport(),
    runtime.refreshWithReport(),
  ]);
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 1);
  assert.equal(runtime.generation, 1);
  await runtime.dispose();
  await assert.rejects(() => runtime.refreshWithReport(), /plugin runtime is draining/);
});

test("plugin refresh retains the active generation when an existing disk plugin fails staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-plugin-stage-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const pluginDir = join(projectRoot, ".pilotdeck", "plugins", "reloadable");
  try {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "reloadable", version: "1.0.0" }),
      "utf8",
    );
    const runtime = new PluginRuntime({ projectRoot, pilotHome });
    const first = await runtime.refreshWithReport();
    const active = first.next[0]!;

    await writeFile(join(pluginDir, "plugin.json"), "{ invalid JSON", "utf8");
    const stagedFailure = await runtime.refreshWithReport();

    assert.equal(stagedFailure.generation, first.generation);
    assert.deepEqual(stagedFailure.next, [active]);
    assert.deepEqual(stagedFailure.added, []);
    assert.deepEqual(stagedFailure.removed, []);
    assert.deepEqual(stagedFailure.stagedFailures, [{
      path: pluginDir,
      source: "project",
      kind: "plugin",
    }]);
    assert.equal(runtime.generation, first.generation);
    await runtime.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin refresh retires a disk plugin only after its path is actually removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-plugin-remove-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const pluginDir = join(projectRoot, ".pilotdeck", "plugins", "removed");
  try {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "removed", version: "1.0.0" }),
      "utf8",
    );
    const runtime = new PluginRuntime({ projectRoot, pilotHome });
    const first = await runtime.refreshWithReport();

    await rm(pluginDir, { recursive: true, force: true });
    const removed = await runtime.refreshWithReport();

    assert.equal(removed.generation, first.generation + 1);
    assert.deepEqual(removed.next, []);
    assert.deepEqual(removed.removed, first.next);
    assert.deepEqual(removed.stagedFailures, []);
    await runtime.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin runtime snapshots programmatic tool, hook, and router contributions", async () => {
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/pilotdeck-plugin-tool-test-project",
    pilotHome: "/tmp/pilotdeck-plugin-tool-test-home",
    builtinPlugins: [{
      ...plugin("builtin"),
      toolContributions: [{ tools: [tool("extension_tool")] }],
      hookContributions: [{
        hooks: { SessionStart: [{ hooks: [{ type: "prompt", prompt: "hello" }] }] },
      }],
      routerContributions: [{
        id: "extension_router",
        createCustomRouter() {
          return {
            id: "extension_router",
            async decide() { return undefined; },
          };
        },
      }],
    }],
  });

  await runtime.refresh();
  const snapshot = runtime.snapshotContributions();
  assert.deepEqual(snapshot.tools.map((entry) => ({ namespace: entry.namespace, name: entry.tool.name })), [
    { namespace: "builtin", name: "extension_tool" },
  ]);
  assert.deepEqual(snapshot.routers.map((entry) => ({ namespace: entry.namespace, id: entry.contribution.id })), [
    { namespace: "builtin", id: "extension_router" },
  ]);
  assert.equal(snapshot.hooks.SessionStart?.[0]?.pluginName, "builtin");
  await runtime.dispose();
});

test("plugin runtime returns a releasable frozen contribution snapshot", async () => {
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/pilotdeck-plugin-lease-project",
    pilotHome: "/tmp/pilotdeck-plugin-lease-home",
    builtinPlugins: [{
      ...plugin("builtin"),
      toolContributions: [{ tools: [tool("leased_extension_tool")] }],
      mcpServers: {
        leased_mcp: {
          command: "node",
          args: ["server.mjs"],
        },
      },
    }],
  });

  await runtime.refresh();
  const lease = runtime.acquireContributionSnapshot();
  assert.equal(lease.generation, runtime.generation);
  assert.deepEqual(lease.contributions.tools.map((entry) => entry.tool.name), ["leased_extension_tool"]);
  assert.deepEqual(lease.contributions.mcpServers, {
    leased_mcp: {
      command: "node",
      args: ["server.mjs"],
    },
  });

  await lease.release();
  await runtime.dispose();
});

test("plugin runtime exposes frozen consumer views bound to one registry generation", async () => {
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/pilotdeck-plugin-view-project",
    pilotHome: "/tmp/pilotdeck-plugin-view-home",
    builtinPlugins: [{
      ...plugin("builtin"),
      commands: [{
        name: "builtin:command",
        path: "/tmp/builtin-command.md",
        content: "command body",
        frontmatter: {},
        isSkill: false,
      }],
      promptContributions: [{ name: "prompt", content: "prompt body" }],
    }],
  });

  await runtime.refresh();
  const sessionLease = runtime.acquireSessionContributions();
  const commandLease = runtime.acquireCommandCatalog();
  const deprecated = runtime.snapshotContributions();
  const acquiredGeneration = runtime.generation;

  assert.equal(sessionLease.generation, acquiredGeneration);
  assert.equal(commandLease.generation, acquiredGeneration);
  assert.ok(Object.isFrozen(sessionLease.contributions));
  assert.ok(Object.isFrozen(sessionLease.contributions.commands));
  assert.ok(Object.isFrozen(commandLease.contributions));
  assert.deepEqual(commandLease.contributions.commands, sessionLease.contributions.commands);
  assert.deepEqual(deprecated.commands, sessionLease.contributions.commands);
  assert.deepEqual(sessionLease.contributions.prompts, [{
    name: "builtin:prompt",
    namespace: "builtin",
    content: "prompt body",
  }]);
  assert.deepEqual(Object.keys(commandLease.contributions).sort(), ["commands", "generation"]);

  await runtime.refresh();
  assert.ok(runtime.generation > acquiredGeneration);
  assert.equal(sessionLease.generation, acquiredGeneration);
  assert.equal(commandLease.generation, acquiredGeneration);

  await sessionLease.release();
  await commandLease.release();
  await runtime.dispose();
});

test("retired plugins wait for both session and command view leases", async () => {
  let disposed = 0;
  const enabled = { retiring: true };
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/pilotdeck-plugin-view-retirement-project",
    pilotHome: "/tmp/pilotdeck-plugin-view-retirement-home",
    builtinPlugins: [{
      ...plugin("retiring", () => { disposed += 1; }),
      source: "builtin",
    }],
    builtinPluginsEnabled: enabled,
  });

  await runtime.refresh();
  const sessionLease = runtime.acquireSessionContributions();
  const commandLease = runtime.acquireCommandCatalog();
  enabled.retiring = false;
  await runtime.refresh();
  await Promise.resolve();
  assert.equal(disposed, 0);

  const sessionRelease = sessionLease.release();
  await Promise.resolve();
  assert.equal(disposed, 0);
  await Promise.all([sessionRelease, commandLease.release()]);
  assert.equal(disposed, 1);
  await runtime.dispose();
});

function tool(name: string): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} extension tool`,
    kind: "custom",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}
