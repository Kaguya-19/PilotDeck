import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies, AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolResult } from "../../../src/tool/index.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";

const userMessages: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "do the work" }] },
];

type HarnessOptions = {
  config?: Partial<AgentRuntimeConfig>;
  events?: (requestIndex: number, request: CanonicalModelRequest) => CanonicalModelEvent[];
  scheduler?: AgentRuntimeDependencies["tools"]["scheduler"];
  registry?: ToolRegistry;
  context?: AgentRuntimeDependencies["context"];
  getModelTokenLimits?: AgentRuntimeDependencies["getModelTokenLimits"];
  lifecycle?: AgentRuntimeDependencies["lifecycle"];
  eventEmitter?: AgentRuntimeDependencies["eventEmitter"];
  drainEvents?: AgentRuntimeDependencies["drainEvents"];
};

function genericTool(name: string): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: true,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function toolSuccess(callId: string, toolName: string, data?: unknown, metadata?: Record<string, unknown>): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text: "ok" }],
    ...(data === undefined ? {} : { data }),
    ...(metadata ? { metadata } : {}),
    startedAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:00:00.001Z",
  };
}

function toolError(callId: string, toolName: string, code: "invalid_tool_input" | "permission_denied" | "tool_execution_failed", message = code): PilotDeckToolResult {
  return {
    type: "error",
    toolCallId: callId,
    toolName,
    error: { code, message },
    content: [{ type: "text", text: message }],
    startedAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:00:00.001Z",
  };
}

function modelError(code: string, message = code): CanonicalModelEvent {
  return {
    type: "error",
    error: {
      provider: "openai",
      model: "test-model",
      protocol: "openai",
      code,
      message,
      retryable: false,
    },
  };
}

function createHarness(options: HarnessOptions = {}): { loop: AgentLoop; requests: CanonicalModelRequest[] } {
  const requests: CanonicalModelRequest[] = [];
  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "test-model",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    maxOutputTokens: 1_024,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
    ...options.config,
  };
  const registry = options.registry ?? new ToolRegistry();
  const context = options.context ?? {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({
      messages: [...input.messages, input.toolResultMessage, ...(input.supplementalMessages ?? []).map((item) => item.message)],
      appendedMessages: [input.toolResultMessage, ...(input.supplementalMessages ?? []).map((item) => item.message)],
      diagnostics: [],
    }),
  } as AgentRuntimeDependencies["context"];
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
    execute: async function* (_decision, request): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      yield* (options.events?.(requests.length, request) ?? [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "done" },
        { type: "message_end", finishReason: "stop" },
      ]);
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };
  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry,
      scheduler: options.scheduler ?? { executeAll: async () => [] },
    },
    context,
    ...(options.getModelTokenLimits ? { getModelTokenLimits: options.getModelTokenLimits } : {}),
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(options.eventEmitter ? { eventEmitter: options.eventEmitter } : {}),
    ...(options.drainEvents ? { drainEvents: options.drainEvents } : {}),
  };
  return { loop: new AgentLoop(config, dependencies), requests };
}

async function collect(loop: AgentLoop, input: Partial<Parameters<AgentLoop["run"]>[0]> = {}) {
  const events = [];
  for await (const event of loop.run({
    sessionId: "session-recovery",
    turnId: "turn-recovery",
    messages: userMessages,
    ...input,
  })) events.push(event);
  return events;
}

test("AgentLoop retries an empty response, then emits the visible answer", async () => {
  const { loop, requests } = createHarness({
    events: (index) => index === 1
      ? [{ type: "thinking_delta", text: "thinking only" }, { type: "message_end", finishReason: "length" }]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "visible" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 2);
  assert.ok(events.some((event) => event.type === "empty_output_recovery"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop surfaces a bounded empty-response status after repeated empty output", async () => {
  const { loop, requests } = createHarness({
    events: () => [{ type: "thinking_delta", text: "still thinking" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 4);
  assert.ok(events.some((event) => event.type === "agent_status" && event.event === "model_empty_response_exhausted"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop retries and then bounds empty length responses while raising the output cap", async () => {
  const { loop, requests } = createHarness({
    config: { maxOutputTokens: 100 },
    getModelTokenLimits: () => ({ maxContextTokens: 32_768, maxOutputTokens: 1_000 }),
    events: () => [{ type: "thinking_delta", text: "still truncated" }, { type: "message_end", finishReason: "length" }],
  });
  const events = await collect(loop);
  assert.ok(requests.length >= 3);
  assert.ok(events.some((event) => event.type === "empty_output_recovery" && event.finishReason === "length"));
  assert.ok(events.some((event) => event.type === "agent_status" && event.event === "model_empty_response_exhausted"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop doubles an explicit output cap and continues after max output", async () => {
  const { loop, requests } = createHarness({
    config: { maxOutputTokens: 100 },
    getModelTokenLimits: () => ({ maxContextTokens: 32_768, maxOutputTokens: 1_000 }),
    events: (index) => index < 3
      ? [modelError("max_output_reached", "maximum output tokens reached")]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "finished" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 3);
  assert.ok(events.some((event) => event.type === "token_cap_adjusted"));
  assert.ok(events.some((event) => event.type === "turn_continued" && event.reason === "model_error"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop continues pure text output truncated by length and then completes with the retained text", async () => {
  const { loop, requests } = createHarness({
    events: (index) => index < 52
      ? [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: `partial-${index}` }, { type: "message_end", finishReason: "length" }]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "final" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 51);
  assert.ok(events.filter((event) => event.type === "turn_continued" && event.reason === "model_error").length >= 3);
  assert.ok(events.some((event) => event.type === "agent_status" && event.event === "max_output_recovery_exhausted"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop surfaces an exhausted max-output model error after continuation retries", async () => {
  const { loop, requests } = createHarness({
    events: () => [modelError("max_output_reached", "output limit reached")],
  });
  const events = await collect(loop);
  const terminal = events.findLast((event) => event.type === "turn_completed");
  assert.ok(requests.length >= 3);
  assert.equal(terminal?.result.type, "error");
  assert.equal(terminal?.result.stopReason, "model_error");
  assert.ok(events.some((event) => event.type === "stop_failure"));
});

test("AgentLoop retries invalid tool JSON when self-correction is enabled", async () => {
  const { loop, requests } = createHarness({
    config: { jsonSelfCorrect: true },
    events: (index) => index === 1
      ? [modelError("invalid_tool_arguments", "invalid JSON in tool arguments")]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "repaired" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.ok(requests.length >= 2);
  assert.equal(events.filter((event) => event.type === "turn_continued" && event.reason === "model_error").length, 1);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop recovers a partial text tool call without executing it", async () => {
  const { loop, requests } = createHarness({
    events: (index) => index === 1
      ? [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "<tool_call>" }, { type: "message_end", finishReason: "stop" }]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "safe answer" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 2);
  assert.equal(events.filter((event) => event.type === "turn_continued" && event.reason === "model_error").length, 1);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
  assert.equal(events.some((event) => event.type === "tool_calls_detected"), false);
});

test("AgentLoop recovers a repaired tool call through token bump and continuation", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop, requests } = createHarness({
    config: { maxOutputTokens: 100 },
    registry,
    getModelTokenLimits: () => ({ maxContextTokens: 32_768, maxOutputTokens: 1_000 }),
    events: (index) => index === 1
      ? [
        { type: "message_start", role: "assistant" },
        { type: "tool_call_end", toolCall: { id: "repaired", name: "lookup", input: { value: "partial" } }, wasRepaired: true },
        { type: "message_end", finishReason: "length" },
      ]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "continued" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 2);
  assert.ok(events.some((event) => event.type === "token_cap_adjusted"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop fails closed when repaired tool-call recovery is exhausted", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop, requests } = createHarness({
    config: { maxOutputTokens: 100 },
    registry,
    getModelTokenLimits: () => ({ maxContextTokens: 32_768, maxOutputTokens: 1_000 }),
    events: () => [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "always-repaired", name: "lookup", input: { value: "partial" } }, wasRepaired: true },
      { type: "message_end", finishReason: "length" },
    ],
  });
  const events = await collect(loop);
  const terminal = events.findLast((event) => event.type === "turn_completed");
  assert.ok(requests.length >= 4);
  assert.equal(terminal?.result.type, "error");
  assert.equal(terminal?.result.stopReason, "model_error");
  assert.ok(events.some((event) => event.type === "agent_status" && event.event === "tool_call_recovery_exhausted"));
  assert.equal(events.some((event) => event.type === "tool_calls_detected"), false);
});

test("AgentLoop projects a missing tool result when the model stream fails after a tool call", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop } = createHarness({
    registry,
    events: () => [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "failed-call", name: "lookup", input: {} } },
      modelError("server_error", "stream failed after tool call"),
    ],
  });
  const durable: CanonicalMessage[] = [];
  const events = await collect(loop, { onDurableMessage: (message) => { durable.push(message); } });
  assert.ok(events.some((event) => event.type === "tool_results_projected"));
  assert.ok(durable.some((message) => message.content.some((block) => block.type === "tool_result" && block.isError)));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "error");
});

test("AgentLoop preserves assistant text and retries invalid tool JSON", async () => {
  const { loop, requests } = createHarness({
    config: { jsonSelfCorrect: true },
    events: (index) => index === 1
      ? [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "partial answer" },
        modelError("invalid_tool_arguments", "invalid JSON in tool arguments"),
      ]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "recovered answer" }, { type: "message_end", finishReason: "stop" }],
  });
  const durable: CanonicalMessage[] = [];
  const events = await collect(loop, { onDurableMessage: (message) => { durable.push(message); } });
  assert.equal(requests.length, 2);
  assert.ok(durable.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text === "partial answer")));
  assert.ok(events.some((event) => event.type === "turn_continued" && event.reason === "model_error"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop applies adjust-output recovery from the context runtime", async () => {
  const contextRuntime: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({ messages: input.messages, systemPrompt: undefined, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "adjust_output_and_retry", maxOutputTokens: 128, scope: "attempt", reason: "provider-output-cap" }),
  } as AgentRuntimeDependencies["context"];
  const { loop, requests } = createHarness({
    context: contextRuntime,
    events: (index) => index === 1
      ? [modelError("provider_error", "output cap reported by provider")]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "recovered" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 2);
  assert.ok(events.some((event) => event.type === "token_cap_adjusted" && event.reason === "provider-output-cap"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop fails with prompt_too_long when pre-routing compaction still overflows", async () => {
  let modelCalls = 0;
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({ messages: input.messages, systemPrompt: undefined, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    tryAutoCompact: async () => ({
      type: "compacted",
      tier: "full",
      messages: [{ role: "user", content: [{ type: "text", text: "retained" }] }],
      snapshot: { tokens: 1_000, displayTokens: 1_000, totalContextTokens: 1_000, maxContextTokens: 100, effectiveContextTokens: 100, maxOutputTokens: 64, reservedOutputTokens: 64, ratio: 10, state: "blocking", estimateSource: "estimator" },
      error: "context remains too large",
      result: {
        compactionId: "pre-routing-overflow",
        trigger: "auto",
        preTokens: 2_000,
        postTokens: 1_000,
        messagesSummarized: 2,
        summaryMessage: { role: "assistant", content: [{ type: "text", text: "summary" }] },
        boundaryMarker: { role: "user", content: [{ type: "text", text: "boundary" }] },
        messagesToKeep: [{ role: "user", content: [{ type: "text", text: "retained" }] }],
        attachments: [],
        hookResults: [],
        diagnostics: [],
      },
    }),
  } as AgentRuntimeDependencies["context"];
  const { loop } = createHarness({
    context,
    events: () => {
      modelCalls += 1;
      return [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "should not run" }, { type: "message_end", finishReason: "stop" }];
    },
  });
  const events = await collect(loop);
  const terminal = events.findLast((event) => event.type === "turn_completed");
  assert.equal(modelCalls, 0);
  assert.equal(terminal?.result.type, "error");
  assert.equal(terminal?.result.stopReason, "prompt_too_long");
  assert.ok(events.some((event) => event.type === "stop_failure"));
});

test("AgentLoop continues when pre-routing auto compaction throws", async () => {
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({ messages: input.messages, systemPrompt: undefined, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    tryAutoCompact: async () => { throw new Error("summary backend unavailable"); },
  } as AgentRuntimeDependencies["context"];
  const { loop, requests } = createHarness({ context });
  const events = await collect(loop);
  assert.equal(requests.length, 1);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop fails open when the context recovery probe throws", async () => {
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({ messages: input.messages, systemPrompt: undefined, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => { throw new Error("recovery probe unavailable"); },
  } as AgentRuntimeDependencies["context"];
  const { loop } = createHarness({ context, events: () => [modelError("provider_failed", "provider failed permanently")] });
  const events = await collect(loop);
  const terminal = events.findLast((event) => event.type === "turn_completed");
  assert.equal(terminal?.result.type, "error");
  assert.equal(terminal?.result.stopReason, "model_error");
});

test("AgentLoop compacts and persists a context recovery result", async () => {
  let compactCalls = 0;
  const persisted: unknown[] = [];
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({ messages: input.messages, systemPrompt: undefined, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "compact_and_retry", maxContextTokens: 16_384, maxOutputTokens: 256, reason: "provider-context-limit" }),
    tryAutoCompact: async () => {
      compactCalls += 1;
      if (compactCalls === 1) return { type: "skipped", snapshot: { tokens: 100, displayTokens: 100, totalContextTokens: 100, maxContextTokens: 32_768, effectiveContextTokens: 32_768, maxOutputTokens: 1_024, reservedOutputTokens: 1_024, ratio: 0, state: "ok", estimateSource: "estimator" } };
      return {
        type: "compacted",
        tier: "full",
        messages: [{ role: "user", content: [{ type: "text", text: "compact tail" }] }],
        snapshot: { tokens: 20, displayTokens: 20, totalContextTokens: 16_384, maxContextTokens: 16_384, effectiveContextTokens: 16_384, maxOutputTokens: 256, reservedOutputTokens: 256, ratio: 0, state: "ok", estimateSource: "estimator" },
        result: {
          compactionId: "compact-recovery",
          trigger: "reactive",
          preTokens: 100,
          postTokens: 20,
          messagesSummarized: 1,
          summaryMessage: { role: "assistant", content: [{ type: "text", text: "summary" }] },
          boundaryMarker: { role: "user", content: [{ type: "text", text: "boundary" }] },
          messagesToKeep: [{ role: "user", content: [{ type: "text", text: "compact tail" }] }],
          attachments: [],
          hookResults: [],
          diagnostics: [],
        },
      };
    },
  } as AgentRuntimeDependencies["context"];
  const { loop, requests } = createHarness({
    context,
    events: (index) => index === 1
      ? [modelError("context_overflow", "context length exceeded")]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "after compact" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop, { onCompactPersisted: (value) => { persisted.push(value); } });
  assert.ok(requests.length >= 2);
  assert.ok(compactCalls >= 2);
  assert.ok(persisted.length >= 1);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop handles a context recovery truncate decision without blocking the turn", async () => {
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({ messages: input.messages, systemPrompt: undefined, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "truncate_head_and_retry", keepRatio: 0.5, reason: "single-shot-truncate" }),
  } as AgentRuntimeDependencies["context"];
  const { loop, requests } = createHarness({
    context,
    events: (index) => index === 1
      ? [modelError("prompt_too_long", "input length and max_tokens exceed context limit")]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "after truncate" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 2);
  assert.equal(events.filter((event) => event.type === "turn_continued" && event.reason === "model_error").length, 1);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop repairs a missing reasoning-content response once", async () => {
  const { loop, requests } = createHarness({
    events: (index) => index === 1
      ? [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "partial" },
        modelError("provider_error", "thinking mode reasoning_content must be passed back"),
      ]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "answer" }, { type: "message_end", finishReason: "stop" }],
  });
  const events = await collect(loop);
  assert.equal(requests.length, 2);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
  assert.ok(requests[1]?.messages.some((message) => message.content.some((block) => block.type === "thinking" && block.reasoningContent === "")));
});

test("AgentLoop stops after maxTurns instead of starting another model turn", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop, requests } = createHarness({
    registry,
    events: () => [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "call-1", name: "lookup", input: {} } },
      { type: "message_end", finishReason: "tool_call" },
    ],
    scheduler: {
      executeAll: async (calls) => calls.map((call) => toolSuccess(call.id, call.name)),
    },
  });
  const events = await collect(loop, { maxTurns: 1 });
  assert.equal(requests.length, 1);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "max_turns");
  assert.ok(events.some((event) => event.type === "agent_status" && event.event === "max_turns_reached"));
});

test("AgentLoop stops with structured output after the structured tool result", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("structured_output"));
  const { loop } = createHarness({
    config: { stopOnStructuredOutput: true },
    registry,
    events: () => [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "call-structured", name: "structured_output", input: {} } },
      { type: "message_end", finishReason: "tool_call" },
    ],
    scheduler: {
      executeAll: async () => [toolSuccess("call-structured", "structured_output", { answer: 42 }, { structuredOutput: true })],
    },
  });
  const events = await collect(loop);
  const terminal = events.findLast((event) => event.type === "turn_completed");
  assert.equal(terminal?.result.type, "success");
  assert.deepEqual(terminal?.result.structuredOutput, { answer: 42 });
  assert.ok(events.some((event) => event.type === "agent_status" && event.event === "structured_output_completed"));
});

test("AgentLoop turns a lifecycle-blocked tool result into a terminal failure", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop } = createHarness({
    registry,
    events: () => [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "call-block", name: "lookup", input: {} } },
      { type: "message_end", finishReason: "tool_call" },
    ],
    scheduler: {
      executeAll: async () => [toolSuccess("call-block", "lookup", undefined, { lifecycle: { blocked: { reason: "policy blocked" } } })],
    },
  });
  const events = await collect(loop);
  const terminal = events.findLast((event) => event.type === "turn_completed");
  assert.equal(terminal?.result.type, "error");
  assert.equal(terminal?.result.stopReason, "tool_error");
  assert.ok(events.some((event) => event.type === "agent_status" && event.event === "lifecycle_blocked"));
});

test("AgentLoop blocks a completed text turn when the Stop lifecycle hook blocks", async () => {
  const { loop } = createHarness({
    lifecycle: {
      dispatch: async ({ event }) => event === "Stop"
        ? {
          effects: [{ type: "block", reason: "stop policy blocked" }],
          messages: [],
          events: [],
          blockingErrors: [],
          nonBlockingErrors: [],
        }
        : { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] },
    } as AgentRuntimeDependencies["lifecycle"],
  });
  const events = await collect(loop);
  const terminal = events.findLast((event) => event.type === "turn_completed");
  assert.equal(terminal?.result.type, "error");
  assert.equal(terminal?.result.stopReason, "tool_error");
  assert.ok(events.some((event) => event.type === "stop_requested"));
  assert.ok(events.some((event) => event.type === "agent_status" && event.event === "lifecycle_blocked"));
});

test("AgentLoop converts a scheduler rejection into missing tool results and continues", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop, requests } = createHarness({
    registry,
    events: (index) => index === 1
      ? [
        { type: "message_start", role: "assistant" },
        { type: "tool_call_end", toolCall: { id: "scheduler-failed", name: "lookup", input: {} } },
        { type: "message_end", finishReason: "tool_call" },
      ]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "after scheduler failure" }, { type: "message_end", finishReason: "stop" }],
    scheduler: {
      executeAll: async () => { throw new Error("scheduler unavailable"); },
    },
  });
  const events = await collect(loop);
  assert.equal(requests.length, 2);
  assert.ok(events.some((event) => event.type === "tool_result" && event.result.type === "error"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop circuit breaker terminates identical invalid tool calls after one grace retry", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop, requests } = createHarness({
    registry,
    events: () => [
      { type: "message_start", role: "assistant" },
      { type: "tool_call_end", toolCall: { id: "same-call", name: "lookup", input: { value: "bad" } } },
      { type: "message_end", finishReason: "tool_call" },
    ],
    scheduler: {
      executeAll: async () => [toolError("same-call", "lookup", "invalid_tool_input", "value is invalid")],
    },
  });
  const events = await collect(loop);
  assert.equal(requests.length, 4);
  assert.ok(events.some((event) => event.type === "turn_continued" && event.reason === "model_error"));
  const terminal = events.findLast((event) => event.type === "turn_completed");
  assert.equal(terminal?.result.type, "error");
  assert.equal(terminal?.result.stopReason, "tool_error");
  assert.equal(terminal?.result.errors?.[0]?.code, "agent_tool_error_loop");
});

test("AgentLoop applies ask-mode filtering before sending the model request", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("bash"));
  registry.register(genericTool("read_file"));
  registry.register(genericTool("agent"));
  registry.register(genericTool("write_file"));
  const { loop, requests } = createHarness({ registry, config: { runMode: "ask" } });
  await collect(loop, { canPrompt: true });
  const names = requests[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("agent"));
  assert.ok(names.includes("bash"));
  assert.equal(names.includes("write_file"), false);
  assert.match(requests[0]?.tools?.find((tool) => tool.name === "agent")?.description ?? "", /ask/i);
});

test("AgentLoop prepares plan-mode requests, emits instruction identity, and degrades missing media references", async () => {
  const emitted: string[] = [];
  const { loop, requests } = createHarness({
    config: { permissionMode: "plan" },
    eventEmitter: (event) => { emitted.push(event.type); },
    context: {
      prepareForModel: async (input) => ({
        messages: input.messages,
        systemPrompt: "system",
        systemPromptParts: ["system"],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
        cacheBreakpoints: [{ messageIndex: 0, blockIndex: 0 }],
      }),
      applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    } as AgentRuntimeDependencies["context"],
  });
  await collect(loop, {
    allowPlanModeTools: true,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "make a plan" },
        { type: "media_reference", path: "/does/not/exist.png", originalBytes: 10, preview: "missing image", hasMore: false, mimeType: "image/png", mediaType: "image" },
      ],
    }],
  });
  assert.match(requests[0]?.messages.at(-1)?.content.find((block) => block.type === "text")?.text ?? "", /Plan mode is active/);
  assert.equal(requests[0]?.cacheBreakpoints?.length, 1);
  assert.ok(emitted.includes("instructions_loaded"));
});

test("AgentLoop falls back to projected tool results when context application fails", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop } = createHarness({
    registry,
    context: {
      prepareForModel: async (input) => ({ messages: input.messages, systemPrompt: undefined, systemPromptParts: [], tools: input.tools, diagnostics: [], boundaries: [] }),
      applyToolResults: async () => { throw new Error("context apply unavailable"); },
    } as AgentRuntimeDependencies["context"],
    events: (index) => index === 1
      ? [{ type: "message_start", role: "assistant" }, { type: "tool_call_end", toolCall: { id: "apply-failed", name: "lookup", input: {} } }, { type: "message_end", finishReason: "tool_call" }]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "continued" }, { type: "message_end", finishReason: "stop" }],
    scheduler: { executeAll: async (calls) => calls.map((call) => toolSuccess(call.id, call.name)) },
  });
  const events = await collect(loop);
  assert.ok(events.some((event) => event.type === "tool_results_projected"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop repairs a text-extracted tool alias before scheduling it", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const scheduledNames: string[] = [];
  const { loop } = createHarness({
    registry,
    config: { toolAliases: { look: "lookup" } },
    events: (index) => index === 1
      ? [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: '<tool_call>{"name":"look","arguments":{"value":"x"}}</tool_call>' }, { type: "message_end", finishReason: "tool_call" }]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "alias completed" }, { type: "message_end", finishReason: "stop" }],
    scheduler: {
      executeAll: async (calls) => {
        scheduledNames.push(...calls.map((call) => call.name));
        return calls.map((call) => toolSuccess(call.id, call.name));
      },
    },
  });
  const events = await collect(loop);
  assert.deepEqual(scheduledNames, ["lookup"]);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop wires the public agent tool to a scoped subagent fork", async () => {
  const registry = new ToolRegistry();
  registry.register(createAgentTool());
  const { loop, requests } = createHarness({
    registry,
    events: (index) => index === 1
      ? [
          { type: "message_start", role: "assistant" },
          {
            type: "tool_call_end",
            toolCall: {
              id: "agent-call",
              name: "agent",
              input: {
                description: "Inspect the task",
                prompt: "Return a concise report.",
                subagent_type: "explore",
              },
            },
          },
          { type: "message_end", finishReason: "tool_call" },
        ]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "subagent report" }, { type: "message_end", finishReason: "stop" }],
    config: { maxSubagentDepth: 1 },
  });

  const events = await collect(loop);
  assert.equal(requests.length, 2);
  assert.ok(events.some((event) => event.type === "tool_result"));
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop maps buffered subagent tool lifecycle events to status events", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("read_file"));
  let drained = false;
  const { loop } = createHarness({
    registry,
    drainEvents: () => {
      if (drained) return [];
      drained = true;
      return [
        { type: "pre_tool_execute", sessionId: "/workspace/project::sub::child-1", turnId: "child-turn", toolCallId: "call-1", toolName: "read_file" },
        { type: "post_tool_execute", sessionId: "/workspace/project::sub::child-1", turnId: "child-turn", toolCallId: "call-1", toolName: "read_file", success: true },
      ];
    },
    events: (index) => index === 1
      ? [{ type: "message_start", role: "assistant" }, { type: "tool_call_end", toolCall: { id: "call-1", name: "read_file", input: { path: "README.md" } } }, { type: "message_end", finishReason: "tool_call" }]
      : [{ type: "message_start", role: "assistant" }, { type: "text_delta", text: "status complete" }, { type: "message_end", finishReason: "stop" }],
    scheduler: {
      executeAll: async (calls) => calls.map((call) => toolSuccess(call.id, call.name)),
    },
  });

  const events = await collect(loop);
  const statusEvents = events.filter((event) => event.type === "subagent_status");
  assert.deepEqual(statusEvents.map((event) => event.type === "subagent_status" ? event.status : undefined), ["tool_started", "tool_completed"]);
  assert.equal(events.findLast((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop snapshots seed state without sharing mutable collections", async () => {
  const { loop } = createHarness();
  const snapshot = loop.snapshotFileState();
  assert.deepEqual(snapshot.allowedReadFiles, []);
  assert.notEqual(snapshot.allowedReadFiles, (loop.snapshotFileState()).allowedReadFiles);
});

test("AgentLoop helper repairs only known extracted tool aliases and preserves message identity", async () => {
  const registry = new ToolRegistry();
  registry.register(genericTool("lookup"));
  const { loop } = createHarness({ registry, config: { toolAliases: { look: "lookup" } } });
  const helper = loop as unknown as {
    repairTextExtractedToolNames: (message: CanonicalMessage, calls: Array<{ id: string; name: string; input: unknown }>) => {
      message: CanonicalMessage;
      toolCalls: Array<{ id: string; name: string; input: unknown }>;
    };
  };
  const message: CanonicalMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "before" },
      { type: "tool_call", id: "call-1", name: "look", input: {} },
      { type: "tool_call", id: "call-2", name: "unknown", input: {} },
    ],
  };
  const repaired = helper.repairTextExtractedToolNames(message, [
    { id: "call-1", name: "look", input: {} },
    { id: "call-2", name: "unknown", input: {} },
  ]);
  assert.equal(repaired.toolCalls[0]?.name, "lookup");
  assert.equal(repaired.toolCalls[1]?.name, "unknown");
  assert.equal(repaired.message.content[0]?.type, "text");
  assert.equal(repaired.message.content[1]?.type, "tool_call");
  assert.equal(repaired.message.content[1]?.type === "tool_call" ? repaired.message.content[1].name : undefined, "lookup");
});

test("AgentLoop helper resolves transient token caps before configured and model limits", async () => {
  const { loop } = createHarness({
    config: { maxContextTokens: undefined, maxOutputTokens: 900 },
    getModelTokenLimits: () => ({ maxContextTokens: 16_000, maxOutputTokens: 800 }),
  });
  const helper = loop as unknown as {
    currentMaxContextTokens: (provider: string, model: string) => number;
    currentMaxOutputTokens: (provider: string, model: string) => number | undefined;
    setTransientTokenCap: (provider: string, model: string, cap: { maxContextTokens?: number; hardMaxOutputTokens?: number }) => void;
  };
  assert.equal(helper.currentMaxContextTokens("openai", "model"), 16_000);
  assert.equal(helper.currentMaxOutputTokens("openai", "model"), 800);
  helper.setTransientTokenCap("openai", "model", { maxContextTokens: 4_000, hardMaxOutputTokens: 300 });
  assert.equal(helper.currentMaxContextTokens("openai", "model"), 4_000);
  assert.equal(helper.currentMaxOutputTokens("openai", "model"), 300);
});
