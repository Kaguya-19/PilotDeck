import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelCapabilities,
  ModelRuntime,
} from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/index.js";
import type { RouterDecision } from "../../src/router/protocol/decision.js";

const textOnly = { input: ["text" as const] };
const baseCapabilities: ModelCapabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: false,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
};

describe("RouterRuntime max output token caps", () => {
  it("clips explicit maxOutputTokens to the attempted fallback model cap", async () => {
    let seenRequest: CanonicalModelRequest | undefined;
    const modelRuntime: ModelRuntime = {
      async *stream(request) {
        seenRequest = request;
        yield { type: "message_end", finishReason: "stop" };
      },
      async complete(): Promise<CanonicalModelResponse> {
        return { role: "assistant", content: [], finishReason: "stop" };
      },
      getCapabilities(providerId, modelId) {
        if (providerId === "fallback" && modelId === "small") {
          return { ...baseCapabilities, maxOutputTokens: 8_192 };
        }
        return { ...baseCapabilities, maxOutputTokens: 384 * 1024 };
      },
      getMultimodal() {
        return textOnly;
      },
      getProviderProtocol() {
        return "openai";
      },
      getProviderBaseUrl() {
        return "https://example.test/v1";
      },
    };

    const router = createRouterRuntime({
      enabled: true,
      zeroUsageRetry: { enabled: false, maxAttempts: 0 },
      scenarios: {
        default: { id: "primary/big", provider: "primary", model: "big" },
      },
    }, { modelRuntime });

    const decision: RouterDecision = {
      provider: "fallback",
      model: "small",
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    };
    const request: CanonicalModelRequest = {
      provider: "primary",
      model: "big",
      maxOutputTokens: 384 * 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };

    for await (const _event of router.execute(decision, request, { sessionId: "s", turnId: "t" })) {
      // Drain the stream.
    }

    assert.equal(seenRequest?.provider, "fallback");
    assert.equal(seenRequest?.model, "small");
    assert.equal(seenRequest?.maxOutputTokens, 8_192);
    await router.shutdown();
  });
});
