import assert from "node:assert/strict";
import test from "node:test";

import { AgentHookExecutor } from "../../src/extension/hooks/execution/AgentHookExecutor.js";
import {
  AsyncHookRegistry,
  type PendingAsyncHook,
} from "../../src/extension/hooks/execution/AsyncHookRegistry.js";
import { CallbackHookExecutor } from "../../src/extension/hooks/execution/CallbackHookExecutor.js";
import {
  CommandHookExecutor,
  type CommandHookExecutionResult,
} from "../../src/extension/hooks/execution/CommandHookExecutor.js";
import { HookExecutionEventBus } from "../../src/extension/hooks/events/HookExecutionEventBus.js";
import { HookRuntime } from "../../src/extension/hooks/execution/HookRuntime.js";
import { HttpHookExecutor } from "../../src/extension/hooks/execution/HttpHookExecutor.js";
import { PromptHookExecutor } from "../../src/extension/hooks/execution/PromptHookExecutor.js";
import { createHookInput, type PilotDeckHookInput } from "../../src/extension/hooks/protocol/input.js";
import type { PilotDeckHookEvent } from "../../src/extension/hooks/protocol/events.js";
import type { PilotDeckHooksSettings } from "../../src/extension/hooks/protocol/settings.js";
import type { PilotDeckHookOutput } from "../../src/extension/hooks/protocol/output.js";

const base = {
  sessionId: "s1",
  transcriptPath: "/tmp/transcript.jsonl",
  cwd: "/tmp/project",
};

function hookInput(event: PilotDeckHookEvent = "PreToolUse"): PilotDeckHookInput {
  return createHookInput(event, base, { toolName: "write_file", toolInput: { path: "a.txt" } });
}

function commandResult(
  output: PilotDeckHookOutput = { type: "sync" },
  outcome: CommandHookExecutionResult["outcome"] = "success",
): CommandHookExecutionResult {
  return { stdout: "", stderr: "", exitCode: outcome === "success" ? 0 : 1, outcome, output };
}

test("prompt and agent executors inject arguments, parse output and isolate failures", async () => {
  let promptCall: { prompt: string; model?: string; signal?: AbortSignal } | undefined;
  const prompt = new PromptHookExecutor(async (input) => {
    promptCall = input;
    return '{"continue":false,"reason":"stop"}';
  });
  const signal = new AbortController().signal;
  const promptInput = hookInput();
  const promptResult = await prompt.execute({
    hook: { type: "prompt", prompt: "inspect $ARGUMENTS", model: "judge" },
    hookInput: promptInput,
    signal,
  });
  assert.equal(promptCall?.prompt, "inspect " + JSON.stringify(promptInput));
  assert.equal(promptCall?.model, "judge");
  assert.equal(promptCall?.signal, signal);
  assert.deepEqual(promptResult.output, {
    type: "sync",
    continue: false,
    suppressOutput: undefined,
    stopReason: undefined,
    decision: undefined,
    reason: "stop",
    systemMessage: undefined,
    specific: undefined,
    raw: { continue: false, reason: "stop" },
  });

  const missingPrompt = await new PromptHookExecutor().execute({
    hook: { type: "prompt", prompt: "x" },
    hookInput: hookInput(),
  });
  assert.equal(missingPrompt.outcome, "non_blocking_error");
  assert.match(missingPrompt.stderr, /not configured/);

  const failedPrompt = await new PromptHookExecutor(async () => { throw new Error("prompt failed"); }).execute({
    hook: { type: "prompt", prompt: "x" },
    hookInput: hookInput(),
  });
  assert.equal(failedPrompt.stderr, "prompt failed");

  let agentPrompt = "";
  const agent = new AgentHookExecutor(async (input) => {
    agentPrompt = input.prompt;
    return '{"systemMessage":"agent output"}';
  });
  const agentInput = hookInput();
  const agentResult = await agent.execute({
    hook: { type: "agent", prompt: "run $ARGUMENTS", model: "worker" },
    hookInput: agentInput,
  });
  assert.equal(agentPrompt, "run " + JSON.stringify(agentInput));
  assert.equal(agentResult.output.type, "sync");
  assert.equal(agentResult.output.systemMessage, "agent output");
  assert.equal((await new AgentHookExecutor().execute({
    hook: { type: "agent", prompt: "x" },
    hookInput: hookInput(),
  })).outcome, "non_blocking_error");
  assert.equal((await new AgentHookExecutor(async () => { throw "agent failed"; }).execute({
    hook: { type: "agent", prompt: "x" },
    hookInput: hookInput(),
  })).stderr, "agent failed");
});

test("callback executor supports structured/string results, registration and failures", async () => {
  const callbacks = new CallbackHookExecutor();
  const missing = await callbacks.execute({
    hook: { type: "callback", name: "missing" },
    hookInput: hookInput(),
  });
  assert.equal(missing.outcome, "non_blocking_error");
  callbacks.register("structured", () => ({ type: "sync", systemMessage: "ok" }));
  callbacks.register("string", () => '{"continue":false}');
  callbacks.register("failing", () => { throw new Error("callback failed"); });
  const structured = await callbacks.execute({
    hook: { type: "callback", name: "structured" },
    hookInput: hookInput(),
  });
  assert.equal(structured.output.type, "sync");
  if (structured.output.type === "sync") assert.equal(structured.output.systemMessage, "ok");
  const stringResult = await callbacks.execute({
    hook: { type: "callback", name: "string" },
    hookInput: hookInput(),
  });
  assert.equal(stringResult.output.type, "sync");
  if (stringResult.output.type === "sync") assert.equal(stringResult.output.continue, false);
  assert.equal((await callbacks.execute({
    hook: { type: "callback", name: "failing" },
    hookInput: hookInput(),
  })).stderr, "callback failed");
  callbacks.unregister("structured");
  assert.match((await callbacks.execute({
    hook: { type: "callback", name: "structured" },
    hookInput: hookInput(),
  })).stderr, /not registered/);
});

test("HTTP executor resolves only allowed environment variables and maps response failures", async () => {
  let request: RequestInit | undefined;
  const executor = new HttpHookExecutor(async (_url, init) => {
    request = init;
    return new Response('{"continue":true}', { status: 200 });
  });
  const result = await executor.execute({
    hook: {
      type: "http",
      url: "https://hooks.invalid/test",
      headers: { Authorization: "Bearer $TOKEN", "x-project": "$" + "{PROJECT}", "x-denied": "$SECRET" },
      allowedEnvVars: ["TOKEN", "PROJECT"],
    },
    hookInput: hookInput(),
    env: { TOKEN: "safe", PROJECT: "pilot", SECRET: "hidden" },
  });
  assert.equal(result.outcome, "success");
  assert.equal(request?.headers && new Headers(request.headers).get("authorization"), "Bearer safe");
  assert.equal(request?.headers && new Headers(request.headers).get("x-project"), "pilot");
  assert.equal(request?.headers && new Headers(request.headers).get("x-denied"), "");
  assert.equal(request?.method, "POST");

  const failed = await new HttpHookExecutor(async () => new Response("bad", { status: 503 })).execute({
    hook: { type: "http", url: "https://hooks.invalid/test" },
    hookInput: hookInput(),
  });
  assert.equal(failed.outcome, "non_blocking_error");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stderr, "HTTP hook returned 503.");

  const rejected = await new HttpHookExecutor(async () => { throw new Error("network down"); }).execute({
    hook: { type: "http", url: "https://hooks.invalid/test" },
    hookInput: hookInput(),
  });
  assert.equal(rejected.stderr, "network down");
});

function pending(id: string, stdout: string, overrides: Partial<PendingAsyncHook> = {}): PendingAsyncHook {
  return {
    id,
    startedAt: new Date(0),
    hookName: "command",
    hookEvent: "PreToolUse",
    stdout,
    stderr: "",
    responseDelivered: false,
    ...overrides,
  };
}

test("AsyncHookRegistry holds async output, collects blocking responses and removes delivered entries", () => {
  const registry = new AsyncHookRegistry();
  registry.register(pending("async", '{"async":true}'));
  registry.register(pending("empty", "  "));
  registry.register(pending("block", '{"continue":false,"reason":"unsafe"}', { asyncRewake: true }));
  registry.register(pending("allow", '{"continue":true}'));
  assert.equal(registry.list().length, 4);
  assert.deepEqual(registry.collectResponses().map((item) => ({
    id: item.id,
    rewake: item.rewake,
    continue: item.output.type === "sync" ? item.output.continue : undefined,
  })), [
    { id: "block", rewake: true, continue: false },
    { id: "allow", rewake: false, continue: true },
  ]);
  assert.equal(registry.collectResponses().length, 0);
  registry.removeDelivered();
  assert.deepEqual(registry.list().map((item) => item.id), ["async", "empty"]);
  registry.clear();
  assert.equal(registry.list().length, 0);
});

test("HookRuntime dispatches every hook kind, filters matchers and emits all effects", async () => {
  const events: string[] = [];
  const eventBus = new HookExecutionEventBus();
  const unsubscribe = eventBus.subscribe((event) => events.push(event.type + ":" + event.hookName));
  const commandExecutor = {
    execute: async () => commandResult(),
  } as unknown as CommandHookExecutor;
  const promptExecutor = {
    execute: async () => commandResult({ type: "sync", continue: true }),
  } as unknown as PromptHookExecutor;
  const httpExecutor = {
    execute: async () => commandResult({ type: "sync", systemMessage: "http" }),
  } as unknown as HttpHookExecutor;
  const agentExecutor = {
    execute: async () => ({
      ...commandResult({ type: "sync" }, "blocking"),
      stderr: "agent block",
    }),
  } as unknown as AgentHookExecutor;
  const callbackExecutor = new CallbackHookExecutor();
  callbackExecutor.register("effects", () => ({
    type: "sync",
    systemMessage: "system",
    specific: {
      hookEventName: "PreToolUse",
      additionalContext: "context",
      initialUserMessage: "hello",
      watchPaths: ["a", "b"],
      worktreePath: "/tmp/worktree",
      permissionDecision: "deny",
      permissionDecisionReason: "policy",
      updatedInput: { path: "b.txt" },
      updatedMCPToolOutput: { ok: true },
      decision: { behavior: "allow", updatedInput: { path: "c.txt" }, updatedPermissions: ["p"] },
      retry: true,
    },
  }));
  const settings: PilotDeckHooksSettings = {
    PreToolUse: [{
      matcher: "write_file",
      pluginName: "demo",
      pluginRoot: "/tmp/plugin",
      hooks: [
        { type: "command", command: "ignored" },
        { type: "prompt", prompt: "ignored" },
        { type: "http", url: "https://ignored.invalid" },
        { type: "agent", prompt: "ignored" },
        { type: "callback", name: "effects" },
        { type: "callback", name: "filtered", if: "bash" },
      ],
    }, {
      matcher: "other",
      hooks: [{ type: "callback", name: "filtered" }],
    }],
  };
  const runtime = new HookRuntime(
    settings,
    commandExecutor,
    eventBus,
    new AsyncHookRegistry(),
    promptExecutor,
    httpExecutor,
    agentExecutor,
    callbackExecutor,
  );
  const result = await runtime.run({
    event: "PreToolUse",
    hookInput: hookInput(),
    matchQuery: "write_file",
    cwd: "/tmp/project",
  });
  unsubscribe();
  assert.equal(result.events.length, 10);
  assert.equal(events.length, 10);
  assert.equal(result.blockingErrors.length, 1);
  assert.equal(result.blockingErrors[0]?.message, "agent block");
  assert.equal(result.nonBlockingErrors.length, 0);
  assert.deepEqual(result.effects, [
    { type: "system_message", content: "http" },
    { type: "block", reason: "agent block" },
    { type: "system_message", content: "system" },
    { type: "additional_context", content: "context", source: "demo:callback" },
    { type: "initial_user_message", message: "hello" },
    { type: "watch_paths", paths: ["a", "b"] },
    { type: "worktree_path", path: "/tmp/worktree" },
    { type: "permission_decision", behavior: "deny", reason: "policy" },
    { type: "updated_tool_input", input: { path: "b.txt" } },
    { type: "updated_mcp_tool_output", output: { ok: true } },
    { type: "permission_request_result", result: { behavior: "allow", updatedInput: { path: "c.txt" }, updatedPermissions: ["p"] } },
    { type: "retry_permission_denied" },
  ]);
});

test("HookRuntime maps cancelled and timeout outcomes to non-blocking errors", async () => {
  const outcomes: CommandHookExecutionResult["outcome"][] = ["cancelled", "timeout"];
  const commandExecutor = {
    execute: async () => commandResult({ type: "sync" }, outcomes.shift() ?? "success"),
  } as unknown as CommandHookExecutor;
  const runtime = new HookRuntime({
    PreToolUse: [{ hooks: [
      { type: "command", command: "ignored" },
      { type: "command", command: "ignored" },
    ] }],
  }, commandExecutor);
  const result = await runtime.run({
    event: "PreToolUse",
    hookInput: hookInput(),
    cwd: "/tmp",
  });
  assert.deepEqual(result.nonBlockingErrors.map((error) => error.code), [
    "hook_cancelled",
    "hook_non_blocking_error",
  ]);
});

function nodeCommand(script: string): string {
  return JSON.stringify(process.execPath) + " -e " + JSON.stringify(script);
}

test("CommandHookExecutor maps child exit outcomes and preserves stdout", async () => {
  const executor = new CommandHookExecutor();
  const common = { hookInput: hookInput(), cwd: process.cwd() };
  const success = await executor.execute({
    ...common,
    hook: { type: "command", command: nodeCommand("process.stdout.write('\\n{\\\"continue\\\":true}')") },
  });
  assert.equal(success.outcome, "success");
  assert.equal(success.exitCode, 0);
  assert.equal(success.output.type, "sync");
  if (success.output.type === "sync") assert.equal(success.output.continue, true);

  const blocking = await executor.execute({
    ...common,
    hook: { type: "command", command: nodeCommand("process.stdout.write('{\\\"decision\\\":\\\"block\\\"}'); process.exit(2)") },
  });
  assert.equal(blocking.outcome, "blocking");
  assert.equal(blocking.exitCode, 2);
  assert.equal(blocking.output.type, "sync");
  if (blocking.output.type === "sync") assert.equal(blocking.output.decision, "block");

  const failed = await executor.execute({
    ...common,
    hook: { type: "command", command: nodeCommand("process.stderr.write('failed'); process.exit(1)") },
  });
  assert.equal(failed.outcome, "non_blocking_error");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stderr, "failed");
});

test("CommandHookExecutor cancels and times out a still-running child", async () => {
  const executor = new CommandHookExecutor();
  const command = nodeCommand("setInterval(() => {}, 1000)");
  const controller = new AbortController();
  const cancelled = executor.execute({
    hook: { type: "command", command },
    hookInput: hookInput(),
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 1000,
  });
  controller.abort();
  assert.equal((await cancelled).outcome, "cancelled");

  const timedOut = await executor.execute({
    hook: { type: "command", command },
    hookInput: hookInput(),
    cwd: process.cwd(),
    timeoutMs: 25,
  });
  assert.equal(timedOut.outcome, "timeout");
});
