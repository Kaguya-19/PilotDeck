import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import {
  createNativeRouterRequestMaterializer,
  createRouterRuntime,
  type RouterRequestMaterializer,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "provider/model", provider: "provider", model: "model" } },
  transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  stats: { enabled: false },
};

const capabilities = {
  supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false,
  supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: true,
  supportsPromptCache: false, maxContextTokens: 8192, maxOutputTokens: 128,
};

function model(onRequest?: (request: CanonicalModelRequest) => void): ModelRuntime {
  return {
    async *stream(request) {
      onRequest?.(request);
      yield { type: "message_start", role: "assistant" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() { throw new Error("not used"); },
    getCapabilities() { return capabilities; },
    getMultimodal() { return { input: ["text"] }; },
    getProviderProtocol() { return "openai"; },
    getProviderBaseUrl() { return "https://provider.invalid"; },
  };
}

const request: CanonicalModelRequest = {
  provider: "provider",
  model: "model",
  maxOutputTokens: 256,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  cachePlan: {
    provider: "provider", model: "model", system: true, tools: false,
    messages: [0], fingerprint: "fingerprint", generation: 1,
  },
  cacheBreakpoints: [0],
};

const decision = {
  provider: "provider", model: "model", scenarioType: "default" as const, isSubagent: false,
  orchestrating: false, resolvedFrom: "scenario" as const, mutations: {},
};

test("native request materializer preserves cache semantics and model output cap", () => {
  const materializer = createNativeRouterRequestMaterializer(model());
  const materialized = materializer.materialize(decision, request);
  assert.equal(materialized.maxOutputTokens, 128);
  assert.deepEqual(materialized.cachePlan, request.cachePlan);
  assert.deepEqual(materialized.cacheBreakpoints, [0]);

  const tagged = materializer.materialize({
    ...decision,
    mutations: { subagentTagStripped: true },
  }, {
    ...request,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "<pilotdeck-subagent-model>backup/model</pilotdeck-subagent-model> do this" }],
    }],
  });
  assert.equal((tagged.messages[0]?.content[0] as { type: "text"; text: string }).text, " do this");
});

test("router consumes an injected request materializer and disposes its owner", async () => {
  let calls = 0;
  let disposed = false;
  let dispatched: CanonicalModelRequest | undefined;
  const materializer: RouterRequestMaterializer = {
    materialize(_decision, input) {
      calls += 1;
      return { ...input, metadata: { materializedBy: "fake" } };
    },
    dispose() { disposed = true; },
  };
  const router = createRouterRuntime(config, {
    modelRuntime: model((next) => { dispatched = next; }),
    requestMaterializer: materializer,
  });
  assert.equal(router.materializeRequest(decision, request).metadata?.materializedBy, "fake");
  for await (const _event of router.execute(decision, request, { sessionId: "materializer", turnId: "turn-1" })) {}
  assert.equal(calls >= 2, true);
  assert.equal(dispatched?.metadata?.materializedBy, "fake");
  await router.shutdown();
  assert.equal(disposed, true);
});
