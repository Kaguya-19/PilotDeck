import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies, AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import type { PilotDeckToolResult } from "../../../src/tool/index.js";

function result(toolCallId: string, toolName: string): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "tool result" }],
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:00:00.001Z",
  };
}

function createLoop(execute: AgentRouterRuntime["execute"], scheduler: AgentRuntimeDependencies["tools"]["scheduler"] = {
  executeAll: async () => [],
}): AgentLoop {
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute,
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };
  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "test-model",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  return new AgentLoop(config, {
    router,
    tools: { registry: new ToolRegistry(), scheduler },
    tokenAccounting: {
      evaluateRequestBudget: async () => ({
        used: 1,
        displayUsed: 1,
        budgetUsed: 1,
        total: 32_768,
        ratio: 0,
        state: "ok",
      }),
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });
}

const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

test("AgentLoop completes a normal text turn with one terminal result", async () => {
  const loop = createLoop(async function* (): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "openai", model: "test-model" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "hello back" };
    yield { type: "message_end", finishReason: "stop" };
  });
  const events = [];
  for await (const event of loop.run({ sessionId: "session-1", turnId: "turn-1", messages })) events.push(event);

  assert.ok(events.some((event) => event.type === "assistant_message"));
  const terminals = events.filter((event) => event.type === "turn_completed");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.type === "turn_completed" ? terminals[0].result.type : undefined, "success");
  assert.equal(terminals[0]?.type === "turn_completed" ? terminals[0].result.stopReason : undefined, "completed");
});

test("AgentLoop executes a tool call, projects its result, and resumes with final text", async () => {
  let executeCount = 0;
  const loop = createLoop(async function* (): AsyncIterable<CanonicalModelEvent> {
    executeCount += 1;
    yield { type: "request_started", provider: "openai", model: "test-model" };
    yield { type: "message_start", role: "assistant" };
    if (executeCount === 1) {
      yield { type: "tool_call_end", toolCall: { id: "call-1", name: "read_file", input: { path: "README.md" } } };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "finished" };
    yield { type: "message_end", finishReason: "stop" };
  }, {
    executeAll: async (calls) => [result(calls[0]!.id, calls[0]!.name)],
  });
  const events = [];
  for await (const event of loop.run({ sessionId: "session-2", turnId: "turn-2", messages })) events.push(event);

  assert.equal(executeCount, 2);
  assert.ok(events.some((event) => event.type === "tool_calls_detected"));
  assert.ok(events.some((event) => event.type === "tool_result"));
  assert.ok(events.some((event) => event.type === "tool_results_projected"));
  assert.ok(events.some((event) => event.type === "assistant_message"));
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
});

test("AgentLoop returns an aborted terminal result without invoking the router", async () => {
  let executeCount = 0;
  const loop = createLoop(async function* (): AsyncIterable<CanonicalModelEvent> {
    executeCount += 1;
    yield { type: "message_end", finishReason: "stop" };
  });
  const controller = new AbortController();
  controller.abort("user_stop");
  const events = [];
  for await (const event of loop.run({ sessionId: "session-3", turnId: "turn-3", messages, abortSignal: controller.signal })) events.push(event);

  assert.equal(executeCount, 0);
  const terminal = events.find((event) => event.type === "turn_completed");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.type : undefined, "aborted");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.stopReason : undefined, "aborted_streaming");
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
});

test("AgentLoop preserves a partial assistant message when a stream aborts", async () => {
  const controller = new AbortController();
  const loop = createLoop(async function* (): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "openai", model: "test-model" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "partial answer" };
    controller.abort("user_stop");
    yield { type: "message_end", finishReason: "stop" };
  });
  const events = [];
  for await (const event of loop.run({ sessionId: "session-partial", turnId: "turn-partial", messages, abortSignal: controller.signal })) {
    events.push(event);
  }

  assert.ok(events.some((event) => event.type === "assistant_message"));
  const terminal = events.find((event) => event.type === "turn_completed");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.type : undefined, "aborted");
});

test("AgentLoop turns an unrecoverable model error into one structured failed terminal", async () => {
  const loop = createLoop(async function* (): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "openai", model: "test-model" };
    yield {
      type: "error",
      error: {
        provider: "openai",
        model: "test-model",
        protocol: "openai",
        code: "provider_failed",
        message: "provider failed",
        retryable: false,
      },
    };
  });
  const events = [];
  for await (const event of loop.run({ sessionId: "session-4", turnId: "turn-4", messages })) events.push(event);

  const terminal = events.find((event) => event.type === "turn_completed");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.type : undefined, "error");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.stopReason : undefined, "model_error");
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.ok(events.some((event) => event.type === "turn_failed"));
});

test("AgentLoop converts a thrown router failure into a structured terminal", async () => {
  const loop = createLoop(async function* (): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "openai", model: "test-model" };
    throw new Error("transport exploded");
  });
  const events = [];
  for await (const event of loop.run({ sessionId: "session-5", turnId: "turn-5", messages })) events.push(event);

  const terminal = events.find((event) => event.type === "turn_completed");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.type : undefined, "error");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.stopReason : undefined, "model_error");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.errors?.[0]?.message : undefined, "transport exploded");
  assert.ok(events.some((event) => event.type === "stop_failure"));
  assert.ok(events.some((event) => event.type === "turn_failed"));
});
