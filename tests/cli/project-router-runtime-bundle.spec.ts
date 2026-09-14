import assert from "node:assert/strict";
import test from "node:test";

import { ProjectRouterRuntimeBundle } from "../../src/cli/ProjectRouterRuntimeBundle.js";
import {
  ModelInvocationProviderRegistry,
  type ModelRuntime,
} from "../../src/model/index.js";
import type { PilotConfigSnapshot } from "../../src/pilot/index.js";
import type { RouterProviderHealthPort } from "../../src/router/index.js";
import type { TelemetryClient, TelemetryConfig } from "../../src/telemetry/index.js";

test("project router runtime bundle owns RouterRuntime shutdown while consuming an injected complete model runtime", async () => {
  let healthDisposed = false;
  const bundle = new ProjectRouterRuntimeBundle({
    snapshot: snapshot(),
    model: model(),
    modelProviders: new ModelInvocationProviderRegistry(),
    useModelRuntime: true,
    extensions: {
      async loadSkillPrompt() { return undefined; },
    },
    now: () => new Date(0),
    telemetry: telemetry(),
    createRouterConfig: () => ({ enabled: false }),
    createRouterEventBus: () => ({ publish() {}, emit() {} }),
    createProviderHealth: () => healthProvider(() => { healthDisposed = true; }),
  });

  const resources = bundle.stage();
  let shutdowns = 0;
  const shutdown = resources.router.shutdown.bind(resources.router);
  resources.router.shutdown = async () => {
    shutdowns += 1;
    await shutdown();
  };
  assert.ok(resources.tokenAccounting);

  const first = bundle.dispose();
  const second = bundle.dispose();
  assert.equal(first, second);
  await first;
  assert.equal(shutdowns, 1);
  assert.equal(healthDisposed, true);
});

function healthProvider(onDispose: () => void): RouterProviderHealthPort {
  return {
    shouldSkip() { return false; },
    recordFailure() {},
    recordSuccess() {},
    dispose() { onDispose(); },
  };
}

function snapshot(): PilotConfigSnapshot {
  return {
    version: 1,
    schemaVersion: 1,
    loadedAt: new Date(0),
    contentHash: "test",
    sources: [],
    diagnostics: [],
    config: {
      agent: { model: { id: "test/test", provider: "test", model: "test" } },
      model: { providers: {} },
      extension: { builtinPluginsEnabled: {}, includeHookEvents: false },
    },
  };
}

function model(): ModelRuntime {
  return {
    stream: async function* () {},
    async complete() { return { role: "assistant", content: [], finishReason: "stop" }; },
    getCapabilities() { return { supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false, supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: true, supportsPromptCache: false, maxContextTokens: 8192, maxOutputTokens: 1024 }; },
    getMultimodal() { return { input: ["text"] }; },
    getProviderProtocol() { return "openai" as const; },
    getProviderBaseUrl() { return undefined; },
  };
}

function telemetry(): TelemetryClient {
  const config = {} as TelemetryConfig;
  return {
    track() {}, trackFeatureUsed() {}, trackFeatureLoopStage() {}, trackError() {}, setEnabled() {},
    async flush() {}, async shutdown() {},
    snapshot() { return { queued: 0, sent: 0, sendFailures: 0, retries: 0, dropped: 0, queueDepth: 0 }; },
    getConfig() { return config; },
  };
}
