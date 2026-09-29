import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelInvocationProviderRegistry,
  type ModelInvocationProvider,
} from "../../src/model/index.js";
import {
  createNativeRouterProviderHealthPort,
  createRegistryRouterModelInvocationPort,
  createRouterRuntime,
  type RouterProviderHealthInput,
  type RouterProviderHealthPort,
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

test("native health provider isolates session and provider generations", () => {
  const health = createNativeRouterProviderHealthPort();
  const firstGeneration: RouterProviderHealthInput = {
    sessionId: "session-a",
    providerId: "provider",
    providerGeneration: "1",
  };
  for (let index = 0; index < 5; index += 1) health.recordFailure(firstGeneration);

  assert.equal(health.shouldSkip(firstGeneration), true);
  assert.equal(health.shouldSkip({ ...firstGeneration, providerGeneration: "2" }), false);
  assert.equal(health.shouldSkip({ ...firstGeneration, sessionId: "session-b" }), false);

  health.dispose?.();
  assert.equal(health.shouldSkip(firstGeneration), false);
});

test("RouterRuntime delegates circuit observations and teardown to its health provider", async () => {
  const registry = new ModelInvocationProviderRegistry();
  registry.register(provider("primary", async function* () {
    yield {
      type: "error",
      error: {
        provider: "primary",
        protocol: "openai",
        code: "server_error",
        message: "primary unavailable",
        retryable: true,
      },
    };
  }));
  registry.register(provider("backup", async function* () {
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "fallback" };
    yield { type: "message_end", finishReason: "stop" };
  }));

  const failures: RouterProviderHealthInput[] = [];
  const successes: RouterProviderHealthInput[] = [];
  let disposed = false;
  const health: RouterProviderHealthPort = {
    shouldSkip: () => false,
    recordFailure: (input) => failures.push(input),
    recordSuccess: (input) => successes.push(input),
    dispose: () => { disposed = true; },
  };
  const router = createRouterRuntime(config, {
    modelInvoker: createRegistryRouterModelInvocationPort(registry),
    providerHealth: health,
  });

  const events: string[] = [];
  for await (const event of router.execute({
    provider: "primary",
    model: "model",
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
  }, {
    provider: "primary",
    model: "model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }, { sessionId: "health-session", turnId: "health-turn" })) {
    events.push(event.type);
  }

  assert.ok(events.includes("text_delta"));
  assert.deepEqual(failures.map(({ sessionId, providerId }) => ({ sessionId, providerId })), [
    { sessionId: "health-session", providerId: "primary" },
  ]);
  assert.deepEqual(successes.map(({ sessionId, providerId }) => ({ sessionId, providerId })), [
    { sessionId: "health-session", providerId: "backup" },
  ]);

  await router.shutdown();
  assert.equal(disposed, true);
  await registry.dispose();
});

function provider(
  providerId: string,
  stream: ModelInvocationProvider["stream"],
): ModelInvocationProvider {
  return {
    providerId,
    stream,
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text", text: "unused" }],
        finishReason: "stop",
      };
    },
    getCapabilities() {
      return {
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
    },
    getMultimodal() { return { input: ["text"] }; },
    getProviderProtocol() { return "openai"; },
    getProviderBaseUrl() { return `https://${providerId}.invalid`; },
  };
}
