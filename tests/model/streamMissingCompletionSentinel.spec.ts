import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelEvent, ModelConfig } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { streamModel } from "../../src/model/streaming/streamModel.js";

function modelConfig(retry: NonNullable<ModelConfig["providers"][string]["retry"]> = { streamMaxRetries: 0 }): ModelConfig {
  return {
    providers: {
      bad: {
        id: "bad",
        protocol: "openai",
        url: "https://bad-backend.invalid/v1",
        apiKey: "test-key",
        headers: {},
        models: {
          "bad-model": {
            id: "bad-model",
            capabilities: DEFAULT_MODEL_CAPABILITIES,
            multimodal: { input: ["text"] },
          },
        },
        retry,
      },
    },
  };
}

function streamResponse(lines: string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(response: Response, config: ModelConfig = modelConfig()): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of streamModel({
    provider: "bad",
    model: "bad-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }, config, { fetch: async () => response })) {
    events.push(event);
  }
  return events;
}

async function collectWithFetch(fetchImpl: typeof fetch, config: ModelConfig): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of streamModel({
    provider: "bad",
    model: "bad-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }, config, { fetch: fetchImpl })) {
    events.push(event);
  }
  return events;
}

test("salvages text stream that cleanly ends without completion sentinel", async () => {
  const events = await collect(streamResponse([
    data({ id: "cmpl_bad", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
    data({ id: "cmpl_bad", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }),
  ]));

  assert.equal(events.at(-1)?.type, "message_end");
  assert.equal((events.at(-1) as Extract<CanonicalModelEvent, { type: "message_end" }>).finishReason, "unknown");
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "hello"), true);
});

test("keeps normal completion sentinel behavior unchanged", async () => {
  const events = await collect(streamResponse([
    data({ id: "cmpl_ok", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }),
    data({ id: "cmpl_ok", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]));

  assert.equal(events.at(-1)?.type, "message_end");
  assert.equal((events.at(-1) as Extract<CanonicalModelEvent, { type: "message_end" }>).finishReason, "stop");
});

test("does not salvage empty stream without completion sentinel", async () => {
  await assert.rejects(
    async () => collect(streamResponse([])),
    /Network stream ended before provider completion sentinel/,
  );
});

test("does not salvage incomplete tool call without completion sentinel", async () => {
  await assert.rejects(
    async () => collect(streamResponse([
      data({
        id: "cmpl_tool",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\"" } }] },
          finish_reason: null,
        }],
      }),
    ])),
    /Network stream ended before provider completion sentinel/,
  );
});

test("keeps normal tool-call finish without DONE sentinel", async () => {
  const events = await collect(streamResponse([
    data({
      id: "cmpl_tool_done",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] },
        finish_reason: "tool_calls",
      }],
    }),
  ]));

  assert.equal(events.at(-1)?.type, "message_end");
  assert.equal((events.at(-1) as Extract<CanonicalModelEvent, { type: "message_end" }>).finishReason, "tool_call");
  assert.equal(events.some((event) => event.type === "tool_call_end"), true);
});

test("ignores SSE comments and event-only keepalive frames", async () => {
  const events = await collect(streamResponse([
    ": keepalive\n\n",
    "event: ping\n\n",
    data({ id: "cmpl_keepalive", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }),
    data({ id: "cmpl_keepalive", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]));

  assert.equal(events.at(-1)?.type, "message_end");
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "hello"), true);
});

test("malformed SSE JSON is reported as retryable stream parse error", async () => {
  await assert.rejects(
    async () => collect(streamResponse([
      "data: {bad json\n\n",
    ])),
    /Malformed provider SSE JSON/,
  );
});

test("malformed early SSE frame retries and recovers with capped backoff", async () => {
  const responses = [
    streamResponse(["data: {bad json\n\n"]),
    streamResponse([
      data({ id: "cmpl_retry_ok", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }),
      data({ id: "cmpl_retry_ok", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]),
  ];
  let fetchCount = 0;
  const events = await collectWithFetch(async () => responses[fetchCount++]!, modelConfig({
    streamMaxRetries: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
  }));

  assert.equal(fetchCount, 2);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "ok"), true);
  assert.equal(events.at(-1)?.type, "message_end");
});
