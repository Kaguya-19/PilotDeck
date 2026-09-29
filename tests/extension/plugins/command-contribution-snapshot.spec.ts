import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import { PluginRuntimeExtensionResolver } from "../../../src/context/extension/PluginRuntimeExtensionResolver.js";

test("command snapshots retain the selected command body with project precedence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-command-snapshot-"));
  const pilotHome = join(root, "pilot-home");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePluginCommand(join(pilotHome, "plugins", "demo"), "global command instruction");
  await writePluginCommand(join(root, ".pilotdeck", "plugins", "demo"), "project command instruction");

  const runtime = new PluginRuntime({ projectRoot: root, pilotHome });
  t.after(() => runtime.dispose());
  await runtime.refresh();

  const commands = runtime.snapshotContributions().commands.filter((command) => command.name === "demo:deploy");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.content, "project command instruction\n");
  assert.equal(commands[0]?.namespace, "demo");

  const resolver = new PluginRuntimeExtensionResolver(runtime.snapshotContributions());
  assert.equal(resolver.listCommands().find((command) => command.name === "demo:deploy")?.content, "project command instruction\n");
});

async function writePluginCommand(pluginDir: string, content: string): Promise<void> {
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
  await writeFile(
    join(pluginDir, "commands", "deploy.md"),
    `---\ndescription: Deploy\n---\n${content}\n`,
    "utf8",
  );
}
