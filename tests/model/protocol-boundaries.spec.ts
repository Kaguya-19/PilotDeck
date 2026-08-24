import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneContentBlock,
  cloneMessage,
  cloneMessages,
} from "../../src/model/protocol/clone.js";
import {
  assertContentSupported,
  contentBlockToInputModality,
  downgradeUnsupportedContent,
} from "../../src/model/protocol/multimodal.js";
import { toolResultContentBlockToText, flattenToolResultBlockText } from "../../src/model/protocol/toolResultContent.js";
import { ModelRequestError } from "../../src/model/protocol/errors.js";
import { validateModelRequest } from "../../src/model/request/validateModelRequest.js";
import type { CanonicalMessage, CanonicalModelRequest, ModelConfig } from "../../src/model/protocol/canonical.js";
import { StreamingCheckpointManager } from "../../src/model/streaming/StreamingCheckpoint.js";
import { buildLiteLLMContinuationRequest, stripLiteLLMContinuationMessages } from "../../src/model/streaming/continuationRequest.js";
import { extractStructuredOutput } from "../../src/model/structuredOutput/extractStructuredOutput.js";

test("model cloning isolates nested tool inputs and tool result content", () => {
  const message: CanonicalMessage = {
    role: "assistant",
    content: [
      { type: "tool_call", id: "call", name: "lookup", input: { nested: { value: 1 } } },
      { type: "tool_result", toolCallId: "call", content: [{ type: "text", text: "result" }] },
      { type: "text", text: "raw", },
    ],
  };
  const cloned = cloneMessage(message);
  assert.notEqual(cloned, message);
  const call = cloned.content[0] as { type: "tool_call"; input: { nested: { value: number } } };
  call.input.nested.value = 2;
  const result = cloned.content[1] as { type: "tool_result"; content: Array<{ type: "text"; text: string }> };
  result.content[0]!.text = "changed";
  assert.equal((message.content[0] as { input: { nested: { value: number } } }).input.nested.value, 1);
  assert.equal((message.content[1] as { content: Array<{ text: string }> }).content[0]!.text, "result");
  assert.deepEqual(cloneMessages([message]).length, 1);
  assert.equal((cloneContentBlock({ type: "text", text: "x" })).type, "text");
});

test("multimodal downgrade and validation enforce modality, size and count limits", () => {
  const messages: CanonicalMessage[] = [{ role: "user", content: [
    { type: "image", source: "base64", data: "x", mimeType: "image/png", bytes: 2048 },
    { type: "pdf", source: "base64", data: "p", mimeType: "application/pdf", bytes: 4096, pages: 2 },
    { type: "audio", source: "base64", data: "a", mimeType: "audio/wav", durationSeconds: 20 },
    { type: "tool_result", toolCallId: "t", content: [{ type: "image", source: "base64", data: "x", mimeType: "image/png" }] },
  ] }];
  downgradeUnsupportedContent(messages, { input: ["text"] });
  assert.equal(messages[0]!.content.some((block) => block.type === "image" || block.type === "pdf" || block.type === "audio"), false);
  const downgradedToolResult = messages[0]!.content.find((block) => block.type === "tool_result");
  assert.equal(downgradedToolResult?.type, "tool_result");
  if (downgradedToolResult?.type === "tool_result") {
    assert.equal(downgradedToolResult.content.every((block) => block.type === "text"), true);
  }
  assert.equal(contentBlockToInputModality({ type: "tool_call", id: "x", name: "x", input: {} }), undefined);
  assert.throws(() => assertContentSupported([{ type: "image", source: "base64", data: "x", mimeType: "image/png", bytes: 10 }], { input: ["image"], maxImageBytes: 1 }), (error: unknown) => error instanceof ModelRequestError && error.code === "image_too_large");
  assert.throws(() => assertContentSupported([{ type: "image", source: "base64", data: "x", mimeType: "image/png" }, { type: "image", source: "base64", data: "x", mimeType: "image/png" }], { input: ["image"], maxImagesPerRequest: 1 }), (error: unknown) => error instanceof ModelRequestError && error.code === "too_many_images");
  assert.throws(() => assertContentSupported([{ type: "tool_result", toolCallId: "pdf", content: [{ type: "pdf", source: "base64", data: "p", mimeType: "application/pdf", bytes: 4 }] }], { input: ["pdf"], maxPdfBytes: 1 }), (error: unknown) => error instanceof ModelRequestError && error.code === "pdf_too_large");
  assert.throws(() => assertContentSupported([{ type: "tool_result", toolCallId: "mime", content: [{ type: "image", source: "base64", data: "x", mimeType: "image/jpeg" }] }], { input: ["image"], supportedImageMimeTypes: ["image/png"] }), (error: unknown) => error instanceof ModelRequestError && error.code === "unsupported_image_mime_type");
  assert.throws(() => assertContentSupported([{ type: "image", source: "base64", data: "x", mimeType: "image/jpeg" }], { input: ["image"], supportedImageMimeTypes: ["image/png"] }), (error: unknown) => error instanceof ModelRequestError && error.code === "unsupported_image_mime_type");
  assert.throws(() => assertContentSupported([{ type: "pdf", source: "base64", data: "p", mimeType: "application/pdf", bytes: 4 }], { input: ["pdf"], maxPdfBytes: 1 }), (error: unknown) => error instanceof ModelRequestError && error.code === "pdf_too_large");
  assert.throws(() => assertContentSupported([{ type: "audio", source: "base64", data: "a", mimeType: "audio/wav", durationSeconds: 5 }], { input: ["audio"], maxAudioSeconds: 1 }), (error: unknown) => error instanceof ModelRequestError && error.code === "audio_too_long");
});

test("tool result formatting and structured output extraction fail closed", () => {
  assert.equal(toolResultContentBlockToText({ type: "text", text: "hello" }), "hello");
  assert.match(toolResultContentBlockToText({ type: "image", source: "url", data: "https://image.test/a", mimeType: "image/png" }), /https:\/\/image/);
  assert.match(toolResultContentBlockToText({ type: "image", source: "base64", data: "abcd", mimeType: "image/png" }), /4 base64/);
  assert.match(flattenToolResultBlockText({ type: "tool_result", toolCallId: "x", content: [{ type: "pdf", source: "base64", data: "abc", mimeType: "application/pdf", pages: 2 }] }), /2 pages/);

  const base = { role: "assistant" as const, finishReason: "stop" as const };
  assert.deepEqual(extractStructuredOutput({ ...base, content: [] }), { ok: false, reason: "no_payload" });
  assert.deepEqual(extractStructuredOutput({ ...base, content: [{ type: "text", text: "not-json" }] }), { ok: false, reason: "invalid_json" });
  assert.deepEqual(extractStructuredOutput({ ...base, content: [{ type: "text", text: "{\"ok\":true}" }] }, { validate: () => false }), { ok: false, reason: "schema_mismatch" });
  assert.deepEqual(extractStructuredOutput({ ...base, content: [{ type: "text", text: "{\"ok\":" }, { type: "text", text: "true}" }] }), { ok: true, value: { ok: true } });
  const tool = { type: "tool_call" as const, id: "x", name: "__output__", input: { value: 1 } };
  assert.deepEqual(extractStructuredOutput({ ...base, content: [tool] }, { validate: (value) => (value as { value: number }).value === 1 }), { ok: true, value: { value: 1 } });
  assert.deepEqual(extractStructuredOutput({ ...base, content: [tool, { ...tool, id: "y" }] }), { ok: false, reason: "multiple_payloads" });
});

test("streaming checkpoint and LiteLLM continuation are deterministic and idempotent", () => {
  const manager = new StreamingCheckpointManager();
  assert.equal(manager.hasSubstantialContent(), false);
  manager.onEvent({ type: "thinking_delta", text: "think" });
  manager.onEvent({ type: "text_delta", text: " hello " });
  manager.onEvent({ type: "tool_call_start", id: "x", name: "lookup" });
  manager.onEvent({ type: "tool_call_delta", id: "x", delta: "{}" });
  manager.onEvent({ type: "tool_call_end", toolCall: { id: "x", name: "lookup", input: {} } });
  assert.deepEqual(manager.get(), { partialText: " hello ", tokensReceived: 5, hasToolCalls: true });
  assert.equal(manager.hasSubstantialContent(), true);
  manager.reset();
  assert.deepEqual(manager.get(), { partialText: "", tokensReceived: 0, hasToolCalls: false });

  const original: CanonicalModelRequest = { provider: "openai", model: "model", messages: [{ role: "user", content: [{ type: "text", text: "question" }] }], stream: true };
  const continuation = buildLiteLLMContinuationRequest(original, "partial");
  assert.equal(continuation.messages.at(-2)?.role, "assistant");
  assert.equal(stripLiteLLMContinuationMessages(continuation.messages).length, original.messages.length);
  assert.equal(stripLiteLLMContinuationMessages(original.messages).length, 1);
});

test("validateModelRequest reports provider, capability and content errors", () => {
  const config = {
    providers: {
      p: {
        id: "p", protocol: "openai", url: "https://example.test", apiKey: "x", headers: {},
        models: { m: { id: "m", capabilities: { supportsStreaming: false, supportsSystemPrompt: false, supportsToolUse: false, supportsParallelToolCalls: false, supportsThinking: false, supportsJsonSchema: false, supportsPromptCache: false, maxContextTokens: 100, maxOutputTokens: 10 }, multimodal: { input: ["text"] } } },
      },
    },
  } as unknown as ModelConfig;
  const base = { provider: "p", model: "m", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }] };
  assert.throws(() => validateModelRequest({ ...base, stream: true }, config), /streaming/);
  assert.throws(() => validateModelRequest({ ...base, systemPrompt: "system" }, config), /system prompts/);
  assert.throws(() => validateModelRequest({ ...base, tools: [{ name: "t", inputSchema: {} }] }, config), /tools/);
  assert.throws(() => validateModelRequest({ ...base, provider: "missing" }, config), /does not exist/);
  assert.throws(() => validateModelRequest({ ...base, model: "missing" }, config), /does not exist/);
});
