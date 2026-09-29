import assert from "node:assert/strict";
import test from "node:test";

import { SessionToolCompositionBundle } from "../../src/cli/SessionToolCompositionBundle.js";
import { ToolRegistry, type PilotDeckToolDefinition } from "../../src/tool/index.js";

test("session tool composition applies policy before availability and keeps the base registry untouched", async () => {
  const calls: string[] = [];
  const base = new ToolRegistry();
  base.register(tool("keep"));
  base.register(tool("exclude_me", () => {
    calls.push("exclude_me");
    return { ok: true };
  }));
  base.register(tool("always_on_apply", () => {
    calls.push("always_on_apply");
    return { ok: true };
  }));
  base.register(tool("builtin_unavailable", () => {
    calls.push("builtin_unavailable");
    return { ok: false, code: "unavailable", reason: "not installed" };
  }, ["BuiltinUnavailable"]));

  const working = base.clone();
  const result = await new SessionToolCompositionBundle({
    composeMcpTools: async () => working,
    extension: {
      listToolContributions: () => [
        { namespace: "example", tool: tool("extension_keep", () => {
          calls.push("extension_keep");
          return { ok: true };
        }) },
        { namespace: "example", tool: tool("extension_unavailable", () => {
          calls.push("extension_unavailable");
          return { ok: false, code: "unavailable", reason: "extension unavailable" };
        }) },
      ],
    },
    availability: { cwd: process.cwd(), env: {} },
    excludeTools: ["exclude_me"],
    isAlwaysOnSession: false,
    alwaysOnToolNames: ["always_on_apply"],
  }).compose();

  assert.deepEqual(result.registry.list().map((entry) => entry.name), ["extension_keep", "keep"]);
  assert.deepEqual(result.unavailable, [
    { toolName: "builtin_unavailable", code: "unavailable", reason: "not installed" },
    { toolName: "extension_unavailable", code: "unavailable", reason: "extension unavailable" },
  ]);
  assert.deepEqual(calls, ["builtin_unavailable", "extension_keep", "extension_unavailable"]);
  assert.equal(result.registry.getUnavailable("BuiltinUnavailable")?.toolName, "builtin_unavailable");
  assert.deepEqual(base.list().map((entry) => entry.name), [
    "always_on_apply",
    "builtin_unavailable",
    "exclude_me",
    "keep",
  ]);
  assert.equal(working.state, "disposed");

  result.registry.dispose();
});

test("Always-On sessions retain their Always-On tools", async () => {
  const base = new ToolRegistry();
  base.register(tool("always_on_apply"));
  const working = base.clone();

  const result = await new SessionToolCompositionBundle({
    composeMcpTools: async () => working,
    extension: { listToolContributions: () => [] },
    availability: { cwd: process.cwd(), env: {} },
    isAlwaysOnSession: true,
    alwaysOnToolNames: ["always_on_apply"],
  }).compose();

  assert.equal(result.registry.has("always_on_apply"), true);
  result.registry.dispose();
});

test("session tool composition disposes transient registries when extension registration fails", async () => {
  const base = new ToolRegistry();
  base.register(tool("existing"));
  const working = base.clone();

  await assert.rejects(
    new SessionToolCompositionBundle({
      composeMcpTools: async () => working,
      extension: {
        listToolContributions: () => [{ namespace: "example", tool: tool("existing") }],
      },
      availability: { cwd: process.cwd(), env: {} },
      isAlwaysOnSession: false,
    }).compose(),
    /conflicts with an existing tool/,
  );

  assert.equal(working.state, "disposed");
  assert.equal(base.state, "active");
});

function tool(
  name: string,
  checkAvailability?: NonNullable<PilotDeckToolDefinition["checkAvailability"]>,
  aliases?: string[],
): PilotDeckToolDefinition {
  return {
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ content: [] }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    ...(checkAvailability ? { checkAvailability } : {}),
    ...(aliases ? { aliases } : {}),
  };
}
