import assert from "node:assert/strict";
import test from "node:test";

import { ProjectModelRuntimeBundle } from "../../src/cli/ProjectModelRuntimeBundle.js";
import type {
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelInvocationProvider,
  ModelRuntime,
} from "../../src/model/index.js";
import type { PilotConfigSnapshot } from "../../src/pilot/index.js";

test("project model runtime bundle exposes a registry-backed native provider runtime and owns its provider", async () => {
  let disposed = 0;
  const bundle = new ProjectModelRuntimeBundle({
    snapshot: snapshot(),
    modelInvocationProviderFactory: () => [{
      ...provider("test"),
      dispose() { disposed += 1; },
    }],
  });
  const resources = bundle.stage();

  const response = await resources.model.complete(request());
  assert.equal(response.content[0]?.type, "text");
  assert.equal(resources.modelProviders.getProviderGeneration("test"), 1);
  await bundle.dispose();
  await bundle.dispose();
  assert.equal(disposed, 1);
});

test("project model runtime bundle keeps an injected complete runtime outside its provider lifecycle", async () => {
  let factoryCalls = 0;
  const injected = runtime();
  const bundle = new ProjectModelRuntimeBundle({
    snapshot: snapshot(),
    modelFactory: () => {
      factoryCalls += 1;
      return injected;
    },
  });

  assert.equal(bundle.stage().model, injected);
  assert.equal(factoryCalls, 1);
  await bundle.dispose();
});

test("project model runtime bundle releases providers registered before a staging failure", async () => {
  let disposed = 0;
  const bundle = new ProjectModelRuntimeBundle({
    snapshot: snapshot(),
    modelInvocationProviderFactory: () => [
      { ...provider("duplicate"), dispose() { disposed += 1; } },
      provider("duplicate"),
    ],
  });

  assert.throws(() => bundle.stage(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "duplicate_provider");
    return true;
  });
  await bundle.dispose();
  assert.equal(disposed, 1);
});

function snapshot(): PilotConfigSnapshot {
  return {
    version: 1,
    schemaVersion: 1,
    loadedAt: new Date(0),
    contentHash: "test",
    sources: [],
    config: {
      agent: {
        model: { id: "test/test", provider: "test", model: "test" },
        maxContextTokens: 8192,
        maxOutputTokens: 1024,
      },
      model: {
        providers: {
          test: {
            id: "test",
            protocol: "openai",
            url: "http://127.0.0.1:1",
            apiKey: "test",
            headers: {},
            models: {
              test: {
                id: "test",
                multimodal: { input: ["text"] },
                capabilities: {
                  supportsToolUse: true,
                  supportsStreaming: true,
                  supportsParallelToolCalls: false,
                  supportsThinking: false,
                  supportsJsonSchema: false,
                  supportsSystemPrompt: true,
                  supportsPromptCache: false,
                  maxContextTokens: 8192,
                  maxOutputTokens: 1024,
                },
              },
            },
          },
        },
      },
      extension: { builtinPluginsEnabled: {}, includeHookEvents: false },
    },
    diagnostics: [],
  };
}

function request(): CanonicalModelRequest {
  return {
    provider: "test",
    model: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function provider(providerId: string): ModelInvocationProvider {
  return {
    providerId,
    async *stream() {
      yield { type: "text_delta", text: "ok" };
    },
    async complete(): Promise<CanonicalModelResponse> {
      return { role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" };
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
    getProviderProtocol() { return "openai" as const; },
    getProviderBaseUrl() { return undefined; },
  };
}

function runtime(): ModelRuntime {
  return {
    stream: async function* () {},
    async complete() {
      return { role: "assistant", content: [], finishReason: "stop" };
    },
    getCapabilities() { return provider("unused").getCapabilities("unused"); },
    getMultimodal() { return { input: ["text"] }; },
    getProviderProtocol() { return "openai" as const; },
    getProviderBaseUrl() { return undefined; },
  };
}
