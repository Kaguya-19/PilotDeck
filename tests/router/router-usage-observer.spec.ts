import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime, ModelRuntimeOptions } from "../../src/model/index.js";
import { createRouterRuntime, type RouterUsageObserver } from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { TokenStatsCollector } from "../../src/router/stats/TokenStatsCollector.js";

const runtime: ModelRuntime = {
  async *stream(_request: CanonicalModelRequest, _options?: ModelRuntimeOptions) {},
  async complete() { throw new Error("not used"); },
  getCapabilities() {
    return {
      supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false, supportsThinking: false,
      supportsJsonSchema: false, supportsSystemPrompt: true, supportsPromptCache: false, maxContextTokens: 8192, maxOutputTokens: 1024,
    };
  },
  getMultimodal() { return { input: ["text"] }; },
  getProviderProtocol() { return "openai"; },
  getProviderBaseUrl() { return "https://example.invalid"; },
};

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "provider/model", provider: "provider", model: "model" } },
  stats: { enabled: false },
};

test("router consumes the injected usage observer and disposes its owner", async () => {
  const sessionUsage: unknown[] = [];
  let disposed = false;
  const observer: RouterUsageObserver = {
    stats: new TokenStatsCollector({ enabled: false }),
    getSessionUsage() { return undefined; },
    observeSessionUsage(sessionId, usage) { sessionUsage.push({ sessionId, usage }); },
    observeRequest() {},
    async dispose() { disposed = true; },
  };
  const router = createRouterRuntime(config, { modelRuntime: runtime, usageObserver: observer });
  router.observeUsage("session-1", { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  assert.deepEqual(sessionUsage, [{
    sessionId: "session-1",
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  }]);
  await router.shutdown();
  assert.equal(disposed, true);
});
