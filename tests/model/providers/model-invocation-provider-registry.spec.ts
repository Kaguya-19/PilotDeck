import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelInvocationProviderRegistry,
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalModelResponse,
  type ModelInvocationProvider,
} from "../../../src/model/index.js";

const request: CanonicalModelRequest = {
  provider: "primary",
  model: "model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

function provider(
  name: string,
  options: {
    stream?: (request: CanonicalModelRequest) => AsyncIterable<CanonicalModelEvent>;
    complete?: (request: CanonicalModelRequest) => Promise<CanonicalModelResponse>;
    onDispose?: () => void | Promise<void>;
  } = {},
): ModelInvocationProvider {
  return {
    providerId: "primary",
    stream: options.stream ?? (async function* () {
      yield { type: "text_delta", text: name };
    }),
    complete: options.complete ?? (async () => ({
      role: "assistant",
      content: [{ type: "text", text: name }],
      finishReason: "stop",
    })),
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
    getMultimodal() {
      return { input: ["text"] };
    },
    getProviderProtocol() {
      return "openai";
    },
    getProviderBaseUrl() {
      return `https://${name}.invalid`;
    },
    dispose: options.onDispose,
  };
}

test("replacement publishes a new provider generation before the retired stream drains", async () => {
  const registry = new ModelInvocationProviderRegistry();
  let releaseOld!: () => void;
  let oldDisposed = 0;
  const oldStarted = new Promise<void>((resolveStarted) => {
    registry.register(provider("old", {
      stream: async function* () {
        yield { type: "text_delta", text: "old-start" };
        await new Promise<void>((resolveRelease) => {
          releaseOld = resolveRelease;
          resolveStarted();
        });
        yield { type: "text_delta", text: "old-end" };
      },
      onDispose() {
        oldDisposed += 1;
      },
    }));
  });

  const oldEvents: CanonicalModelEvent[] = [];
  const oldStream = (async () => {
    for await (const event of registry.stream(request)) {
      oldEvents.push(event);
    }
  })();
  await oldStarted;

  const replacement = registry.replace(provider("new"));
  assert.equal(replacement.registration.generation, 2);
  assert.equal(oldDisposed, 0, "the old provider remains alive for its accepted stream");

  const newEvents: CanonicalModelEvent[] = [];
  for await (const event of registry.stream(request)) {
    newEvents.push(event);
  }
  assert.deepEqual(newEvents, [{ type: "text_delta", text: "new" }]);

  releaseOld();
  await oldStream;
  await replacement.retired;
  assert.deepEqual(oldEvents, [
    { type: "text_delta", text: "old-start" },
    { type: "text_delta", text: "old-end" },
  ]);
  assert.equal(oldDisposed, 1);
  await registry.dispose();
});

test("unregister stops new invocations but drains an accepted completion", async () => {
  const registry = new ModelInvocationProviderRegistry();
  let releaseCompletion!: () => void;
  let disposed = 0;
  let started!: () => void;
  const completionStarted = new Promise<void>((resolveStarted) => {
    started = resolveStarted;
  });
  registry.register(provider("primary", {
    complete: async () => {
      started();
      await new Promise<void>((resolveRelease) => {
        releaseCompletion = resolveRelease;
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "complete" }],
        finishReason: "stop",
      };
    },
    onDispose() {
      disposed += 1;
    },
  }));

  const completion = registry.complete(request);
  await completionStarted;
  const unregistering = registry.unregister("primary");
  assert.throws(
    () => registry.getCapabilities("primary", "model"),
    /does not exist/,
    "a retired route cannot admit new work",
  );
  assert.equal(disposed, 0);

  releaseCompletion();
  assert.equal((await completion).content[0]?.type, "text");
  assert.equal(await unregistering, true);
  assert.equal(disposed, 1);
});

test("registry disposes every route even when one provider disposer fails", async () => {
  const registry = new ModelInvocationProviderRegistry();
  let healthyDisposed = 0;
  registry.register({ ...provider("broken"), providerId: "broken", dispose() { throw new Error("broken dispose"); } });
  registry.register({ ...provider("healthy"), providerId: "healthy", dispose() { healthyDisposed += 1; } });

  await assert.rejects(registry.dispose(), /broken dispose/);
  assert.equal(healthyDisposed, 1);
});
