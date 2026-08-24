import assert from "node:assert/strict";
import test from "node:test";

import { PermissionRuntime } from "../../src/permission/index.js";
import { createDefaultPermissionContext } from "../../src/permission/protocol/types.js";
import type { LifecycleRuntime } from "../../src/lifecycle/index.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/protocol/types.js";

type RuntimeOptions = {
  permissionMode?: "default" | "plan" | "bypassPermissions";
  canPrompt?: boolean;
  runMode?: "ask";
  lifecycle?: LifecycleRuntime;
  progress?: PilotDeckToolRuntimeContext["progress"];
  audit?: { permissions: unknown[]; tools: unknown[] };
  planTodo?: PilotDeckToolRuntimeContext["planTodo"];
  planDirectory?: PilotDeckToolRuntimeContext["planDirectory"];
};

function context(options: RuntimeOptions = {}): PilotDeckToolRuntimeContext {
  const cwd = "/workspace";
  const permissionContext = createDefaultPermissionContext({
    cwd,
    mode: options.permissionMode ?? "bypassPermissions",
    canPrompt: options.canPrompt ?? true,
    bypassAvailable: true,
    planDirectoryPath: options.planDirectory?.path,
  });
  return {
    sessionId: "session-tool",
    turnId: "turn-tool",
    cwd,
    permissionMode: permissionContext.mode,
    permissionContext,
    runMode: options.runMode,
    progress: options.progress,
    planTodo: options.planTodo,
    planDirectory: options.planDirectory,
    auditRecorder: options.audit
      ? {
          recordPermission: (record) => { options.audit!.permissions.push(record); },
          recordTool: (record) => { options.audit!.tools.push(record); },
        }
      : undefined,
  };
}

function tool(
  name: string,
  execute: PilotDeckToolDefinition["execute"],
  options: Partial<PilotDeckToolDefinition> = {},
): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" }, path: { type: "string" }, file_path: { type: "string" }, command: { type: "string" } },
      additionalProperties: false,
    },
    isReadOnly: () => options.isReadOnly?.({} as never) ?? true,
    isConcurrencySafe: () => true,
    execute,
    ...options,
  };
}

function runtime(definition: PilotDeckToolDefinition, options: RuntimeOptions = {}) {
  const registry = new ToolRegistry();
  registry.register(definition);
  return new ToolRuntime(registry, new PermissionRuntime(), options.lifecycle);
}

function call(name: string, input: unknown = {}): { id: string; name: string; input: unknown } {
  return { id: `call-${name}`, name, input };
}

test("executes a tool, truncates output, forwards progress and records audit", async () => {
  const progress: unknown[] = [];
  const audit = { permissions: [], tools: [] };
  const definition = tool("echo", async (_input, ctx) => {
    ctx.progress?.({ type: "tool_progress", sessionId: ctx.sessionId, turnId: ctx.turnId, toolCallId: "", toolName: "", message: "working", createdAt: new Date().toISOString() });
    return { content: [{ type: "text", text: "01234567890123456789" }], data: { ok: true } };
  }, { maxResultBytes: 12 });
  const result = await runtime(definition, { progress: (event) => progress.push(event), audit }).execute(call("echo"), context({ progress: (event) => progress.push(event), audit }));
  assert.equal(result.type, "success");
  assert.equal(result.toolName, "echo");
  assert.equal(result.metadata?.previewLimit && (result.metadata.previewLimit as { truncated: boolean }).truncated, true);
  assert.equal((progress[0] as { toolCallId: string }).toolCallId, "call-echo");
  assert.equal((progress[0] as { toolName: string }).toolName, "echo");
  assert.equal(audit.permissions.length, 1);
  assert.equal(audit.tools.length, 1);
});

test("repairs aliases, rejects unknown and unavailable tools", async () => {
  const definition = tool("read_file", async () => ({ content: [{ type: "text", text: "ok" }] }), { aliases: ["read"] });
  const registry = new ToolRegistry();
  registry.register(definition);
  registry.markUnavailable({ toolName: "optional", code: "setup_required", reason: "configure optional" });
  const runtimeInstance = new ToolRuntime(registry, new PermissionRuntime());
  const repaired = await runtimeInstance.execute(call("Read", {}), context());
  assert.equal(repaired.type, "success");
  assert.equal(repaired.toolName, "read_file");
  const missing = await runtimeInstance.execute(call("missing"), context());
  assert.equal(missing.type, "error");
  assert.equal(missing.error.code, "tool_not_found");
  const unavailable = await runtimeInstance.execute(call("optional"), context());
  assert.equal(unavailable.type, "error");
  assert.equal(unavailable.error.code, "setup_required");
});

test("rejects aborted, invalid, plan and ask mode calls before execution", async () => {
  let executed = 0;
  const definition = tool("write_file", async () => { executed += 1; return { content: [{ type: "text", text: "ok" }] }; }, { isReadOnly: () => false });
  const abortController = new AbortController();
  abortController.abort();
  const instance = runtime(definition);
  const aborted = await instance.execute(call("write_file", { value: "x" }), { ...context(), abortSignal: abortController.signal });
  assert.equal(aborted.type, "error");
  assert.equal(aborted.error.code, "tool_aborted");

  const invalid = await instance.execute(call("write_file", { unknown: true }), context());
  assert.equal(invalid.type, "error");
  assert.equal(invalid.error.code, "invalid_tool_input");

  const plan = await instance.execute(call("write_file", { value: "x" }), context({ permissionMode: "plan", planDirectory: { path: "/workspace/.pilotdeck/plans", resolve: () => undefined, read: () => undefined } }));
  assert.equal(plan.type, "error");
  assert.equal(plan.error.code, "plan_mode_violation");

  const ask = await instance.execute(call("write_file", { value: "x" }), context({ runMode: "ask" }));
  assert.equal(ask.type, "error");
  assert.equal(ask.error.code, "ask_mode_violation");
  assert.equal(executed, 0);
});

test("revalidates lifecycle-updated input and records lifecycle metadata", async () => {
  const seen: unknown[] = [];
  const definition = tool("echo", async (input) => { seen.push(input); return { content: [{ type: "text", text: "ok" }] }; });
  const lifecycle = { dispatch: async (input: { event: string }) => input.event === "PreToolUse"
    ? { effects: [{ type: "updated_tool_input", input: { value: "updated" } }], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] }
    : input.event === "PostToolUse"
      ? { effects: [{ type: "additional_context", content: "note", source: "test" }], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] }
      : { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] } } as unknown as LifecycleRuntime;
  const result = await new ToolRuntime(newRegistry(definition), new PermissionRuntime(), lifecycle).execute(call("echo", { value: "original" }), context({ lifecycle }));
  assert.equal(result.type, "success");
  assert.deepEqual(seen, [{ value: "updated" }]);
  assert.deepEqual((result.metadata?.lifecycle as { additionalContext: string[] }).additionalContext, ["note"]);
});

test("rejects invalid hook updates and tool-level validation", async () => {
  const definition = tool("echo", async () => ({ content: [{ type: "text", text: "unexpected" }] }), {
    validateInput: async () => ({ ok: false, issues: [{ path: "$.value", code: "invalid_type", message: "value is invalid" }] }),
  });
  const invalidHook = { dispatch: async (input: { event: string }) => input.event === "PreToolUse"
    ? { effects: [{ type: "updated_tool_input", input: { unknown: true } }], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] }
    : { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] } } as unknown as LifecycleRuntime;
  const hookResult = await new ToolRuntime(newRegistry(definition), new PermissionRuntime(), invalidHook).execute(call("echo"), context({ lifecycle: invalidHook }));
  assert.equal(hookResult.type, "error");
  assert.equal(hookResult.error.code, "invalid_tool_input");

  const toolResult = await runtime(definition).execute(call("echo", { value: "x" }), context());
  assert.equal(toolResult.type, "error");
  assert.equal(toolResult.error.code, "invalid_tool_input");
});

test("rejects prompt-dependent tools when the host cannot prompt", async () => {
  const definition = tool("enter_plan_mode", async () => ({ content: [{ type: "text", text: "unexpected" }] }), {
    requiresUserInteraction: () => true,
  });
  const result = await runtime(definition).execute(call("enter_plan_mode"), context({ canPrompt: false }));
  assert.equal(result.type, "error");
  assert.equal(result.error.code, "unsupported_tool");
});

test("allows plan markdown writes and read-only bash, but blocks unsafe plan calls", async () => {
  const write = tool("write_file", async () => ({ content: [{ type: "text", text: "ok" }] }), { isReadOnly: () => false });
  const bash = tool("bash", async () => ({ content: [{ type: "text", text: "ok" }] }), {
    isReadOnly: (input) => typeof input === "object" && input !== null && "command" in input && (input as { command: string }).command === "pwd",
  });
  const registry = newRegistry(write, bash);
  const planDirectory = { path: "/workspace/.pilotdeck/plans", resolve: () => undefined, read: () => undefined };
  const instance = new ToolRuntime(registry, new PermissionRuntime());
  const unsafeWrite = await instance.execute(call("write_file", { file_path: "/workspace/outside.txt" }), { ...context({ permissionMode: "plan", planDirectory }), permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: "plan", canPrompt: true, bypassAvailable: true, planDirectoryPath: planDirectory.path }) });
  assert.equal(unsafeWrite.type, "error");
  assert.equal(unsafeWrite.error.code, "plan_mode_violation");
  const unsafeBash = await instance.execute(call("bash", { command: "rm file" }), { ...context({ permissionMode: "plan", planDirectory }), permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: "plan", canPrompt: true, bypassAvailable: true, planDirectoryPath: planDirectory.path }) });
  assert.equal(unsafeBash.type, "error");
  assert.equal(unsafeBash.error.code, "plan_mode_violation");
  const safeBash = await instance.execute(call("bash", { command: "pwd" }), { ...context({ permissionMode: "plan", planDirectory }), permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: "plan", canPrompt: true, bypassAvailable: true, planDirectoryPath: planDirectory.path }) });
  assert.equal(safeBash.type, "success");
});

test("preserves permission cancellation and unresolved ask responses", async () => {
  const cancelTool = tool("write_file", async () => ({ content: [{ type: "text", text: "unexpected" }] }), {
    isReadOnly: () => false,
    checkPermissions: async () => ({ type: "cancel", reason: { type: "runtime", message: "user cancelled" }, message: "cancelled" }),
  });
  const cancelled = await runtime(cancelTool).execute(call("write_file", { value: "x" }), context());
  assert.equal(cancelled.type, "error");
  assert.equal(cancelled.error.code, "permission_cancelled");

  const asking = tool("write_file", async () => ({ content: [{ type: "text", text: "unexpected" }] }), { isReadOnly: () => false });
  const asked = await runtime(asking).execute(call("write_file", { value: "x" }), context({ permissionMode: "default", canPrompt: true }));
  assert.equal(asked.type, "error");
  assert.equal(asked.error.code, "permission_required");
  assert.ok(asked.metadata?.recovery);
});

test("blocks lifecycle and todo gates before permission and execution", async () => {
  let executed = false;
  const definition = tool("write_file", async () => { executed = true; return { content: [{ type: "text", text: "no" }] }; }, { isReadOnly: () => false });
  const blocking = { dispatch: async () => ({ effects: [{ type: "block", reason: "policy" }], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] }) } as unknown as LifecycleRuntime;
  const blocked = await new ToolRuntime(newRegistry(definition), new PermissionRuntime(), blocking).execute(call("write_file", { value: "x" }), context({ lifecycle: blocking }));
  assert.equal(blocked.type, "error");
  assert.equal(blocked.error.code, "permission_denied");

  const todo = { blockingMessageFor: () => "Complete the checklist first." } as unknown as PilotDeckToolRuntimeContext["planTodo"];
  const gated = await runtime(definition).execute(call("write_file", { value: "x" }), context({ planTodo: todo }));
  assert.equal(gated.type, "error");
  assert.equal(gated.error.code, "tool_execution_failed");
  assert.equal(executed, false);
});

test("permission ask can be resolved by hook, while deny and cancel remain terminal", async () => {
  const definition = tool("write_file", async () => ({ content: [{ type: "text", text: "ok" }] }), { isReadOnly: () => false });
  const allowHook = { dispatch: async (input: { event: string }) => input.event === "PermissionRequest"
    ? { effects: [{ type: "permission_request_result", result: { behavior: "allow", updatedInput: { value: "allowed" } } }], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] }
    : { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] } } as unknown as LifecycleRuntime;
  const allowed = await new ToolRuntime(newRegistry(definition), new PermissionRuntime(), allowHook).execute(call("write_file", { value: "x" }), context({ permissionMode: "default", lifecycle: allowHook }));
  assert.equal(allowed.type, "success");

  const denied = await runtime(definition).execute(call("write_file", { value: "x" }), context({ permissionMode: "default", canPrompt: false }));
  assert.equal(denied.type, "error");
  assert.equal(denied.error.code, "permission_required");
});

test("normalizes tool failures, runs failure hook and supports nested executeTool", async () => {
  const events: string[] = [];
  const failing = tool("echo", async () => { throw new Error("boom"); });
  const lifecycle = { dispatch: async (input: { event: string }) => { events.push(input.event); return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] }; } } as unknown as LifecycleRuntime;
  const failure = await new ToolRuntime(newRegistry(failing), new PermissionRuntime(), lifecycle).execute(call("echo"), context({ lifecycle }));
  assert.equal(failure.type, "error");
  assert.equal(failure.error.code, "tool_execution_failed");
  assert.deepEqual(events, ["PreToolUse", "PostToolUseFailure"]);

  const nested = tool("outer", async (_input, ctx) => {
    const result = await ctx.executeTool!({ id: "inner-call", name: "inner", input: {} });
    return { content: [{ type: "text", text: result.type }] };
  });
  const registry = new ToolRegistry();
  registry.register(nested);
  registry.register(tool("inner", async () => ({ content: [{ type: "text", text: "inner-ok" }] })));
  const nestedResult = await new ToolRuntime(registry, new PermissionRuntime()).execute(call("outer"), context());
  assert.equal(nestedResult.type, "success");
  assert.equal(nestedResult.content[0].type, "text");
  assert.equal((nestedResult.content[0] as { text: string }).text, "success");
});

function newRegistry(...definitions: PilotDeckToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}
