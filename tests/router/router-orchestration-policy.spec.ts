import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeRouterOrchestrationPolicy,
  createRouterRuntime,
  type RouterOrchestrationPolicy,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";

const auto = {
  enabled: true,
  triggerTiers: ["complex"],
  slimSystemPrompt: false,
};

test("native orchestration policy preserves trigger and continuation semantics", () => {
  const policy = createNativeRouterOrchestrationPolicy({ autoOrchestrate: auto } as RouterConfig);
  assert.equal(policy.decide({ isMainAgent: true, tier: "simple" }).applied, false);
  const first = policy.decide({ isMainAgent: true, tier: "complex" });
  assert.equal(first.applied, true);
  assert.equal(first.mutations.orchestrationActivated?.continued, false);
  const continued = policy.decide({ isMainAgent: true, tier: "simple", alreadyOrchestrating: true });
  assert.equal(continued.applied, true);
  assert.equal(continued.mutations.orchestrationActivated?.continued, true);
});

test("router consumes an injected orchestration policy and disposes its owner", async () => {
  let calls = 0;
  let disposed = false;
  const policy: RouterOrchestrationPolicy = {
    decide() {
      calls += 1;
      return { applied: true, mutations: { orchestrationActivated: { tier: "fake", continued: false } } };
    },
    dispose() { disposed = true; },
  };
  const runtime: ModelRuntime = {
    async *stream(_request: CanonicalModelRequest) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "message_end", finishReason: "stop" };
    },
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
  const config: RouterConfig = {
    enabled: true,
    scenarios: { default: { id: "provider/model", provider: "provider", model: "model" } },
    autoOrchestrate: auto,
    tokenSaver: {
      enabled: true,
      judge: { id: "judge/model", provider: "judge", model: "model" },
      defaultTier: "complex",
      tiers: { complex: { model: { id: "provider/model", provider: "provider", model: "model" } } },
      judgeTimeoutMs: 500,
    },
    stats: { enabled: false },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  };
  const router = createRouterRuntime(config, {
    modelRuntime: runtime,
    judgeRuntime: {
      async complete() {
        return {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "<tier>complex</tier>" }],
          finishReason: "stop" as const,
        };
      },
    } as unknown as ModelRuntime,
    orchestrationPolicy: policy,
  });
  const decision = await router.decide({
    request: { provider: "provider", model: "model", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
    sessionId: "orch-policy", isMainAgent: true,
  });
  assert.equal(calls, 1);
  assert.equal(decision.orchestrating, true);
  await router.shutdown();
  assert.equal(disposed, true);
});
