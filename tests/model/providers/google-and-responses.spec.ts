import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelDefinition,
  ModelProtocol,
} from "../../../src/model/protocol/canonical.js";
import { buildGoogleRequest } from "../../../src/model/providers/google/request.js";
import {
  normalizeGoogleFinishReason,
  normalizeGoogleUsage,
  parseGoogleResponse,
} from "../../../src/model/providers/google/response.js";
import {
  createGoogleStreamState,
  normalizeGoogleStreamEvent,
} from "../../../src/model/providers/google/stream.js";
import { normalizeGoogleModelId } from "../../../src/model/providers/google/modelId.js";
import {
  cleanSchemaForGoogle,
  normalizeGoogleToolSchema,
} from "../../../src/model/providers/google/schema.js";
import { buildOpenAIResponsesRequest } from "../../../src/model/providers/openai-responses/request.js";
import { parseOpenAIResponsesResponse } from "../../../src/model/providers/openai-responses/response.js";
import {
  createOpenAIResponsesStreamState,
  normalizeOpenAIResponsesStreamEvent,
} from "../../../src/model/providers/openai-responses/stream.js";
import { ModelProviderError } from "../../../src/model/protocol/errors.js";

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

function model(protocol: ModelProtocol, id = protocol === "google" ? "gemini-2.5-flash" : "gpt-5"):
  ModelDefinition {
  return { id, capabilities, multimodal: { input: ["text", "image", "pdf", "audio"] } };
}

function request(protocol: ModelProtocol, messages: CanonicalMessage[]): CanonicalModelRequest {
  return {
    provider: protocol,
    model: protocol === "google" ? "google/gemini-3.1-flash" : "gpt-5",
    messages,
    systemPrompt: "Follow the contract.",
    maxOutputTokens: 321,
    temperature: 0.2,
    stream: true,
    metadata: { trace: 7, mode: "test" },
    tools: [{
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", pattern: "^[a-z]+$" } },
        required: ["query"],
        additionalProperties: false,
      },
    }],
    toolChoice: { type: "tool", name: "lookup" },
    thinking: { enabled: true, mode: "medium", budgetTokens: 2048 },
    outputSchema: {
      name: "answer",
      description: "Structured answer",
      schema: { type: "object", properties: { ok: { const: true } } },
    },
  };
}

test("Gemini request projects roles, tools, thinking, schema and safe model id", () => {
  const body = buildGoogleRequest(request("google", [
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", source: "url", data: "https://img.invalid/a", mimeType: "image/png" }] },
    { role: "assistant", content: [{ type: "thinking", text: "plan", signature: "sig" }, { type: "tool_call", id: " call/1 ", name: "lookup", input: { query: "pilot" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: " call/1 ", content: [{ type: "text", text: "found" }, { type: "image", source: "base64", data: "AQ==", mimeType: "image/png" }] }] },
  ]), model("google"));

  assert.equal(body.model, "gemini-3-flash-preview");
  assert.deepEqual(body.config?.systemInstruction, { text: "Follow the contract." });
  assert.equal(body.config?.maxOutputTokens, 321);
  assert.equal(body.config?.automaticFunctionCalling?.disable, true);
  assert.equal(body.config?.responseMimeType, "application/json");
  assert.deepEqual(body.config?.thinkingConfig, { includeThoughts: true, thinkingBudget: 2048 });
  const googleConfig = body.config as Record<string, unknown>;
  const googleTools = googleConfig.tools as Array<{ functionDeclarations?: Array<Record<string, unknown>> }>;
  assert.equal(googleTools[0]?.functionDeclarations?.[0]?.name, "lookup");
  assert.deepEqual(body.config?.toolConfig, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
  });
  const contents = body.contents as unknown as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  assert.equal(contents[0]?.role, "user");
  assert.equal(contents[1]?.role, "model");
  assert.equal(contents[1]?.parts[0]?.thought, true);
  assert.deepEqual(contents[1]?.parts[1]?.functionCall, {
    id: "call_1",
    name: "lookup",
    args: { query: "pilot" },
  });
  const functionResponse = contents[2]?.parts[0]?.functionResponse as { response: unknown; parts?: unknown[] };
  assert.deepEqual(functionResponse.response, {
    output: "found\n[Image: image/png, 4 base64 characters]",
  });
  assert.deepEqual(functionResponse.parts, [
    { inlineData: { data: "AQ==", mimeType: "image/png" } },
  ]);
  assert.equal(googleTools[0]?.functionDeclarations?.[0]?.parametersJsonSchema &&
    (googleTools[0].functionDeclarations[0].parametersJsonSchema as Record<string, unknown>).additionalProperties, undefined);
});

test("Gemini request supplies a user prefix for model-first history and an empty fallback", () => {
  const modelDef = model("google");
  const first = buildGoogleRequest({ ...request("google", [{ role: "assistant", content: [{ type: "text", text: "old" }] }]), tools: undefined }, modelDef);
  assert.deepEqual(first.contents, [
    { role: "user", parts: [{ text: "Continue the conversation from the available context." }] },
    { role: "model", parts: [{ text: "old" }] },
  ]);

  const empty = buildGoogleRequest({ ...request("google", []), tools: undefined }, modelDef);
  assert.deepEqual(empty.contents, [{ role: "user", parts: [{ text: "" }] }]);
});

test("Gemini request handles disabled thinking, level thinking, tool-choice modes and mixed media", () => {
  const modelDef = model("google", "gemini-3.1-flash");
  const base = request("google", [
    { role: "assistant", content: [{ type: "text", text: "" }, { type: "thinking", text: "plan" }] },
    { role: "user", content: [
      { type: "image", source: "base64", data: "AQ==", mimeType: "image/png" },
      { type: "pdf", source: "url", data: "https://files.invalid/a.pdf", mimeType: "application/pdf" },
      { type: "audio", source: "base64", data: "Ag==", mimeType: "audio/wav" },
      { type: "media_reference", preview: "[saved media]", path: "/tmp/media" },
    ] },
  ]);
  for (const [toolChoice, mode] of [
    [undefined, undefined],
    ["auto", "AUTO"],
    ["none", "NONE"],
    ["required", "ANY"],
  ] as const) {
    const body = buildGoogleRequest({
      ...base,
      tools: undefined,
      toolChoice: toolChoice as never,
      thinking: { enabled: false },
      systemPrompt: undefined,
      outputSchema: undefined,
    }, modelDef);
    assert.equal(body.config?.thinkingConfig, undefined);
    if (mode) assert.deepEqual(body.config?.toolConfig, { functionCallingConfig: { mode } });
    else assert.equal(body.config?.toolConfig, undefined);
    const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    assert.equal(contents[0]?.role, "user");
    assert.equal(contents[1]?.role, "model");
    assert.deepEqual(contents[2]?.parts, [
      { inlineData: { data: "AQ==", mimeType: "image/png" } },
      { fileData: { fileUri: "https://files.invalid/a.pdf", mimeType: "application/pdf" } },
      { inlineData: { data: "Ag==", mimeType: "audio/wav" } },
      { text: "[saved media]" },
    ]);
  }

  const level = buildGoogleRequest({ ...base, tools: undefined, toolChoice: undefined, thinking: { enabled: true, mode: "high" } }, modelDef);
  assert.deepEqual(level.config?.thinkingConfig, { includeThoughts: true, thinkingLevel: "high" });
});

test("Gemini response normalizes text, thinking, tool calls, usage and finish reasons", () => {
  const parsed = parseGoogleResponse({
    responseId: "resp/1",
    candidates: [{
      finishReason: "MAX_TOKENS",
      content: { parts: [
        { text: "think", thought: true, thoughtSignature: "sig" },
        { text: "answer" },
        { functionCall: { id: "id/1", name: "lookup", args: { query: "x" } } },
        { functionCall: { id: "id/1", name: "again", args: "bad" } },
      ] },
    }],
    usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 4, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
  });

  assert.deepEqual(parsed.content.slice(0, 2), [
    { type: "thinking", text: "think", signature: "sig" },
    { type: "text", text: "answer" },
  ]);
  const googleToolCalls = parsed.content.filter((block): block is Extract<typeof block, { type: "tool_call" }> => block.type === "tool_call");
  assert.equal(googleToolCalls[0]?.id, "id_1");
  assert.equal(googleToolCalls[1]?.id, "id_1_2");
  assert.deepEqual(parsed.usage, { inputTokens: 16, outputTokens: 5, cacheReadTokens: 4, totalTokens: 25 });
  assert.equal(parsed.finishReason, "length");
  assert.equal(normalizeGoogleFinishReason("SAFETY"), "content_filter");
  assert.equal(normalizeGoogleFinishReason("MALFORMED_FUNCTION_CALL"), "tool_call");
  assert.equal(normalizeGoogleUsage({}), undefined);
});

test("Gemini stream emits one start, thinking/text/tool events, usage and final reason", () => {
  const state = createGoogleStreamState();
  const first = normalizeGoogleStreamEvent({ responseId: "stream/1", candidates: [{ content: { parts: [{ text: "hi" }, { text: "reason", thought: true, thoughtSignature: "s" }] } }] }, state);
  assert.deepEqual(first.map((event) => event.type), ["message_start", "text_delta", "thinking_delta"]);
  const second = normalizeGoogleStreamEvent({ usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 }, candidates: [{ content: { parts: [{ functionCall: { id: "fn/1", name: "lookup", args: { q: 1 } } }] }, finishReason: "STOP" }] }, state);
  assert.deepEqual(second.map((event) => event.type), ["usage", "tool_call_start", "tool_call_delta", "tool_call_end", "message_end"]);
  assert.equal(second.at(-1)?.type, "message_end");
  assert.equal((second.at(-1) as { finishReason: string }).finishReason, "stop");
  assert.equal(state.ended, true);
  assert.deepEqual(normalizeGoogleStreamEvent({}, state), []);
});

test("Gemini stream creates stable ids for malformed and duplicate function calls", () => {
  const state = createGoogleStreamState();
  const events = normalizeGoogleStreamEvent({
    responseId: " response/id ",
    candidates: [{ content: { parts: [
      { functionCall: { name: "first", args: [] } },
      { functionCall: { id: "same/id", name: "second", args: { ok: true } } },
      { functionCall: { id: "same/id", name: "third", args: null } },
      { text: "" },
      { unknown: true },
    ] } }],
  }, state);
  const calls = events.filter((event) => event.type === "tool_call_end") as Array<{ toolCall: { id: string; input: unknown } }>;
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.toolCall.id, "call_response_id_0");
  assert.equal(calls[1]?.toolCall.id, "same_id");
  assert.equal(calls[2]?.toolCall.id, "same_id_2");
  assert.deepEqual(calls[0]?.toolCall.input, {});
  assert.deepEqual(calls[2]?.toolCall.input, {});
});

test("OpenAI Responses request projects messages, function items, media, schema and reasoning", () => {
  const body = buildOpenAIResponsesRequest(request("openai-responses", [
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", source: "base64", data: "AQ==", mimeType: "image/png", detail: "high" }, { type: "audio", source: "url", data: "https://audio.invalid/a", mimeType: "audio/wav" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "lookup", input: { query: "x" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "ok" }, { type: "pdf", source: "base64", data: "JVBERi0=", mimeType: "application/pdf", bytes: 6 }] }, { type: "tool_result_reference", toolCallId: "call-2", path: "/tmp/out", originalBytes: 99, preview: "saved", hasMore: true }] },
  ]), model("openai-responses"));

  assert.equal(body.model, "gpt-5");
  assert.equal(body.instructions, "Follow the contract.");
  assert.equal(body.max_output_tokens, 321);
  assert.equal(body.store, false);
  assert.deepEqual(body.metadata, { trace: "7", mode: "test" });
  assert.deepEqual(body.tool_choice, { type: "function", name: "lookup" });
  assert.equal(body.tools?.[0]?.strict, true);
  assert.equal(body.text?.format.type, "json_schema");
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.deepEqual(body.input[0], {
    role: "user",
    content: [
      { type: "input_text", text: "hello" },
      { type: "input_image", image_url: "data:image/png;base64,AQ==", detail: "high" },
      { type: "input_text", text: "[Audio URL: https://audio.invalid/a]" },
    ],
  });
  assert.deepEqual(body.input[1], { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"query":"x"}' });
  assert.deepEqual(body.input[2], {
    type: "function_call_output",
    call_id: "call-1",
    output: "ok\n[PDF: application/pdf, 8 base64 characters]",
  });
  const input = body.input as unknown as Array<Record<string, unknown>>;
  assert.equal(input[3]?.role, "user");
  assert.equal(input[4]?.type, "function_call_output");
  assert.equal(input[4]?.call_id, "call-2");
  assert.match(String(input[4]?.output), /saved/);
  assert.match(String(input[4]?.output), /Full output was saved at/);
});

test("OpenAI Responses response normalizes output text, reasoning, repaired tools and statuses", () => {
  const parsed = parseOpenAIResponsesResponse({
    id: "resp-1",
    status: "completed",
    output_text: "answer",
    output: [
      { type: "message", content: [{ type: "output_text", text: "answer" }, { type: "output_text", text: "detail" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"query":"x",}' },
    ],
    usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
  });
  assert.deepEqual(parsed.content.filter((block) => block.type === "text"), [
    { type: "text", text: "answer" },
    { type: "text", text: "answer" },
    { type: "text", text: "detail" },
  ]);
  assert.deepEqual(parsed.content.find((block) => block.type === "thinking"), { type: "thinking", text: "think" });
  assert.deepEqual(parsed.content.find((block) => block.type === "tool_call"), {
    type: "tool_call", id: "call-1", name: "lookup", input: { query: "x" }, raw: { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"query":"x",}' },
  });
  assert.equal(parsed.finishReason, "tool_call");
  assert.equal(parsed.usage?.inputTokens, 4);
  assert.equal(parsed.usage?.outputTokens, 5);
  assert.equal(parsed.usage?.totalTokens, 9);
  assert.equal(parseOpenAIResponsesResponse({ status: "incomplete" }).finishReason, "length");
  assert.equal(parseOpenAIResponsesResponse({ status: "failed" }).finishReason, "error");
  assert.equal(parseOpenAIResponsesResponse({ status: "in_progress" }).finishReason, "unknown");
});

test("OpenAI Responses response rejects unrecoverable tool JSON", () => {
  assert.throws(
    () => parseOpenAIResponsesResponse({ status: "completed", output: [{ type: "function_call", name: "bad", arguments: "\\" }] }),
    (error: unknown) => error instanceof ModelProviderError && error.error.code === "invalid_tool_arguments",
  );
});

test("OpenAI Responses stream assembles text, reasoning and a tool call exactly once", () => {
  const state = createOpenAIResponsesStreamState();
  const events = [
    { type: "response.created", response: { id: "resp-1" } },
    { type: "response.output_text.delta", delta: "hello" },
    { type: "response.reasoning_summary_text.delta", delta: "think" },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup" } },
    { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '{"q":' },
    { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '"x"}' },
    { type: "response.function_call_arguments.done", item_id: "item-1" },
    { type: "response.function_call_arguments.done", item_id: "item-1" },
    { type: "response.completed", response: { id: "resp-1", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
  ].flatMap((event) => normalizeOpenAIResponsesStreamEvent(event, state));

  assert.deepEqual(events.map((event) => event.type), [
    "message_start", "text_delta", "thinking_delta", "tool_call_start", "tool_call_delta", "tool_call_delta", "tool_call_end", "usage", "message_end",
  ]);
  const tool = events.find((event) => event.type === "tool_call_end") as { toolCall: { id: string; input: unknown } };
  assert.equal(tool.toolCall.id, "call-1");
  assert.deepEqual(tool.toolCall.input, { q: "x" });
  assert.equal((events.at(-1) as { finishReason: string }).finishReason, "tool_call");
});

test("OpenAI Responses stream exposes incomplete and failed terminal events", () => {
  const incomplete = normalizeOpenAIResponsesStreamEvent({ type: "response.incomplete" });
  assert.deepEqual(incomplete.map((event) => event.type), ["message_start", "message_end"]);
  assert.equal((incomplete[1] as { finishReason: string }).finishReason, "length");

  const failed = normalizeOpenAIResponsesStreamEvent({ type: "response.failed", response: { error: { code: "bad_gateway", message: "no" } } });
  assert.deepEqual(failed.map((event) => event.type), ["message_start", "error", "message_end"]);
  assert.equal((failed[1] as { error: { code: string } }).error.code, "bad_gateway");

  const transportError = normalizeOpenAIResponsesStreamEvent({ type: "error", error: { message: "socket closed" } });
  assert.deepEqual(transportError.map((event) => event.type), ["error"]);
});

test("model id and Google finish/usage normalization fail closed for malformed values", () => {
  assert.equal(normalizeGoogleModelId(" google/gemini-3-pro "), "gemini-3-pro-preview");
  assert.equal(normalizeGoogleModelId("gemini-3-flash"), "gemini-3-flash-preview");
  assert.equal(normalizeGoogleModelId("gemini-3.1-pro"), "gemini-3.1-pro-preview");
  assert.equal(normalizeGoogleModelId("gemini-3.1-flash-lite"), "gemini-3.1-flash-lite-preview");
  assert.equal(normalizeGoogleModelId("custom-model"), "custom-model");
  assert.equal(normalizeGoogleFinishReason("unknown-reason"), "unknown");
  assert.equal(normalizeGoogleUsage({ promptTokenCount: "bad", totalTokenCount: Infinity }), undefined);
});

test("Google schema cleaning removes unsupported keywords and preserves valid required fields", () => {
  const normalized = normalizeGoogleToolSchema({
    type: ["object", "null"],
    required: ["good", "missing", 3],
    properties: {
      good: { const: "yes", pattern: "ignored" },
      "bad-name": { type: "string" },
      list: { type: "array" },
    },
    additionalProperties: false,
    $schema: "ignored",
  });
  assert.equal(normalized.type, "object");
  assert.deepEqual(normalized.required, ["good"]);
  assert.deepEqual(normalized.properties, {
    good: { enum: ["yes"] },
    list: { type: "array", items: {} },
  });
  assert.deepEqual(cleanSchemaForGoogle(["x", { const: 1 }]), ["x", { enum: [1] }]);
  assert.deepEqual(normalizeGoogleToolSchema("bad" as unknown as Record<string, unknown>), { type: "object", properties: {} });
});

test("Google schema cleaning flattens literal unions, resolves refs and breaks cycles", () => {
  const union = normalizeGoogleToolSchema({
    anyOf: [
      { type: "object", properties: { kind: { const: "a" }, shared: { enum: [1] } }, required: ["kind"] },
      { type: "object", properties: { kind: { const: "b" }, shared: { enum: [2] } }, required: ["kind"] },
    ],
  });
  assert.deepEqual(union.required, ["kind"]);
  const unionProperties = union.properties as Record<string, unknown>;
  assert.deepEqual(unionProperties.kind, { enum: ["a", "b"], type: "string" });
  assert.deepEqual(unionProperties.shared, { enum: [1, 2], type: "number" });

  const literal = cleanSchemaForGoogle({
    oneOf: [{ const: "a" }, { enum: ["b"] }, { type: "null" }],
    title: "kind",
  });
  assert.deepEqual(literal, { type: "string", enum: ["a", "b"], title: "kind" });

  const resolved = cleanSchemaForGoogle({
    $defs: { node: { type: "object", properties: { value: { type: "string" } } } },
    properties: { first: { $ref: "#/$defs/node" }, missing: { $ref: "#/definitions/nope" } },
  }) as Record<string, unknown>;
  assert.deepEqual((resolved.properties as Record<string, unknown>).first, {
    type: "object", properties: { value: { type: "string" } },
  });
  assert.deepEqual((resolved.properties as Record<string, unknown>).missing, {});

  const cyclic = cleanSchemaForGoogle({
    $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
    $ref: "#/$defs/node",
  }) as Record<string, unknown>;
  assert.deepEqual((cyclic.properties as Record<string, unknown>).next, {});
});

test("OpenAI Responses stream ignores non-function items and supports item-done completion", () => {
  const state = createOpenAIResponsesStreamState();
  assert.deepEqual(normalizeOpenAIResponsesStreamEvent({ type: "response.output_item.added", item: { type: "message" } }, state), []);
  const added = normalizeOpenAIResponsesStreamEvent({ type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "item-2", call_id: "call-2", name: "lookup" } }, state);
  assert.deepEqual(added.map((event) => event.type), ["message_start", "tool_call_start"]);
  const done = normalizeOpenAIResponsesStreamEvent({ type: "response.output_item.done", item: { type: "function_call", id: "item-2", call_id: "call-2", name: "lookup", arguments: '{"x":1}' } }, state);
  assert.deepEqual(done.map((event) => event.type), ["tool_call_end"]);
  assert.deepEqual((done[0] as { toolCall: { input: unknown } }).toolCall.input, { x: 1 });
});

test("OpenAI Responses stream recovers out-of-order tools and rejects unrecoverable arguments", () => {
  const state = createOpenAIResponsesStreamState();
  const first = normalizeOpenAIResponsesStreamEvent({
    type: "response.function_call_arguments.delta",
    item_id: "late-item",
    call_id: "late-call",
    delta: "{\"ok\":true}",
  }, state);
  assert.deepEqual(first.map((event) => event.type), ["message_start", "tool_call_delta"]);
  const completed = normalizeOpenAIResponsesStreamEvent({
    type: "response.completed",
    response: { id: "response/late" },
  }, state);
  assert.deepEqual(completed.map((event) => event.type), ["tool_call_end", "message_end"]);
  assert.equal((completed.at(-1) as { finishReason: string }).finishReason, "tool_call");

  const invalid = createOpenAIResponsesStreamState();
  normalizeOpenAIResponsesStreamEvent({
    type: "response.output_item.added",
    item: { type: "function_call", id: "bad-item", name: "bad" },
  }, invalid);
  assert.throws(
    () => normalizeOpenAIResponsesStreamEvent({
      type: "response.function_call_arguments.done",
      item_id: "bad-item",
      arguments: "\\",
    }, invalid),
    (error: unknown) => error instanceof ModelProviderError && error.error.code === "invalid_tool_arguments",
  );
  assert.deepEqual(normalizeOpenAIResponsesStreamEvent({ type: "response.unknown" }, invalid), []);
});
