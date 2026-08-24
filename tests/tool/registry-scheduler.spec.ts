import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";
import { filterAvailableTools } from "../../src/tool/registry/filterAvailableTools.js";
import { ConcurrentToolScheduler } from "../../src/tool/scheduler/ConcurrentToolScheduler.js";
import { SequentialToolScheduler } from "../../src/tool/scheduler/SequentialToolScheduler.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/protocol/types.js";
import type { PilotDeckToolResult } from "../../src/tool/protocol/result.js";

function tool(
  name: string,
  overrides: Partial<PilotDeckToolDefinition> = {},
): PilotDeckToolDefinition {
  return {
    name,
    aliases: [],
    description: name + " tool",
    kind: "custom",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: name }] }),
    ...overrides,
  };
}

function result(callId: string): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId: callId,
    toolName: callId,
    content: [{ type: "text", text: callId }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.001Z",
  };
}

const context = {} as PilotDeckToolRuntimeContext;

test("ToolRegistry resolves aliases, canonical schemas and deterministic ordering", () => {
  const registry = new ToolRegistry();
  registry.register(tool("zeta", { aliases: ["Z"] }));
  registry.register(tool("alpha", { aliases: ["A"] }));
  assert.equal(registry.get("Z")?.name, "zeta");
  assert.equal(registry.has("A"), true);
  assert.deepEqual(registry.list().map((item) => item.name), ["alpha", "zeta"]);
  assert.deepEqual(registry.toCanonicalSchemas().map((item) => item.name), ["alpha", "zeta"]);
  assert.throws(() => registry.register(tool("zeta")), /already registered/);
  assert.throws(() => registry.register(tool("A")), /conflicts with an existing alias/);
  assert.throws(() => registry.register(tool("other", { aliases: ["Z"] })), /already registered/);
});

test("ToolRegistry tracks unavailable aliases, clone isolation, replace and unregister", () => {
  const registry = new ToolRegistry();
  registry.register(tool("optional", { aliases: ["opt"] }));
  registry.markUnavailable({ toolName: "missing", code: "setup_required", reason: "install it" }, ["m"]);
  registry.markUnavailable({ toolName: "optional", code: "unavailable", reason: "disabled" }, ["opt"]);
  assert.equal(registry.getUnavailable("m")?.code, "setup_required");
  assert.deepEqual(registry.listUnavailableEntries(), [
    { diagnostic: { toolName: "missing", code: "setup_required", reason: "install it" }, aliases: ["m"] },
    { diagnostic: { toolName: "optional", code: "unavailable", reason: "disabled" }, aliases: ["opt"] },
  ]);
  const clone = registry.clone();
  clone.replace(tool("optional", { aliases: ["new-opt"] }));
  assert.equal(clone.get("new-opt")?.name, "optional");
  assert.equal(clone.get("opt"), undefined);
  assert.equal(registry.get("opt")?.name, "optional");
  assert.equal(clone.unregister("optional"), true);
  assert.equal(clone.unregister("optional"), false);
  assert.equal(clone.has("optional"), false);
});

test("createBuiltinRegistry applies optional tool policies and registrations", () => {
  const defaultRegistry = createBuiltinRegistry({ agent: false });
  assert.equal(defaultRegistry.get("web_search")?.name, "web_search");
  assert.equal(defaultRegistry.get("web_fetch")?.name, "web_fetch");
  assert.equal(defaultRegistry.get("agent"), undefined);
  assert.equal(defaultRegistry.get("structured_output")?.name, "structured_output");
  assert.equal(defaultRegistry.get("ask_user_question")?.name, "ask_user_question");
  assert.equal(defaultRegistry.get("enter_plan_mode")?.name, "enter_plan_mode");

  const runtime = {} as import("../../src/task/runtime/BackgroundTaskRuntime.js").BackgroundTaskRuntime;
  const configured = createBuiltinRegistry({
    webSearch: false,
    webFetch: false,
    agent: false,
    backgroundTasks: { runtime },
    structuredOutput: false,
    askUserQuestion: false,
    planMode: false,
    readSkill: {
      loader: async () => "skill content",
      lister: async () => ["demo"],
    },
  });

  assert.equal(configured.get("web_search"), undefined);
  assert.equal(configured.getUnavailable("web_search")?.reason, "web_search is disabled in this session.");
  assert.equal(configured.get("web_fetch"), undefined);
  assert.equal(configured.getUnavailable("web_fetch")?.reason, "web_fetch is disabled in this session.");
  assert.equal(configured.get("task_create")?.name, "task_create");
  assert.equal(configured.get("task_stop")?.name, "task_stop");
  assert.equal(configured.get("structured_output"), undefined);
  assert.equal(configured.get("ask_user_question"), undefined);
  assert.equal(configured.get("enter_plan_mode"), undefined);
  assert.equal(configured.get("read_skill")?.name, "read_skill");
});

test("filterAvailableTools preserves diagnostics and caches identical checks", async () => {
  const registry = new ToolRegistry();
  let checks = 0;
  const sharedCheck = async () => {
    checks += 1;
    return { ok: true as const };
  };
  registry.register(tool("plain"));
  registry.register(tool("checked-a", { aliases: ["a"], checkAvailability: sharedCheck }));
  registry.register(tool("checked-b", { checkAvailability: sharedCheck }));
  registry.register(tool("broken", {
    checkAvailability: () => { throw new Error("check exploded"); },
  }));
  registry.markUnavailable({ toolName: "preloaded", code: "unavailable", reason: "disabled" }, ["pre"]);
  const filtered = await filterAvailableTools(registry, { cwd: "/tmp", env: {} });
  assert.equal(checks, 1);
  assert.deepEqual(filtered.registry.list().map((item) => item.name), ["checked-a", "checked-b", "plain"]);
  assert.equal(filtered.registry.getUnavailable("pre")?.code, "unavailable");
  assert.deepEqual(filtered.registry.getUnavailable("broken"), {
    toolName: "broken",
    code: "failed_check",
    reason: "check exploded",
  });
  assert.deepEqual(filtered.unavailable.map((item) => item.toolName), ["preloaded", "broken"]);
});

test("SequentialToolScheduler preserves call order", async () => {
  const calls: string[] = [];
  const runtime = {
    execute: async (call: { id: string }) => {
      calls.push(call.id);
      return result(call.id);
    },
  } as unknown as import("../../src/tool/execution/ToolRuntime.js").ToolRuntime;
  const scheduler = new SequentialToolScheduler(runtime);
  const output = await scheduler.executeAll([
    { id: "one", name: "one", input: {} },
    { id: "two", name: "two", input: {} },
  ], context);
  assert.deepEqual(calls, ["one", "two"]);
  assert.deepEqual(output.map((item) => item.toolCallId), ["one", "two"]);
});

test("ConcurrentToolScheduler runs safe calls first, serializes unsafe calls and restores result order", async () => {
  const registry = new ToolRegistry();
  registry.register(tool("safe-a", { isConcurrencySafe: () => true }));
  registry.register(tool("safe-b", { isConcurrencySafe: () => true }));
  registry.register(tool("unsafe", { isConcurrencySafe: () => false }));
  const calls: string[] = [];
  const runtime = {
    execute: async (call: { id: string }) => {
      calls.push(call.id);
      return result(call.id);
    },
  } as unknown as import("../../src/tool/execution/ToolRuntime.js").ToolRuntime;
  const scheduler = new ConcurrentToolScheduler(runtime, registry);
  const output = await scheduler.executeAll([
    { id: "unsafe", name: "unsafe", input: {} },
    { id: "safe-a", name: "safe-a", input: {} },
    { id: "unknown", name: "unknown", input: {} },
    { id: "safe-b", name: "safe-b", input: {} },
  ], context);
  assert.deepEqual(calls, ["safe-a", "safe-b", "unsafe", "unknown"]);
  assert.deepEqual(output.map((item) => item.toolCallId), ["unsafe", "safe-a", "unknown", "safe-b"]);
  assert.deepEqual(await scheduler.executeAll([], context), []);
  assert.deepEqual((await scheduler.executeAll([{ id: "single", name: "unknown", input: {} }], context)).map((item) => item.toolCallId), ["single"]);
});
