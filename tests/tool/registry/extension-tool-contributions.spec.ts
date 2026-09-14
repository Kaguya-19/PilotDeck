import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolRegistry,
  registerAvailableExtensionToolContributions,
  registerExtensionToolContributions,
  type PilotDeckToolDefinition,
} from "../../../src/tool/index.js";

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

test("extension tool registrations are exact handles in the agent-owned registry", () => {
  const registry = new ToolRegistry();
  const registrations = registerExtensionToolContributions(registry, {
    listToolContributions: () => [{ namespace: "project-plugin", tool: tool("extension_tool") }],
  });

  assert.equal(registry.has("extension_tool"), true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]!.active, true);
  registrations[0]!.dispose();
  assert.equal(registry.has("extension_tool"), false);
});

test("extension tool registration rejects conflicts without leaving partial registrations", () => {
  const registry = new ToolRegistry();
  registry.register(tool("builtin_tool"));

  assert.throws(() => registerExtensionToolContributions(registry, {
    listToolContributions: () => [
      { namespace: "project-plugin", tool: tool("accepted_then_rolled_back") },
      { namespace: "project-plugin", tool: tool("builtin_tool") },
    ],
  }), /conflicts with an existing tool or unavailable capability/);

  assert.equal(registry.has("accepted_then_rolled_back"), false);
  assert.equal(registry.has("builtin_tool"), true);
});

test("available extension tools register on the final scope registry and unavailable tools remain diagnostics", async () => {
  const registry = new ToolRegistry();
  const available = tool("available_extension_tool");
  const unavailable = {
    ...tool("unavailable_extension_tool"),
    aliases: ["unavailable_alias"],
    checkAvailability: () => ({ ok: false as const, code: "unavailable" as const, reason: "missing runtime" }),
  };
  const result = await registerAvailableExtensionToolContributions(registry, {
    listToolContributions: () => [
      { namespace: "project-plugin", tool: available },
      { namespace: "project-plugin", tool: unavailable },
    ],
  }, { cwd: "/workspace" });

  assert.equal(result.registrations.length, 1);
  assert.equal(registry.get("available_extension_tool"), available);
  assert.equal(registry.get("unavailable_extension_tool"), undefined);
  assert.deepEqual(registry.getUnavailable("unavailable_alias"), {
    toolName: "unavailable_extension_tool",
    code: "unavailable",
    reason: "missing runtime",
  });
  result.registrations[0]!.dispose();
  assert.equal(registry.has("available_extension_tool"), false);
});
