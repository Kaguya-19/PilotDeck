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
  fallback: {
    default: [
      { id: "backup/model", provider: "backup", model: "model" },
      { id: "tail/model", provider: "tail", model: "model" },
    ],
    maxFallbacks: 2,
  },
  transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  stats: { enabled: false },
};

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

function transientError(providerId: string) {
  return {
    type: "error" as const,
    error: {
      provider: providerId,
      protocol: "openai" as const,
      code: "server_error",
      message: `${providerId} unavailable`,
      retryable: true,
    },
  };
}

async function consume(router: ReturnType<typeof createRouterRuntime>, turnId: string): Promise<string[]> {
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
  }, { sessionId: "generation-health", turnId })) {
    events.push(event.type);
  }
  return events;
}

test("a retiring provider failure cannot open the replacement generation circuit", async () => {
  const registry = new ModelInvocationProviderRegistry();
  registry.register(provider("primary", async function* () {
    yield transientError("primary");
  }));
  registry.register(provider("tail", async function* () {
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "tail" };
    yield { type: "message_end", finishReason: "stop" };
  }));

  let oldBackupCalls = 0;
  let releaseFifth!: () => void;
  let markFifthStarted!: () => void;
  const fifthStarted = new Promise<void>((resolve) => {
    markFifthStarted = resolve;
  });
  registry.register(provider("backup", async function* () {
    oldBackupCalls += 1;
    if (oldBackupCalls === 5) {
      markFifthStarted();
      await new Promise<void>((resolve) => {
        releaseFifth = resolve;
      });
    }
    yield transientError("backup");
  }));

  const router = createRouterRuntime(config, {
    modelInvoker: createRegistryRouterModelInvocationPort(registry),
  });
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await consume(router, `turn-${index}`)).at(-1), "message_end");
  }

  const fifth = consume(router, "turn-5");
  await fifthStarted;
  let replacementCalls = 0;
  registry.replace(provider("backup", async function* () {
    replacementCalls += 1;
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "replacement" };
    yield { type: "message_end", finishReason: "stop" };
  }));
  releaseFifth();
  assert.equal((await fifth).at(-1), "message_end");

  const afterReplacement = await consume(router, "turn-6");
  assert.equal(replacementCalls, 1, "new generation must not inherit the retired circuit state");
  assert.equal(afterReplacement.includes("text_delta"), true);
  assert.equal(oldBackupCalls, 5);

  await router.shutdown();
  await registry.dispose();
});
