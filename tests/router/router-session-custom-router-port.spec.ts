import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRuntime } from "../../src/model/index.js";
import {
  createNativeRouterSessionCustomRouterPort,
  createRouterRuntime,
  type PilotDeckCustomRouter,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "primary/model", provider: "primary", model: "model" } },
  customRouter: { extensionId: "session-router" },
  stats: { enabled: false },
};

const modelRuntime: ModelRuntime = {
  async *stream() {},
  async complete() { return { role: "assistant", content: [], finishReason: "stop" }; },
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
  getProviderProtocol() { return "openai" as const; },
  getProviderBaseUrl() { return "https://provider.invalid"; },
};

test("session custom-router registry isolates sessions and ignores a stale replacement release", () => {
  const registry = createNativeRouterSessionCustomRouterPort();
  const oldRouter = customRouter("session-router", "old");
  const replacementRouter = customRouter("session-router", "replacement");

  const oldRegistration = registry.register("session-a", [oldRouter]);
  assert.equal(registry.lookupRouter("session-router", "session-a"), oldRouter);
  assert.equal(registry.lookupRouter("session-router", "session-b"), undefined);

  const replacementRegistration = registry.register("session-a", [replacementRouter]);
  oldRegistration.release();
  assert.equal(
    registry.lookupRouter("session-router", "session-a"),
    replacementRouter,
    "a stale session teardown must not remove its replacement registration",
  );

  replacementRegistration.release();
  assert.equal(registry.lookupRouter("session-router", "session-a"), undefined);
  registry.dispose();
  assert.throws(
    () => registry.register("late-session", [oldRouter]),
    /router session custom-router registry is disposed/i,
  );
  assert.equal(registry.lookupRouter("session-router", "session-a"), undefined);
});

test("RouterRuntime dispatches each session to its retained custom-router generation", async () => {
  const registry = createNativeRouterSessionCustomRouterPort();
  const oldRegistration = registry.register("session-old", [customRouter("session-router", "old")]);
  const newRegistration = registry.register("session-new", [customRouter("session-router", "new")]);
  const router = createRouterRuntime(config, {
    modelRuntime,
    customRouterRegistry: registry,
  });

  const oldDecision = await router.decide(decisionInput("session-old"));
  const newDecision = await router.decide(decisionInput("session-new"));

  assert.deepEqual(
    { provider: oldDecision.provider, model: oldDecision.model, resolvedFrom: oldDecision.resolvedFrom },
    { provider: "old", model: "old-model", resolvedFrom: "custom" },
  );
  assert.deepEqual(
    { provider: newDecision.provider, model: newDecision.model, resolvedFrom: newDecision.resolvedFrom },
    { provider: "new", model: "new-model", resolvedFrom: "custom" },
  );

  oldRegistration.release();
  newRegistration.release();
  await router.shutdown();
  registry.dispose();
});

function customRouter(id: string, provider: string): PilotDeckCustomRouter {
  return {
    id,
    async decide() {
      return { provider, model: `${provider}-model` };
    },
  };
}

function decisionInput(sessionId: string) {
  return {
    request: {
      provider: "primary",
      model: "model",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
    },
    sessionId,
    isMainAgent: true,
  };
}
