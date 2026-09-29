import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime, ModelRuntimeOptions } from "../../src/model/index.js";
import {
  createNativeRouterFallbackPolicy,
  createRouterRuntime,
  type RouterFallbackPolicy,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "primary/model", provider: "primary", model: "model" } },
  fallback: {
    default: [{ id: "backup/model", provider: "backup", model: "model" }],
    maxFallbacks: 1,
  },
  transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  stats: { enabled: false },
};

test("native fallback policy owns config planning, candidate visibility, and eligibility", () => {
  const policy = createNativeRouterFallbackPolicy(config);
  assert.deepEqual(policy.plan("default").attempts, [
    { id: "backup/model", provider: "backup", model: "model" },
  ]);
  assert.deepEqual(policy.candidates("default"), [
    { id: "backup/model", provider: "backup", model: "model" },
  ]);
  assert.equal(policy.isEligible({
    provider: "primary", protocol: "openai", code: "server_error", message: "down", retryable: true,
  }), true);
});

test("router consumes an injected fallback policy for attempt planning and admission", async () => {
  const calls: string[] = [];
  let planCalls = 0;
  let eligibilityCalls = 0;
  let disposed = false;
  const policy: RouterFallbackPolicy = {
    plan() {
      planCalls += 1;
      return { attempts: [{ id: "backup/model", provider: "backup", model: "model" }] };
    },
    candidates() { return []; },
    isEligible() {
      eligibilityCalls += 1;
      return true;
    },
    dispose() { disposed = true; },
  };
  const model: ModelRuntime = {
    async *stream(request: CanonicalModelRequest, _options?: ModelRuntimeOptions) {
      calls.push(request.provider);
      if (request.provider === "primary") {
        yield {
          type: "error",
          error: { provider: "primary", protocol: "openai", code: "server_error", message: "down", retryable: true },
        };
        return;
      }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "backup ok" };
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
    getProviderBaseUrl(provider: string) { return `https://${provider}.invalid`; },
  };
  const router = createRouterRuntime(config, { modelRuntime: model, fallbackPolicy: policy });
  const events = [];
  for await (const event of router.execute({
    provider: "primary", model: "model", scenarioType: "default", isSubagent: false,
    orchestrating: false, resolvedFrom: "scenario", mutations: {},
  }, {
    provider: "primary", model: "model", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }, { sessionId: "fallback-policy", turnId: "turn-1" })) {
    events.push(event);
  }
  assert.deepEqual(calls, ["primary", "backup"]);
  assert.equal(planCalls, 1);
  assert.equal(eligibilityCalls, 1);
  assert.equal(events.at(-1)?.type, "message_end");
  await router.shutdown();
  assert.equal(disposed, true);
});
