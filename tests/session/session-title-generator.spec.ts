import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionTitleGenerator,
  SESSION_TITLE_MAX_INPUT_CHARS,
} from "../../src/session/title/SessionTitleGenerator.js";
import type { CanonicalModelRequest, CanonicalModelResponse } from "../../src/model/index.js";
import type { ModelRuntimeOptions } from "../../src/model/streaming/streamModel.js";

function response(text: string): CanonicalModelResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    finishReason: "stop",
  };
}

test("session title generation uses the configured agent model and normalized bounded input", async () => {
  let request: CanonicalModelRequest | undefined;
  let callOptions: ModelRuntimeOptions | undefined;
  const generator = createSessionTitleGenerator({
    agentModel: { id: "agent-model", provider: "modelbest", model: "agent-model" },
    modelRuntime: {
      complete: async (candidate: CanonicalModelRequest, options?: ModelRuntimeOptions) => {
        request = candidate;
        callOptions = options;
        return response('{"title":"Fix the gateway"}');
      },
    },
  });

  const title = await generator({
    text: `  ${"prompt ".repeat(400)}  `,
    sessionId: "session-1",
    turnId: "turn-1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "Fix the gateway");
  assert.equal(request?.provider, "modelbest");
  assert.equal(request?.model, "agent-model");
  assert.equal(request?.maxOutputTokens, 4096);
  assert.equal(request?.temperature, 0);
  assert.equal(request?.messages[0]?.role, "user");
  const prompt = request?.messages[0]?.content[0];
  assert.equal(prompt?.type, "text");
  assert.equal(prompt?.type === "text" ? prompt.text.length : 0, SESSION_TITLE_MAX_INPUT_CHARS);
  assert.equal(callOptions?.signal?.aborted, false);
});

test("session title generation treats malformed provider output as a non-fatal missing title", async () => {
  const outputs = ["not json", '{"name":"missing title"}', "```json\n{\"title\":\"Valid title\"}\n```"];
  for (const [index, output] of outputs.entries()) {
    const generator = createSessionTitleGenerator({
      agentModel: { id: "agent-model", provider: "modelbest", model: "agent-model" },
      modelRuntime: {
        complete: async () => response(output),
      },
    });
    const title = await generator({
      text: "Create a title",
      sessionId: `session-${index}`,
      turnId: "turn-1",
      signal: new AbortController().signal,
    });
    assert.equal(title, index === 2 ? "Valid title" : null);
  }
});

test("session title provider errors are isolated and return null", async () => {
  const generator = createSessionTitleGenerator({
    agentModel: { id: "agent-model", provider: "modelbest", model: "agent-model" },
    modelRuntime: {
      complete: async () => {
        throw new Error("provider unavailable");
      },
    },
    });

  const title = await generator({
    text: "Create a title",
    sessionId: "session-error",
    turnId: "turn-1",
    signal: new AbortController().signal,
  });
  assert.equal(title, null);
});
