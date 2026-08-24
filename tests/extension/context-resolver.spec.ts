import assert from "node:assert/strict";
import test from "node:test";

import { NullExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PluginRuntimeExtensionResolver } from "../../src/context/extension/PluginRuntimeExtensionResolver.js";

test("NullExtensionResolver returns isolated empty contribution lists", () => {
  const resolver = new NullExtensionResolver();
  const commands = resolver.listCommands();
  const skills = resolver.listSkills();
  const instructions = resolver.listMcpInstructions();
  assert.deepEqual(commands, []);
  assert.deepEqual(skills, []);
  assert.deepEqual(instructions, []);
  assert.notEqual(commands, resolver.listCommands());
});

test("PluginRuntimeExtensionResolver prefers stable aggregators", () => {
  const resolver = new PluginRuntimeExtensionResolver({
    snapshot: () => [],
    getAllCommands: () => [{ name: "aggregated", namespace: "plugin" }],
    getAllSkills: () => [{ name: "skill", path: "/skills/skill", namespace: "plugin" }],
    getAllMcpInstructions: () => [{ serverName: "mcp", instructions: "use it" }],
  });
  assert.deepEqual(resolver.listCommands(), [{ name: "aggregated", namespace: "plugin" }]);
  assert.deepEqual(resolver.listSkills(), [{ name: "skill", path: "/skills/skill", namespace: "plugin" }]);
  assert.deepEqual(resolver.listMcpInstructions(), [{ serverName: "mcp", instructions: "use it" }]);
});

test("PluginRuntimeExtensionResolver projects legacy plugin snapshots and preserves optional fields", () => {
  const resolver = new PluginRuntimeExtensionResolver({
    snapshot: () => [{
      name: "legacy-plugin",
      commands: [
        { name: "deploy", frontmatter: { description: "Deploy it", "argument-hint": "<env>" } },
        { name: "plain", frontmatter: { description: 42, "argument-hint": 7 } },
      ],
      skills: [
        { name: "review", path: "/plugins/review/SKILL.md", frontmatter: { description: "Review code" } },
        { name: "bare", path: "/plugins/bare/SKILL.md", frontmatter: {} },
      ],
    }] as never,
  });
  assert.deepEqual(resolver.listCommands(), [
    { name: "deploy", description: "Deploy it", argumentHint: "<env>", namespace: "legacy-plugin" },
    { name: "plain", description: undefined, argumentHint: undefined, namespace: "legacy-plugin" },
  ]);
  assert.deepEqual(resolver.listSkills(), [
    { name: "review", description: "Review code", path: "/plugins/review/SKILL.md", namespace: "legacy-plugin" },
    { name: "bare", description: undefined, path: "/plugins/bare/SKILL.md", namespace: "legacy-plugin" },
  ]);
  assert.deepEqual(resolver.listMcpInstructions(), []);
});
