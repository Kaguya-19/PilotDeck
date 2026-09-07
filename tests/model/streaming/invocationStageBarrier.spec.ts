import assert from "node:assert/strict";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { complete, streamModel } from "../../../src/model/streaming/streamModel.js";

const config = parseModelConfig({
  providers: {
    test: {
      protocol: "openai",
      url: "https://example.test/v1",
      apiKey: "test-key",
      retry: { requestMaxRetries: 0, streamMaxRetries: 0 },
      models: { "test-model": {} },
    },
  },
});

const request: CanonicalModelRequest = {
  provider: "test",
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function invocationSink(stage: () => Promise<void>) {
  return {
    stage,
    append: async () => {},
  };
}

test("complete waits for invocation staging before sending HTTP", async () => {
  const gate = deferred();
  let fetchCalls = 0;
  const promise = complete(request, config, {
    invocation: {
      context: {
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "turn",
        logicalCallId: "call",
        caller: "agent",
      },
      sink: invocationSink(() => gate.promise),
    },
    fetch: async () => {
      fetchCalls++;
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }), { status: 200 });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetchCalls, 0);
  gate.resolve();
  await promise;
  assert.equal(fetchCalls, 1);
});

test("streamModel waits for invocation staging before sending HTTP", async () => {
  const gate = deferred();
  let fetchCalls = 0;
  const stream = streamModel(request, config, {
    invocation: {
      context: {
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "turn",
        logicalCallId: "call",
        caller: "agent",
      },
      sink: invocationSink(() => gate.promise),
    },
    fetch: async () => {
      fetchCalls++;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const iterator = stream[Symbol.asyncIterator]();
  const firstEvent = await iterator.next();
  assert.equal(firstEvent.value?.type, "request_started");
  const nextRequest = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetchCalls, 0);
  gate.resolve();
  await nextRequest;
  while (!(await iterator.next()).done) {
    // Drain the stream so the invocation is finalized.
  }
  assert.equal(fetchCalls, 1);
});
