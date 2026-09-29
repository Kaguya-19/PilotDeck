import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeRouterSessionStateProvider,
  createRouterRuntime,
  type RouterSessionStatePort,
} from "../../src/router/index.js";
import type { ModelRuntime } from "../../src/model/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "primary/model", provider: "primary", model: "model" } },
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

test("RouterRuntime consumes an injected session-state port without owning its cleanup", async () => {
  const native = createNativeRouterSessionStateProvider();
  let gets = 0;
  let sets = 0;
  const state: RouterSessionStatePort = {
    get(...input) {
      gets += 1;
      return native.get(...input);
    },
    set(input) {
      sets += 1;
      native.set(input);
    },
  };
  const router = createRouterRuntime(config, { modelRuntime, sessionState: state });

  await router.decide({
    request: {
      provider: "primary",
      model: "model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    sessionId: "shared-session",
    isMainAgent: true,
  });

  assert.ok(gets > 0);
  assert.equal(sets, 1);
  assert.equal(native.get("shared-session", false)?.stickyProvider, "primary");

  await router.shutdown();
  assert.equal(
    native.get("shared-session", false)?.stickyProvider,
    "primary",
    "a retired RouterRuntime must not clear application-owned state",
  );
  native.clear();
  assert.equal(native.get("shared-session", false), undefined);
});
