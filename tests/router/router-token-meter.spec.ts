import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
  ModelRuntimeOptions,
} from "../../src/model/index.js";
import {
  createNativeRouterTokenMeter,
  createRouterRuntime,
  type RouterTokenMeter,
  type RouterUsageObserver,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const request: CanonicalModelRequest = {
  provider: "provider",
  model: "model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

const capabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: false,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
};

function runtime(stream: AsyncIterable<CanonicalModelEvent>): ModelRuntime {
  return {
    async *stream() {
      yield* stream;
    },
    async complete() {
      throw new Error("not used");
    },
    getCapabilities() {
      return capabilities;
    },
    getMultimodal() {
      return { input: ["text"] };
    },
    getProviderProtocol() {
      return "openai";
    },
    getProviderBaseUrl() {
      return "https://provider.invalid";
    },
  };
}

function observer(observations: unknown[], disposed: { value: boolean }): RouterUsageObserver {
  return {
    stats: {
      observe() {},
      snapshot() { return {} as never; },
      async flush() {},
      dispose() {},
    },
    getSessionUsage() { return undefined; },
    observeSessionUsage() {},
    observeRequest(value) { observations.push(value); },
    async dispose() { disposed.value = true; },
  };
}

const baseConfig: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "provider/model", provider: "provider", model: "model" } },
  transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  stats: { enabled: false },
};

test("native router token meter preserves canonical token estimates", () => {
  const meter = createNativeRouterTokenMeter();
  assert.equal(meter.estimateInput(request.messages), 1);
  assert.equal(meter.estimateOutput([{ type: "text_delta", text: "hello" }]), 1);
});

test("router uses injected token meter for subagent budget admission", async () => {
  let streamCalls = 0;
  const meter: RouterTokenMeter = {
    estimateInput() { return 9; },
    estimateOutput() { return 0; },
  };
  const model = runtime((async function* () {
    streamCalls += 1;
  })());
  const router = createRouterRuntime({
    ...baseConfig,
    autoOrchestrate: { enabled: true, triggerTiers: [], slimSystemPrompt: false, subagentMaxTokens: 5 },
  }, { modelRuntime: model, tokenMeter: meter });
  const events: CanonicalModelEvent[] = [];
  for await (const event of router.execute({
    provider: "provider", model: "model", scenarioType: "default", isSubagent: true,
    orchestrating: false, resolvedFrom: "scenario", mutations: {},
  }, request, { sessionId: "token-budget", turnId: "turn-budget" })) {
    events.push(event);
  }
  assert.equal(streamCalls, 0);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal((events.at(-1) as { type: "error"; error: { code: string } }).error.code, "subagent_budget_exceeded");
  await router.shutdown();
});

test("router uses injected token meter for success and failure usage fallback", async () => {
  const observations: unknown[] = [];
  const disposed = { value: false };
  let inputCalls = 0;
  let outputCalls = 0;
  const meter: RouterTokenMeter = {
    estimateInput() { inputCalls += 1; return 7; },
    estimateOutput() { outputCalls += 1; return 3; },
    dispose() { disposed.value = true; },
  };
  const successModel = runtime((async function* () {
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "ok" };
    yield { type: "message_end", finishReason: "stop" };
  })());
  const successRouter = createRouterRuntime(baseConfig, {
    modelRuntime: successModel,
    tokenMeter: meter,
    usageObserver: observer(observations, disposed),
  });
  for await (const _event of successRouter.execute({
    provider: "provider", model: "model", scenarioType: "default", isSubagent: false,
    orchestrating: false, resolvedFrom: "scenario", mutations: {},
  }, request, { sessionId: "token-success", turnId: "turn-success" })) {}
  assert.deepEqual((observations.at(-1) as { usage: unknown }).usage, {
    inputTokens: 7, outputTokens: 3, totalTokens: 10,
  });
  await successRouter.shutdown();

  const failureModel = runtime((async function* () {
    yield {
      type: "error",
      error: { provider: "provider", protocol: "openai", code: "server_error", message: "down", retryable: false },
    };
  })());
  const failureRouter = createRouterRuntime(baseConfig, {
    modelRuntime: failureModel,
    tokenMeter: meter,
    usageObserver: observer(observations, disposed),
  });
  for await (const _event of failureRouter.execute({
    provider: "provider", model: "model", scenarioType: "default", isSubagent: false,
    orchestrating: false, resolvedFrom: "scenario", mutations: {},
  }, request, { sessionId: "token-failure", turnId: "turn-failure" })) {}
  assert.deepEqual((observations.at(-1) as { usage: unknown }).usage, {
    inputTokens: 7, outputTokens: 3, totalTokens: 10,
  });
  assert.equal(inputCalls >= 2, true);
  assert.equal(outputCalls >= 2, true);
  await failureRouter.shutdown();
  assert.equal(disposed.value, true);
});
