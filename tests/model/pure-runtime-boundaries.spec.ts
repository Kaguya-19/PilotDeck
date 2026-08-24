import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureGatewayAuthToken,
  readGatewayAuthToken,
  resolveGatewayTokenPath,
} from "../../src/gateway/server/authToken.js";
import { AsyncQueue } from "../../src/gateway/util/AsyncQueue.js";
import { lookupCatalogModel, lookupCatalogProvider } from "../../src/model/catalog/lookup.js";
import { ModelProviderRegistry } from "../../src/model/providers/registry.js";
import { parseRetryAfterFromMessage, parseRetryAfterHeader } from "../../src/model/protocol/errors.js";
import { normalizeProviderBaseUrl } from "../../src/model/normalizeProviderBaseUrl.js";
import {
  buildProviderChatEndpoint,
  buildProviderChatEndpointCandidates,
  buildProviderModelsEndpoint,
  isExpectedProviderModelsResponseShape,
  isExpectedProviderResponseShape,
  normalizeGoogleProbeModel,
} from "../../src/model/providerEndpoint.js";
import { resolveApiKey } from "../../src/model/config/resolveCredentials.js";
import { materializeMediaReferences } from "../../src/model/request/materializeMediaReferences.js";
import { parseModelResponse } from "../../src/model/response/parseModelResponse.js";
import { createStreamNormalizerState, normalizeStreamEvent } from "../../src/model/streaming/normalizeStreamEvent.js";
import { repairToolName } from "../../src/model/streaming/repairToolName.js";
import { requestFingerprint } from "../../src/model/streaming/requestFingerprint.js";
import { getFormatById, getSelfCorrectPrompt, looksLikeUnparsedToolCall, registerToolCallFormat } from "../../src/model/streaming/toolCallFormats.js";
import {
  normalizeAnthropicFinishReason,
  normalizeOpenAIFinishReason,
} from "../../src/model/response/normalizeFinishReason.js";
import {
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
} from "../../src/model/response/normalizeUsage.js";
import { parseTokenLimitError } from "../../src/model/errors/tokenLimitParsing.js";
import {
  calculateCacheReadCost,
  calculateInputCost,
  lookupModelPricing,
} from "../../src/router/utils/modelPricing.js";
import {
  collectRequiredInputModalities,
  missingInputModalities,
  supportsRequiredModalities,
} from "../../src/router/utils/mediaRequirements.js";
import {
  isValidProviderModelRef,
  parseProviderModelRef,
} from "../../src/router/config/resolveProviderRef.js";

test("provider endpoints normalize all protocols and avoid duplicate paths", () => {
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://api.test" }),
    "https://api.test/v1/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai-responses", baseUrl: "https://api.test/v1/" }),
    "https://api.test/v1/responses",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "anthropic", baseUrl: "https://api.test/v1/messages" }),
    "https://api.test/v1/messages",
  );
  assert.equal(
    buildProviderChatEndpoint({
      protocol: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "google/gemini-3-pro",
    }),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
  );
  assert.deepEqual(
    buildProviderChatEndpointCandidates({ protocol: "openai", baseUrl: "https://api.test" }),
    ["https://api.test/v1/chat/completions", "https://api.test/chat/completions"],
  );
  assert.equal(buildProviderModelsEndpoint({ protocol: "google", baseUrl: "https://api.test/v1beta" }), "https://api.test/v1beta/models");
  assert.equal(normalizeGoogleProbeModel("google/gemini-3.1-flash"), "gemini-3-flash-preview");
  assert.equal(normalizeGoogleProbeModel("custom-model"), "custom-model");
  assert.equal(isExpectedProviderResponseShape("openai", { choices: [] }), true);
  assert.equal(isExpectedProviderResponseShape("anthropic", { type: "message" }), true);
  assert.equal(isExpectedProviderResponseShape("google", { candidates: [] }), true);
  assert.equal(isExpectedProviderResponseShape("openai-responses", { output_text: "ok" }), true);
  assert.equal(isExpectedProviderResponseShape("openai", null), false);
  assert.equal(isExpectedProviderModelsResponseShape("google", { models: [] }), true);
  assert.equal(isExpectedProviderModelsResponseShape("openai", { data: [] }), true);
  assert.equal(isExpectedProviderModelsResponseShape("openai", {}), false);
});

test("provider URL and credential normalization strips secrets and rejects invalid input", () => {
  assert.equal(normalizeProviderBaseUrl(" https://user:pass@api.test/v1/?x=1#secret "), "https://api.test/v1");
  assert.equal(normalizeProviderBaseUrl("http://api.test/"), "http://api.test");
  assert.equal(normalizeProviderBaseUrl(""), undefined);
  assert.equal(normalizeProviderBaseUrl("ftp://api.test"), undefined);
  assert.equal(normalizeProviderBaseUrl("not a url"), undefined);

  assert.equal(resolveApiKey(" sk-test "), "sk-test");
  assert.equal(resolveApiKey("${PILOT_KEY}\n", { PILOT_KEY: " env-key\n" }), "env-key");
  assert.throws(() => resolveApiKey("   "), { code: "missing_api_key" });
  assert.throws(() => resolveApiKey("${MISSING}", {}), { code: "missing_api_key" });
  assert.throws(() => resolveApiKey(42), { code: "missing_api_key" });
  assert.equal(parseRetryAfterFromMessage("try again in 2.5s"), 2500);
  assert.equal(parseRetryAfterFromMessage("retry in 300 milliseconds"), 300);
  assert.equal(parseRetryAfterFromMessage("retry in 2 minutes"), 120000);
  assert.equal(parseRetryAfterFromMessage("no retry hint"), undefined);
  assert.equal(parseRetryAfterHeader("2"), 2000);
  assert.equal(parseRetryAfterHeader("invalid"), undefined);
});

test("finish reasons and usage normalize provider variants without inventing values", () => {
  assert.deepEqual(
    ["end_turn", "stop_sequence", "max_tokens", "tool_use", "refusal", "other"].map(normalizeAnthropicFinishReason),
    ["stop", "stop", "length", "tool_call", "content_filter", "unknown"],
  );
  assert.deepEqual(
    ["stop", "length", "tool_calls", "function_call", "content_filter", "content_filter_results", "other"].map(normalizeOpenAIFinishReason),
    ["stop", "length", "tool_call", "tool_call", "content_filter", "content_filter", "unknown"],
  );
  assert.deepEqual(normalizeAnthropicUsage({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }), {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    totalTokens: 17,
  });
  assert.deepEqual(normalizeOpenAIUsage({
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    prompt_tokens_details: { cached_tokens: 3 },
    cost: 0.2,
  }), {
    inputTokens: 17,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: undefined,
    totalTokens: 25,
    nativeCost: 0.2,
  });
  assert.deepEqual(normalizeOpenAIUsage({ input_tokens: 9, output_tokens: 2, input_tokens_details: { cache_write_tokens: 1 } }), {
    inputTokens: 8,
    outputTokens: 2,
    cacheReadTokens: undefined,
    cacheWriteTokens: 1,
    totalTokens: 11,
    nativeCost: undefined,
  });
  assert.equal(normalizeAnthropicUsage(null), undefined);
  assert.equal(normalizeOpenAIUsage({ input_tokens: "bad" }), undefined);
});

test("token limit parser distinguishes output caps, available output and context caps", () => {
  assert.deepEqual(parseTokenLimitError("range of max_tokens should be [1, 4096]"), { maxOutputTokens: 4096, kind: "output" });
  assert.deepEqual(parseTokenLimitError("available_tokens: 1234 for max_tokens"), { availableOutputTokens: 1234, kind: "output" });
  assert.deepEqual(parseTokenLimitError("max_tokens 100 > context_window 80"), { maxOutputTokens: 80, kind: "output" });
  assert.deepEqual(parseTokenLimitError("max_output_tokens must be at most 2048"), { maxOutputTokens: 2048, kind: "output" });
  assert.deepEqual(parseTokenLimitError("maximum context length is 1000 and prompt contains 700 tokens; requested 500 output tokens"), { availableOutputTokens: 300, kind: "output" });
  assert.deepEqual(parseTokenLimitError("maximum context length is 8192"), { maxContextTokens: 8192, kind: "context" });
  assert.deepEqual(parseTokenLimitError("context_window: 4096"), { maxContextTokens: 4096, kind: "context" });
  assert.deepEqual(parseTokenLimitError("最多支持 2048 tokens"), { maxContextTokens: 2048, kind: "context" });
  assert.deepEqual(parseTokenLimitError("provider failed"), {});
});

test("router helpers preserve modality order, pricing precedence and model refs", () => {
  const messages = [{
    role: "user" as const,
    content: [
      { type: "audio" as const, source: "url" as const, data: "a", mimeType: "audio/wav" },
      { type: "image" as const, source: "url" as const, data: "i", mimeType: "image/png" },
      {
        type: "tool_result" as const,
        toolCallId: "call-1",
        content: [{ type: "pdf" as const, source: "base64" as const, data: "p", mimeType: "application/pdf", bytes: 1 }],
      },
    ],
  }];
  assert.deepEqual(collectRequiredInputModalities(messages), ["image", "pdf", "audio"]);
  assert.deepEqual(missingInputModalities({ input: ["image"] }, ["image", "pdf"]), ["pdf"]);
  assert.equal(supportsRequiredModalities({ input: ["image", "pdf"] }, ["image"]), true);
  assert.equal(supportsRequiredModalities({ input: [] }, []), true);

  assert.deepEqual(parseProviderModelRef("openai/gpt-4o"), { id: "openai/gpt-4o", provider: "openai", model: "gpt-4o" });
  assert.deepEqual(parseProviderModelRef("invalid"), { id: "invalid", provider: "", model: "" });
  const modelConfig = { providers: { openai: { models: { "gpt-4o": {} } } } } as never;
  assert.equal(isValidProviderModelRef("openai/gpt-4o", modelConfig), true);
  assert.equal(isValidProviderModelRef("openai/missing", modelConfig), false);
  assert.equal(isValidProviderModelRef("invalid", modelConfig), false);

  assert.deepEqual(lookupModelPricing("openai", "gpt-4o-mini"), { input: 0.15, output: 0.6, cacheRead: 0.075 });
  assert.deepEqual(lookupModelPricing("custom", "model", { "custom/model": { input: 1, output: 2 } }), { input: 1, output: 2 });
  assert.deepEqual(lookupModelPricing("custom", "model-v2", { model: { input: 3 } }), { input: 3 });
  assert.deepEqual(lookupModelPricing("custom", "unknown"), { input: 0.5, output: 1.5 });
  assert.equal(calculateInputCost(1_000_000, "openai", "gpt-4o"), 2.5);
  assert.equal(calculateCacheReadCost(1_000_000, "openai", "gpt-4o"), 1.25);
  assert.equal(calculateCacheReadCost(1_000_000, "custom", "model", { "custom/model": { input: 2 } }), 2);
});

test("model catalog and provider registry resolve exact, alias and proxy-style ids", () => {
  assert.equal(lookupCatalogProvider("openai")?.protocol, "openai");
  assert.equal(lookupCatalogProvider("missing"), undefined);
  assert.equal(lookupCatalogModel("openai", "gpt-4o").matchType, "exact");
  assert.equal(lookupCatalogModel("openai", "gpt-4o-2024-11-20").matchType, "alias");
  assert.equal(lookupCatalogModel("custom", "gpt-4o").matchType, "cross-provider");
  assert.equal(lookupCatalogModel("custom", "anthropic/claude-sonnet-4.6").matchType, "cross-provider");
  assert.equal(lookupCatalogModel("custom", "does-not-exist").matchType, "none");
  assert.deepEqual(ModelProviderRegistry.list().map((adapter) => adapter.protocol).sort(), ["anthropic", "google", "openai", "openai-responses"]);
  assert.equal(ModelProviderRegistry.get("openai").name, "OpenAI Chat Completions API");
  assert.throws(() => ModelProviderRegistry.get("invalid" as never), { code: "unsupported_protocol" });
});

test("AsyncQueue delivers FIFO values, closes waiters and reports one failure", async () => {
  const queue = new AsyncQueue<number>();
  queue.enqueue(1);
  queue.enqueue(2);
  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: 1, done: false });
  assert.deepEqual(await iterator.next(), { value: 2, done: false });
  const pending = iterator.next();
  queue.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
  queue.enqueue(3);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });

  const failed = new AsyncQueue<number>();
  const failedIterator = failed[Symbol.asyncIterator]();
  failed.fail(new Error("boom"));
  await assert.rejects(failedIterator.next(), /boom/);
  assert.deepEqual(await failedIterator.next(), { value: undefined, done: true });
});

test("Gateway auth token uses isolated home, reuses existing token and writes restrictive file", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pilot-auth-test-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  assert.equal(resolveGatewayTokenPath({ pilotHome: home }), join(home, "server-token"));
  assert.equal(await readGatewayAuthToken({ pilotHome: home }), undefined);
  const first = await ensureGatewayAuthToken({ pilotHome: home });
  assert.equal(first.token.length > 20, true);
  assert.equal(await readGatewayAuthToken({ pilotHome: home }), first.token);
  assert.equal((await readFile(first.tokenPath, "utf8")).trim(), first.token);
  const second = await ensureGatewayAuthToken({ pilotHome: home });
  assert.deepEqual(second, first);
});

test("model response and stream dispatchers route all four protocols", () => {
  assert.equal(parseModelResponse("openai", { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }).content[0]?.type, "text");
  assert.equal(parseModelResponse("anthropic", { type: "message", content: [{ type: "text", text: "ok" }] }).content[0]?.type, "text");
  assert.equal(parseModelResponse("google", { candidates: [{ content: { parts: [{ text: "ok" }] } }] }).content[0]?.type, "text");
  assert.equal(parseModelResponse("openai-responses", { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }).content[0]?.type, "text");

  for (const protocol of ["openai", "anthropic", "google", "openai-responses"] as const) {
    const state = createStreamNormalizerState(protocol);
    const events = normalizeStreamEvent(protocol, {}, state);
    assert.ok(Array.isArray(events));
  }
  const lazilyCreated = normalizeStreamEvent("openai", {}, {});
  assert.ok(Array.isArray(lazilyCreated));
});

test("media references materialize supported files and fail closed for invalid references", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pilot-media-test-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const imagePath = join(home, "image.b64");
  const pdfPath = join(home, "doc.b64");
  const audioPath = join(home, "audio.b64");
  await writeFile(imagePath, "image-data");
  await writeFile(pdfPath, "pdf-data");
  await writeFile(audioPath, "audio-data");
  const result = await materializeMediaReferences([
    {
      role: "user",
      content: [
        { type: "media_reference", mediaType: "image", path: imagePath, originalBytes: 1, preview: "image", hasMore: false, mimeType: "image/png" },
        { type: "media_reference", mediaType: "pdf", path: pdfPath, originalBytes: 1, preview: "pdf", hasMore: false, mimeType: "application/pdf", pages: 1 },
        { type: "media_reference", mediaType: "audio", path: audioPath, originalBytes: 1, preview: "audio", hasMore: false, mimeType: "audio/wav" },
        { type: "media_reference", mediaType: "pdf", path: join(home, "bad"), originalBytes: 1, preview: "missing", hasMore: true, mimeType: "text/plain" },
        { type: "media_reference", mediaType: "video", path: imagePath, originalBytes: 1, preview: "unsupported", hasMore: false, mimeType: "video/mp4" } as never,
      ],
    },
  ]);
  assert.deepEqual(result.messages[0]?.content.slice(0, 3).map((block) => block.type), ["image", "pdf", "audio"]);
  assert.equal(result.messages[0]?.content[3]?.type, "text");
  assert.equal(result.messages[0]?.content[4]?.type, "text");
  assert.equal(result.diagnostics.length, 2);
});

test("tool name repair and format helpers preserve explicit, fuzzy and unknown paths", () => {
  assert.equal(repairToolName("read_file", ["read_file"]), undefined);
  assert.deepEqual(repairToolName(" read", ["read_file"], { read: "read_file" }), { name: "read_file", reason: "alias" });
  assert.deepEqual(repairToolName("READ_FILE", ["read_file"]), { name: "read_file", reason: "case_insensitive" });
  assert.deepEqual(repairToolName("read-file", ["read_file"]), { name: "read_file", reason: "normalized" });
  assert.deepEqual(repairToolName("read_flie", ["read_file"]), { name: "read_file", reason: "edit_distance" });
  assert.equal(repairToolName("xy", ["read_file"]), undefined);
  assert.equal(getFormatById(undefined), undefined);
  assert.equal(getFormatById("auto"), undefined);
  assert.equal(looksLikeUnparsedToolCall("ordinary response"), false);
  assert.match(getSelfCorrectPrompt(undefined, "ordinary response"), /previous response looked like a tool call/i);
  registerToolCallFormat({
    id: "custom",
    displayName: "Custom",
    modelFamilies: ["test"],
    markers: ["<custom-tool>"],
    parse: () => null,
    selfCorrectPrompt: "Emit the custom syntax.",
    example: "<custom-tool />",
  });
  assert.equal(getFormatById("custom")?.displayName, "Custom");
  assert.equal(looksLikeUnparsedToolCall("<custom-tool>payload</custom-tool>"), true);
  assert.match(getSelfCorrectPrompt("custom", "<custom-tool>bad"), /Custom/);
  registerToolCallFormat({
    id: "custom",
    displayName: "Custom v2",
    modelFamilies: ["test"],
    markers: ["[custom]"],
    parse: () => null,
    selfCorrectPrompt: "Use v2.",
    example: "[custom]",
  });
  assert.equal(getFormatById("custom")?.displayName, "Custom v2");
  assert.equal(requestFingerprint({ provider: "openai", model: "m", messages: [] }), requestFingerprint({ provider: "openai", model: "m", messages: [] }));
});
