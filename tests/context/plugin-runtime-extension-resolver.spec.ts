import assert from "node:assert/strict";
import test from "node:test";

import {
  DefaultContextRuntime,
  PluginRuntimeExtensionResolver,
  PromptContributionRegistry,
  registerExtensionPromptContributions,
} from "../../src/context/index.js";
import type { PilotDeckLoadedPlugin } from "../../src/extension/index.js";
import type { PilotDeckToolDefinition } from "../../src/tool/index.js";

test("plugin extension resolver freezes one contribution generation", () => {
  let current = {
    generation: 3,
    plugins: [],
    tools: [],
    routers: [],
    commands: [{ name: "old", content: "old command body", namespace: "plugin" }],
    skills: [],
    outputStyles: [],
    hooks: {},
    mcpServers: {},
    lspServers: {},
    mcpInstructions: [{ serverName: "server", instructions: "old" }],
  };
  const runtime = {
    snapshot: () => current.plugins,
    snapshotContributions: () => current,
  };
  const resolver = new PluginRuntimeExtensionResolver(runtime);
  current = {
    ...current,
    generation: 4,
    commands: [{ name: "new", content: "new command body", namespace: "plugin" }],
    mcpInstructions: [{ serverName: "server", instructions: "new" }],
  };

  assert.equal(resolver.generation, 3);
  assert.deepEqual(resolver.listCommands(), [{
    name: "old",
    content: "old command body",
    namespace: "plugin",
  }]);
  assert.deepEqual(resolver.listMcpInstructions(), [{ serverName: "server", instructions: "old" }]);
});

test("plugin extension resolver consumes the narrow session snapshot without a plugin aggregate", () => {
  const resolver = new PluginRuntimeExtensionResolver({
    generation: 7,
    tools: [],
    routers: [],
    commands: [{ name: "session-command", namespace: "plugin" }],
    skills: [],
    prompts: [{ name: "plugin:prompt", namespace: "plugin", content: "session rules" }],
    hooks: {},
    mcpServers: {},
    mcpInstructions: [],
  });

  assert.equal(resolver.generation, 7);
  assert.deepEqual(resolver.listCommands(), [{ name: "session-command", namespace: "plugin" }]);
  assert.deepEqual(resolver.listPromptContributions(), [{
    name: "plugin:prompt",
    namespace: "plugin",
    content: "session rules",
  }]);
});

test("plugin extension resolver freezes programmatic tool contributions with its generation", () => {
  const oldTool = tool("old_extension_tool");
  let current = {
    generation: 3,
    plugins: [],
    tools: [{ namespace: "plugin", tool: oldTool }],
    routers: [],
    commands: [],
    skills: [],
    outputStyles: [],
    hooks: {},
    mcpServers: {},
    lspServers: {},
    mcpInstructions: [],
  };
  const resolver = new PluginRuntimeExtensionResolver({
    snapshot: () => current.plugins,
    snapshotContributions: () => current,
  });
  current = {
    ...current,
    generation: 4,
    tools: [{ namespace: "plugin", tool: tool("new_extension_tool") }],
  };

  assert.equal(resolver.generation, 3);
  assert.deepEqual(resolver.listToolContributions(), [{ namespace: "plugin", tool: oldTool }]);
});

test("plugin extension resolver keeps legacy aggregators when no snapshot API exists", () => {
  const resolver = new PluginRuntimeExtensionResolver({
    snapshot: () => [],
    getAllCommands: () => [{ name: "legacy" }],
    getAllSkills: () => [],
    getAllMcpInstructions: () => [{ serverName: "legacy", instructions: "ok" }],
  });
  assert.deepEqual(resolver.listCommands(), [{ name: "legacy" }]);
  assert.deepEqual(resolver.listMcpInstructions(), [{ serverName: "legacy", instructions: "ok" }]);
});

test("plugin prompt contributions are exposed as a deterministic session snapshot", () => {
  const resolver = new PluginRuntimeExtensionResolver({
    snapshot: () => [
      plugin("project-plugin", "project", "project rules"),
      plugin("builtin-plugin", "builtin", "builtin rules"),
    ],
  });

  assert.deepEqual(resolver.listPromptContributions(), [
    { name: "builtin-plugin:prompt", namespace: "builtin-plugin", content: "builtin rules" },
    { name: "project-plugin:prompt", namespace: "project-plugin", content: "project rules" },
  ]);
});

test("extension prompt registrations are owned by the session registry", async () => {
  const resolver = new PluginRuntimeExtensionResolver({
    snapshot: () => [plugin("project-plugin", "project", "rules={{model}}")],
  });
  const registry = new PromptContributionRegistry({ name: "session-prompt" });
  const registrations = registerExtensionPromptContributions(registry, resolver);
  const runtime = new DefaultContextRuntime({ promptContributions: registry });

  const prepared = await runtime.prepareForModel({
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/workspace",
    provider: "provider-a",
    model: "model-a",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  });

  assert.match(prepared.systemPrompt ?? "", /rules=model-a/);
  assert.equal(registrations.length, 1);
  registrations[0]!.dispose();
  const afterDispose = await runtime.prepareForModel({
    sessionId: "session-1",
    turnId: "turn-2",
    cwd: "/workspace",
    provider: "provider-a",
    model: "model-a",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
  });
  assert.doesNotMatch(afterDispose.systemPrompt ?? "", /rules=model-a/);
});

function plugin(
  name: string,
  source: PilotDeckLoadedPlugin["source"],
  content: string,
): PilotDeckLoadedPlugin {
  return {
    name,
    path: `/plugins/${name}`,
    source,
    manifest: { name, version: "1.0.0" },
    promptContributions: [{ name: "prompt", content }],
  };
}

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
