import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import {
  createNativeRouterCachePolicy,
  createRouterRuntime,
  type RouterCachePolicy,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const modelRuntime: ModelRuntime = {
  async *stream() {},
  async complete() { throw new Error("not used"); },
  getCapabilities() {
    return {
      supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false,
      supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: true,
      supportsPromptCache: false, maxContextTokens: 8192, maxOutputTokens: 1024,
    };
  },
  getMultimodal() { return { input: ["text"] }; },
  getProviderProtocol() { return "openai"; },
  getProviderBaseUrl() { return "https://provider.invalid"; },
};

test("native cache policy preserves disabled and no-cache fast paths", () => {
  const next = { id: "next/model", provider: "next", model: "model" };
  const disabled = createNativeRouterCachePolicy({ tokenSaver: { enabled: false } } as RouterConfig);
  assert.deepEqual(disabled.select({ current: undefined, next, messages: [], lastUsage: undefined }), { selection: next });
  assert.deepEqual(disabled.select({ current: next, next, messages: [], lastUsage: undefined }), { selection: next });
});

test("native cache policy consumes the token meter provider", () => {
  const policy = createNativeRouterCachePolicy({
    tokenSaver: { cacheAwareSwitching: { enabled: true, minSavingsRatio: 0 } },
    stats: {
      enabled: false,
      modelPricing: {
        "current/model": { input: 1, cacheRead: 0.1 },
        "next/model": { input: 1 },
      },
    },
  } as unknown as RouterConfig, { estimateInput: () => 42 });
  const result = policy.select({
    current: { id: "current/model", provider: "current", model: "model" },
    next: { id: "next/model", provider: "next", model: "model" },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    lastUsage: { inputTokens: 100, cacheReadTokens: 90 },
  });
  assert.equal(result.mutation?.estimatedInputTokens, 42);
});

test("router consumes an injected cache policy during token-saver decision", async () => {
  let calls = 0;
  let disposed = false;
  let seen: { current: unknown; next: unknown } | undefined;
  const cachePolicy: RouterCachePolicy = {
    select(input) {
      calls += 1;
      seen = { current: input.current, next: input.next };
      return {
        selection: { id: "cached/model", provider: "cached", model: "model" },
        mutation: {
          action: "kept_sticky",
          from: "judge/model",
          to: "cached/model",
          cachedCost: 1,
          prefillCost: 2,
          estimatedInputTokens: 3,
        },
      };
    },
    dispose() { disposed = true; },
  };
  const config: RouterConfig = {
    enabled: true,
    scenarios: { default: { id: "primary/model", provider: "primary", model: "model" } },
    tokenSaver: {
      enabled: true,
      judge: { id: "judge/model", provider: "judge", model: "model" },
      defaultTier: "medium",
      tiers: { medium: { model: { id: "next/model", provider: "next", model: "model" } } },
      judgeTimeoutMs: 500,
      subagent: { policy: "skip" },
    },
    stats: { enabled: false },
  };
  const judgeRuntime = {
    async complete(_request: CanonicalModelRequest) {
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "<tier>medium</tier>" }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;
  const router = createRouterRuntime(config, {
    modelRuntime,
    judgeRuntime,
    cachePolicy,
  });
  const decision = await router.decide({
    request: {
      provider: "primary",
      model: "model",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    },
    sessionId: "cache-policy",
    isMainAgent: true,
  });
  assert.equal(calls, 1);
  assert.equal(seen?.current, undefined);
  assert.equal(seen?.next && (seen.next as { provider: string }).provider, "next");
  assert.equal(decision.provider, "cached");
  assert.equal(decision.mutations.cacheAwareSwitch?.action, "kept_sticky");
  await router.shutdown();
  assert.equal(disposed, true);
});
