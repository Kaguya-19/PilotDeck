import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalMessage, CanonicalModelRequest, ModelDefinition } from "../../../src/model/protocol/canonical.js";
import { buildOpenAIRequest } from "../../../src/model/providers/openai/request.js";
import { parseOpenAIResponse } from "../../../src/model/providers/openai/response.js";
import { createOpenAIStreamState, normalizeOpenAIStreamEvent, splitThinkContent } from "../../../src/model/providers/openai/stream.js";
import { buildAnthropicRequest, ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME } from "../../../src/model/providers/anthropic/request.js";
import { parseAnthropicResponse } from "../../../src/model/providers/anthropic/response.js";
import { createAnthropicStreamState, normalizeAnthropicStreamEvent } from "../../../src/model/providers/anthropic/stream.js";
import { ModelProviderError } from "../../../src/model/protocol/errors.js";
import { normalizeOpenAISchema } from "../../../src/model/providers/openai/schema.js";

const capabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: true,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: true,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
};

const openaiModel: ModelDefinition = { id: "gpt-5", capabilities, multimodal: { input: ["text", "image", "audio", "pdf"] } };
const anthropicModel: ModelDefinition = { id: "claude-test", capabilities: { ...capabilities, supportsParallelToolCalls: false }, multimodal: { input: ["text", "image", "audio", "pdf"] } };

function request(provider: "openai" | "anthropic", messages: CanonicalMessage[]): CanonicalModelRequest {
  return {
    provider,
    model: provider === "openai" ? "gpt-5" : "claude-test",
    messages,
    systemPrompt: "system",
    maxOutputTokens: 321,
    temperature: 0.2,
    stream: true,
    metadata: { user_id: "user-1", trace: 7 },
    tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
    toolChoice: { type: "tool", name: "lookup" },
    thinking: { enabled: true, mode: "medium", budgetTokens: 2048 },
    outputSchema: { name: "answer", description: "Answer", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
    cacheBreakpoints: [0, 1, 3, 5, 7],
  };
}

test("OpenAI request projects media, thinking, output schema and repairs tool pairing", () => {
  const body = buildOpenAIRequest(request("openai", [
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", source: "base64", data: "AQ==", mimeType: "image/png", detail: "high" }, { type: "audio", source: "url", data: "https://audio.invalid/a", mimeType: "audio/wav" }, { type: "pdf", source: "base64", data: "JVBERi0=", mimeType: "application/pdf", bytes: 6 }] },
    { role: "assistant", content: [{ type: "thinking", text: "plan" }, { type: "tool_call", id: "same", name: "lookup", input: { q: "x" } }, { type: "tool_call", id: "same", name: "lookup", input: { q: "y" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "same", content: [{ type: "text", text: "ok" }, { type: "image", source: "base64", data: "AQ==", mimeType: "image/png" }] }, { type: "tool_result_reference", toolCallId: "missing", path: "/tmp/result", originalBytes: 20, preview: "saved", hasMore: true }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
  ]), openaiModel);
  assert.equal(body.messages[0]?.role, "system");
  assert.equal(body.messages[1]?.role, "user");
  assert.equal(body.reasoning?.effort, "medium");
  assert.equal(body.response_format?.json_schema.name, "answer");
  assert.equal(body.metadata?.trace, "7");
  assert.equal(body.tool_choice && (body.tool_choice as { function: { name: string } }).function.name, "lookup");
  const toolMessages = body.messages.filter((message) => message.role === "tool");
  assert.ok(toolMessages.length >= 2);
  assert.equal(new Set(toolMessages.map((message) => message.tool_call_id)).size, toolMessages.length);
});

test("OpenAI request handles compatible provider schemas and thinking body variants", () => {
  const provider = { id: "google", protocol: "openai" as const, url: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "x", headers: {}, models: {} };
  const body = buildOpenAIRequest({ ...request("openai", []), tools: undefined, outputSchema: { name: "x", schema: { anyOf: [{ const: "a" }, { const: "b" }] } }, thinking: { enabled: true, budgetTokens: 100 } }, openaiModel, provider);
  assert.equal((body as Record<string, unknown>).enable_thinking, undefined);
  assert.equal(body.response_format?.json_schema.strict, true);
  assert.equal((body.response_format?.json_schema.schema as { enum: string[] }).enum.length, 2);
});

test("OpenAI schema infers all literal types and leaves mixed/unknown enums conservative", () => {
  const normalized = normalizeOpenAISchema({
    values: [
      { const: true },
      { enum: [1, 2.5] },
      { enum: [null] },
      { enum: [["x"]] },
      { enum: [{ key: "value" }] },
      { enum: ["x", 1] },
      { enum: [Symbol.for("unknown")] },
      { type: "array" },
    ],
  });
  const values = normalized.values as Array<Record<string, unknown>>;
  assert.equal(values[0]?.type, "boolean");
  assert.equal(values[1]?.type, "number");
  assert.equal(values[2]?.type, "null");
  assert.equal(values[3]?.type, "array");
  assert.equal(values[4]?.type, "object");
  assert.equal(values[5]?.type, undefined);
  assert.equal(values[6]?.type, undefined);
  assert.deepEqual(values[7]?.items, {});
});

test("OpenAI response normalizes reasoning, content, duplicate ids and repaired JSON", () => {
  const parsed = parseOpenAIResponse({ id: "resp/1", choices: [{ index: 0, finish_reason: "tool_calls", message: {
    reasoning_content: "think",
    reasoning_details: [{ summary: "detail" }],
    content: [{ type: "text", text: "answer" }, { type: "text", text: "" }],
    tool_calls: [
      { id: "same", function: { name: "lookup", arguments: '{"q":"x",}' } },
      { id: "same", function: { name: "again", arguments: "{}" } },
    ],
  }}], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  assert.equal(parsed.finishReason, "tool_call");
  assert.equal(parsed.content.filter((block) => block.type === "thinking").length, 2);
  assert.equal(parsed.content.filter((block) => block.type === "text").length, 1);
  const tools = parsed.content.filter((block): block is Extract<typeof block, { type: "tool_call" }> => block.type === "tool_call");
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0]?.id, tools[1]?.id);
  assert.equal(parsed.usage?.totalTokens, 5);
  assert.throws(() => parseOpenAIResponse({ choices: [{ message: { tool_calls: [{ function: { name: "bad", arguments: "\\" } }] } }] }), (error: unknown) => error instanceof ModelProviderError && error.error.code === "invalid_tool_arguments");
});

test("OpenAI stream handles think tags, reasoning snapshots, tool aggregation and errors", () => {
  const state = createOpenAIStreamState();
  assert.deepEqual(splitThinkContent("hello<th", state, {}), [{ type: "text_delta", text: "hello", raw: {} }]);
  assert.deepEqual(splitThinkContent("ink>plan</think>answer", state, {}).map((event) => event.type), ["thinking_delta", "text_delta"]);
  const events = [
    { id: "stream/1", choices: [{ index: 0, delta: { reasoning_content: "one" } }] },
    { choices: [{ index: 0, delta: { reasoning_content: "one two", tool_calls: [{ index: 0, id: "tool-1", function: { name: "lookup", arguments: '{"q":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "", arguments: '"x"}' } }] }, finish_reason: "tool_calls" }] },
  ].flatMap((chunk) => normalizeOpenAIStreamEvent(chunk, state));
  assert.ok(events.some((event) => event.type === "message_start"));
  assert.equal(events.filter((event) => event.type === "thinking_delta").length, 2);
  assert.equal(events.filter((event) => event.type === "tool_call_end").length, 1);
  const providerError = normalizeOpenAIStreamEvent({ error: { type: "rate_limit_error", message: "slow" } }, state);
  assert.equal((providerError[0] as { error: { retryable: boolean } }).error.retryable, true);
  assert.throws(() => {
    const bad = createOpenAIStreamState();
    normalizeOpenAIStreamEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bad", arguments: "\\" } }] }, finish_reason: "length" }] }, bad);
  }, (error: unknown) => error instanceof ModelProviderError && error.error.code === "max_output_reached");
});

test("OpenAI stream handles partial close tags, empty chunks, repaired arguments and stable fallback errors", () => {
  const state = createOpenAIStreamState();
  assert.deepEqual(splitThinkContent("<think>plan</th", state, {}).map((event) => event.type), ["thinking_delta"]);
  assert.deepEqual(splitThinkContent("ink>done", state, {}).map((event) => event.type), ["text_delta"]);

  const empty = normalizeOpenAIStreamEvent({ id: "r", choices: [] }, createOpenAIStreamState());
  assert.deepEqual(empty.map((event) => event.type), ["message_start"]);

  const repaired = normalizeOpenAIStreamEvent({
    choices: [{ delta: { tool_calls: [{ index: 2, function: { arguments: '{"q":"x",}' } }] }, finish_reason: "tool_calls" }],
  }, createOpenAIStreamState());
  const repairedEnd = repaired.find((event) => event.type === "tool_call_end") as { wasRepaired?: boolean; toolCall: { input: unknown } };
  assert.equal(repairedEnd.wasRepaired, true);
  assert.deepEqual(repairedEnd.toolCall.input, { q: "x" });

  const stopped = normalizeOpenAIStreamEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }, createOpenAIStreamState());
  assert.equal((stopped.at(-1) as { finishReason: string }).finishReason, "stop");
  const unknownError = normalizeOpenAIStreamEvent({ error: { message: "" } }, createOpenAIStreamState());
  assert.equal((unknownError[0] as { error: { code: string; retryable: boolean } }).error.code, "provider_error");
  assert.equal((unknownError[0] as { error: { retryable: boolean } }).error.retryable, false);
});

test("Anthropic request projects content, structured output, tool choice and cache limits", () => {
  const body = buildAnthropicRequest(request("anthropic", [
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", source: "url", data: "https://img.invalid/a", mimeType: "image/png" }, { type: "audio", source: "base64", data: "AQ==", mimeType: "audio/wav" }, { type: "pdf", source: "base64", data: "JVBERi0=", mimeType: "application/pdf", bytes: 6 }] },
    { role: "assistant", content: [{ type: "thinking", text: "plan", signature: "sig" }, { type: "tool_call", id: "call-1", name: "lookup", input: { q: "x" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "failed" }, { type: "image", source: "base64", data: "AQ==", mimeType: "image/png" }] }] },
  ]), anthropicModel);
  const systemBlock = body.system && Array.isArray(body.system)
    ? body.system[0] as { cache_control?: { type?: string; ttl?: string } }
    : undefined;
  assert.equal(systemBlock?.cache_control?.type ?? "none", "ephemeral");
  assert.equal(systemBlock?.cache_control?.ttl ?? "none", "1h");
  assert.equal(body.tools?.[0]?.name, ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME);
  assert.equal(body.tool_choice?.name, ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME);
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2048 });
  assert.equal(body.metadata?.user_id, "user-1");
  assert.equal(body.messages[1]?.content.some((block: any) => block.type === "tool_use"), true);
});

test("Anthropic request preserves tool-choice variants and fails closed for optional metadata", () => {
  const message = { role: "user" as const, content: [] };
  const choices = [
    ["auto", { type: "auto" }],
    ["none", { type: "none" }],
    ["required", { type: "any" }],
    [{ type: "tool", name: "lookup" }, { type: "tool", name: "lookup" }],
  ] as const;
  for (const [choice, expected] of choices) {
    const body = buildAnthropicRequest({
      ...request("anthropic", [message]),
      outputSchema: { name: "answer", strict: false, schema: { type: "object" } },
      toolChoice: choice as never,
      metadata: { user_id: "", ignored: "value" },
      cacheBreakpoints: undefined,
      thinking: { enabled: false },
    }, anthropicModel);
    assert.deepEqual(body.tool_choice, expected);
    assert.equal(body.system, "system");
    assert.equal(body.metadata, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.messages[0]?.content.length, 0);
  }
});

test("Anthropic response and stream normalize text, thinking, tools, repair and transient errors", () => {
  const response = parseAnthropicResponse({ stop_reason: "tool_use", content: [
    { type: "text", text: "answer" },
    { type: "thinking", thinking: "plan", signature: "sig" },
    { type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } },
    { type: "unknown" },
  ], usage: { input_tokens: 2, output_tokens: 3 } });
  assert.equal(response.finishReason, "tool_call");
  assert.equal(response.content.length, 3);
  const state = createAnthropicStreamState();
  const events = [
    { type: "message_start" },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "lookup" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 2, output_tokens: 3 } },
  ].flatMap((event) => normalizeAnthropicStreamEvent(event, state));
  assert.deepEqual(events.map((event) => event.type), ["message_start", "text_delta", "thinking_delta", "thinking_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "usage", "message_end"]);
  const transient = normalizeAnthropicStreamEvent({ type: "error", error: { type: "rate_limit_error", message: "try again in 2s" } });
  assert.equal((transient[0] as { error: { retryable: boolean; retryAfterMs?: number } }).error.retryable, true);
  assert.equal((transient[0] as { error: { retryAfterMs?: number } }).error.retryAfterMs, 2_000);
});

test("Anthropic stream defers malformed tool JSON until terminal reason", () => {
  const state = createAnthropicStreamState();
  normalizeAnthropicStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad", name: "lookup" } }, state);
  normalizeAnthropicStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\\" } }, state);
  assert.deepEqual(normalizeAnthropicStreamEvent({ type: "content_block_stop", index: 0 }, state), []);
  const failed = normalizeAnthropicStreamEvent({ type: "message_delta", delta: { stop_reason: "max_tokens" } }, state);
  assert.equal((failed[0] as { type: string; error: { code: string } }).error.code, "max_output_reached");
  const second = createAnthropicStreamState();
  normalizeAnthropicStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad", name: "lookup" } }, second);
  normalizeAnthropicStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\\" } }, second);
  normalizeAnthropicStreamEvent({ type: "content_block_stop", index: 0 }, second);
  assert.equal((normalizeAnthropicStreamEvent({ type: "message_stop" }, second)[0] as { error: { code: string } }).error.code, "invalid_tool_arguments");
});

test("Anthropic stream handles unknown events, repaired tool JSON, and non-retryable errors", () => {
  const state = createAnthropicStreamState();
  assert.deepEqual(normalizeAnthropicStreamEvent({ type: "ping" }, state), []);
  assert.deepEqual(normalizeAnthropicStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, state), []);
  normalizeAnthropicStreamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "repair", name: "lookup" } }, state);
  normalizeAnthropicStreamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"x",}' } }, state);
  const repaired = normalizeAnthropicStreamEvent({ type: "content_block_stop", index: 1 }, state);
  assert.equal((repaired[0] as { wasRepaired?: boolean }).wasRepaired, true);
  assert.deepEqual((repaired[0] as { toolCall: { input: unknown } }).toolCall.input, { q: "x" });

  const terminal = normalizeAnthropicStreamEvent({ type: "message_stop" }, state);
  assert.deepEqual(terminal, []);
  const error = normalizeAnthropicStreamEvent({ type: "error", error: { type: "invalid_request_error" } });
  assert.equal((error[0] as { error: { retryable: boolean; message: string } }).error.retryable, false);
  assert.equal((error[0] as { error: { message: string } }).error.message, "Anthropic stream error.");
});

test("Anthropic response and stream use safe defaults for malformed and incomplete events", () => {
  const response = parseAnthropicResponse(null);
  assert.deepEqual(response.content, []);
  assert.equal(response.finishReason, "unknown");
  const fallback = parseAnthropicResponse({ content: [
    { type: "text", text: 42 },
    { type: "thinking", text: "fallback", signature: 7 },
    { type: "tool_use", id: 4, name: 5 },
    null,
  ] });
  assert.deepEqual(fallback.content, [
    { type: "text", text: "" },
    { type: "thinking", text: "fallback" },
    { type: "tool_call", id: "", name: "", input: undefined, raw: { type: "tool_use", id: 4, name: 5 } },
  ]);

  const state = createAnthropicStreamState();
  assert.deepEqual(normalizeAnthropicStreamEvent({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "x" } }, state).map((event) => event.type), ["tool_call_delta"]);
  assert.deepEqual(normalizeAnthropicStreamEvent({ type: "content_block_stop", index: 9 }, state), []);
  assert.deepEqual(normalizeAnthropicStreamEvent({ type: "message_delta", delta: {} }, state), []);
  const error = normalizeAnthropicStreamEvent({ type: "error", error: { type: "timeout_error", message: "timeout" } });
  assert.equal((error[0] as { error: { retryable: boolean } }).error.retryable, true);
  const unknown = normalizeAnthropicStreamEvent({ type: "error", error: null });
  assert.equal((unknown[0] as { error: { code: string } }).error.code, "provider_error");
});
