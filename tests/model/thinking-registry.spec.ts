import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelDefinition, ProviderConfig } from "../../src/model/protocol/canonical.js";
import { ModelRequestError } from "../../src/model/protocol/errors.js";
import {
  normalizeThinkingMode,
  resolveThinkingPlan,
  throwIfUnsupportedThinkingPlan,
} from "../../src/model/thinking/registry.js";

const model = (id: string, supportsThinkingExplicit?: boolean): ModelDefinition => ({
  id,
  capabilities: {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: true,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: true,
    maxContextTokens: 100_000,
    maxOutputTokens: 10_000,
    ...(supportsThinkingExplicit === undefined ? {} : { supportsThinkingExplicit }),
  },
  multimodal: { input: ["text"] },
});

const provider = (id: string, protocol: ProviderConfig["protocol"], url = "https://provider.test"): ProviderConfig => ({
  id,
  protocol,
  url,
  apiKey: "test",
  headers: {},
  models: {},
});

test("thinking mode normalization and explicit unsupported plans are deterministic", () => {
  assert.equal(normalizeThinkingMode(), "default");
  assert.equal(normalizeThinkingMode({ enabled: true }), "medium");
  assert.equal(normalizeThinkingMode({ enabled: false }), "default");
  assert.equal(normalizeThinkingMode({ mode: "high" }), "high");
  const unsupported = resolveThinkingPlan({ mode: "high" }, provider("custom", "openai"), model("custom", false));
  assert.equal(unsupported.enabled, false);
  assert.match(unsupported.unsupportedReason ?? "", /does not support thinking/);
  assert.throws(
    () => throwIfUnsupportedThinkingPlan(unsupported, { provider: "custom", model: "custom", messages: [] } as CanonicalModelRequest),
    (error: unknown) => error instanceof ModelRequestError && error.code === "unsupported_thinking",
  );
  assert.doesNotThrow(() => throwIfUnsupportedThinkingPlan({ mode: "default", enabled: false }, { provider: "custom", model: "custom", messages: [] } as CanonicalModelRequest));
});

test("OpenAI thinking plans select model-specific reasoning adapters", () => {
  assert.deepEqual(resolveThinkingPlan(undefined, provider("openai", "openai"), model("gpt-5")), { mode: "default", enabled: false });
  assert.equal(resolveThinkingPlan({ enabled: true }, provider("openai", "openai"), model("gpt-5")).useOpenAIReasoning, true);
  assert.equal(resolveThinkingPlan({ mode: "max" }, provider("openai", "openai"), model("gpt-5.5-pro")).effort, "xhigh");
  assert.equal(resolveThinkingPlan({ mode: "max" }, provider("openai", "openai"), model("gpt-5.5")).effort, "xhigh");
  assert.equal(resolveThinkingPlan({ mode: "max" }, provider("openai", "openai"), model("gpt-5")).effort, "high");
  assert.equal(resolveThinkingPlan({ mode: "max" }, provider("openai", "openai"), model("o3-mini")).effort, "high");
  const gptUnsupported = resolveThinkingPlan({ mode: "medium" }, provider("openai", "openai"), model("gpt-4o"));
  assert.equal(gptUnsupported.enabled, false);
  assert.equal(resolveThinkingPlan({ mode: "off" }, provider("openai", "openai"), model("gpt-5.5")).effort, "none");
  assert.equal(resolveThinkingPlan({ mode: "off" }, provider("openai", "openai"), model("gpt-5")).enabled, false);
  assert.equal(resolveThinkingPlan({ mode: "medium" }, provider("compatible", "openai", "https://proxy.test"), model("custom")).enabled, true);
});

test("Anthropic and Google plans select adaptive, budget and level semantics", () => {
  assert.equal(resolveThinkingPlan({ mode: "off" }, provider("anthropic", "anthropic"), model("claude-test")).enabled, false);
  assert.equal(resolveThinkingPlan({ mode: "high", budgetTokens: 123 }, provider("anthropic", "anthropic"), model("claude-test")).budgetTokens, 123);
  const adaptive = resolveThinkingPlan({ mode: "high" }, provider("anthropic", "anthropic"), model("claude-sonnet-5"));
  assert.equal(adaptive.thinkingType, "adaptive");
  assert.equal(adaptive.useAnthropicOutputEffort, true);
  const gemini3 = resolveThinkingPlan({ mode: "low" }, provider("google", "google"), model("gemini-3-pro"));
  assert.deepEqual({ thinkingLevel: gemini3.thinkingLevel, useGeminiLevel: gemini3.useGeminiLevel }, { thinkingLevel: "low", useGeminiLevel: true });
  assert.equal(resolveThinkingPlan({ mode: "off" }, provider("google", "google"), model("gemini-3-pro")).enabled, false);
  assert.equal(resolveThinkingPlan({ mode: "high" }, provider("google", "google"), model("gemini-2.5-pro")).budgetTokens, 24576);
  assert.equal(resolveThinkingPlan({ mode: "off" }, provider("google", "google"), model("gemini-2.5-pro")).budgetTokens, 0);
  assert.equal(resolveThinkingPlan({ mode: "medium", budgetTokens: 42 }, provider("google", "google"), model("legacy-gemini")).budgetTokens, 42);
});

test("regional providers preserve their protocol-specific thinking behavior", () => {
  assert.equal(resolveThinkingPlan({ mode: "minimal" }, provider("zhipu", "openai"), model("glm-4" )).enabled, false);
  assert.equal(resolveThinkingPlan({ mode: "max" }, provider("zhipu", "openai"), model("glm-5.2")).effort, "max");
  assert.equal(resolveThinkingPlan({ mode: "off" }, provider("qwen", "openai"), model("qwen_thinking" )).preserve, true);
  assert.equal(resolveThinkingPlan({ mode: "medium" }, provider("qwen", "openai", "https://llm-center.ali.modelbest.cn"), model("qwen-plus")).preserve, true);
  assert.equal(resolveThinkingPlan({ mode: "medium" }, provider("qwen", "openai"), model("qwen-plus")).bodyPatch?.enable_thinking, true);
  assert.equal(resolveThinkingPlan({ mode: "off" }, provider("deepseek", "openai"), model("deepseek-chat")).thinkingType, "disabled");
  assert.equal(resolveThinkingPlan({ mode: "max" }, provider("deepseek", "openai"), model("deepseek-reasoner")).effort, "max");
  assert.equal(resolveThinkingPlan({ mode: "medium" }, provider("moonshot", "openai"), model("kimi-k2")).omitTemperature, true);
  assert.equal(resolveThinkingPlan({ mode: "off" }, provider("moonshot", "openai"), model("kimi-k2")).enabled, false);
  assert.equal(resolveThinkingPlan({ mode: "medium" }, provider("minimax", "openai"), model("minimax-text")).splitReasoning, true);
  assert.equal(resolveThinkingPlan(undefined, provider("minimax", "openai"), model("minimax-text")).enabled, false);
  assert.equal(resolveThinkingPlan({ mode: "medium", budgetTokens: 77 }, provider("other", "openai"), model("unknown")).budgetTokens, 77);
});
