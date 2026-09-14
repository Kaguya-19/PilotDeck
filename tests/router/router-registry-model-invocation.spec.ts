import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelInvocationProviderRegistry,
  type ModelInvocationProvider,
} from "../../src/model/index.js";
import {
  createRegistryRouterModelInvocationPort,
  createRouterRuntime,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "primary/model", provider: "primary", model: "model" } },
  tokenSaver: {
    enabled: true,
    judge: { id: "judge/model", provider: "judge", model: "model" },
    defaultTier: "simple",
    tiers: {
      simple: { model: { id: "primary/model", provider: "primary", model: "model" } },
    },
    judgeTimeoutMs: 500,
  },
  transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  stats: { enabled: false },
};

function provider(id: string, calls: string[]): ModelInvocationProvider {
  return {
    providerId: id,
    async *stream(request) {
      calls.push(`stream:${request.provider}`);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(request) {
      calls.push(`complete:${request.provider}`);
      return {
        role: "assistant",
        content: [{ type: "text", text: "<tier>simple</tier>" }],
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
    getProviderBaseUrl() { return `https://${id}.invalid`; },
  };
}

test("Router consumes registry-backed primary and judge providers without a whole ModelRuntime", async () => {
  const calls: string[] = [];
  const registry = new ModelInvocationProviderRegistry();
  registry.register(provider("primary", calls));
  registry.register(provider("judge", calls));
  const invocation = createRegistryRouterModelInvocationPort(registry);
  const router = createRouterRuntime(config, { modelInvoker: invocation });

  const decision = await router.decide({
    sessionId: "registry-router",
    isMainAgent: true,
    request: {
      provider: "primary",
      model: "model",
      messages: [{ role: "user", content: [{ type: "text", text: "route this" }] }],
    },
  });
  assert.equal(decision.provider, "primary");
  assert.equal(calls.includes("complete:judge"), true);

  const events = [];
  for await (const event of router.execute(decision, {
    provider: "primary",
    model: "model",
    messages: [{ role: "user", content: [{ type: "text", text: "run" }] }],
  }, { sessionId: "registry-router", turnId: "turn-1" })) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["message_start", "text_delta", "message_end"]);
  assert.equal(calls.includes("stream:primary"), true);

  await router.shutdown();
  const response = await registry.complete({
    provider: "primary",
    model: "model",
    messages: [],
  });
  assert.equal(response.content[0]?.type, "text", "Router shutdown must not dispose composition-owned providers");
  await registry.dispose();
});
