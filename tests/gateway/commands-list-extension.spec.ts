import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { listCommands } from "../../src/gateway/dialog/commands.js";

test("command catalog projects a frozen extension generation without shadowing disk commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-extension-commands-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pilotHome = join(root, "pilot-home");
  await mkdir(join(root, ".pilotdeck", "commands"), { recursive: true });
  await writeFile(
    join(root, ".pilotdeck", "commands", "local.md"),
    "---\ndescription: Local command\n---\nRuns locally.\n",
  );

  const result = await listCommands({ projectKey: root }, pilotHome, [
    {
      name: "demo:deploy",
      description: "Deploy the selected service",
      argumentHint: "service",
      namespace: "demo",
    },
    {
      name: "local",
      description: "Must not shadow the project command",
      namespace: "demo",
    },
  ]);

  assert.deepEqual(result.custom.map((entry) => ({
    name: entry.name,
    description: entry.description,
    namespace: entry.namespace,
    type: entry.type,
    argumentHint: entry.argumentHint,
    source: entry.metadata?.source,
  })), [
    {
      name: "/local",
      description: "Local command",
      namespace: "project",
      type: "command",
      argumentHint: undefined,
      source: undefined,
    },
    {
      name: "/demo:deploy",
      description: "Deploy the selected service",
      namespace: "demo",
      type: "command",
      argumentHint: "service",
      source: "plugin",
    },
  ]);
});

test("local Gateway publishes disk plugin commands through its leased contribution snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-extension-command-gateway-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const pluginDir = join(root, ".pilotdeck", "plugins", "demo");
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
  await writeFile(
    join(pluginDir, "commands", "deploy.md"),
    "---\ndescription: Deploy the selected service\nargument-hint: service\n---\nDeploy.\n",
    "utf8",
  );

  const local = createLocalGateway({ projectRoot: root, pilotHome: root });
  t.after(() => local.dispose());

  const commandsList = local.gateway.commandsList?.bind(local.gateway);
  assert.ok(commandsList, "local Gateway must expose the commands_list capability");
  const result = await commandsList({ projectKey: root });
  assert.deepEqual(
    result.custom.filter((entry) => entry.metadata?.source === "plugin").map((entry) => ({
      name: entry.name,
      namespace: entry.namespace,
      description: entry.description,
      argumentHint: entry.argumentHint,
    })),
    [{
      name: "/demo:deploy",
      namespace: "demo",
      description: "Deploy the selected service",
      argumentHint: "service",
    }],
  );
});

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 8192
  maxOutputTokens: 1024
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 8192
            maxOutputTokens: 1024
`;
