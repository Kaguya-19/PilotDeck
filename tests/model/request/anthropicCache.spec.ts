import test from "node:test";
import assert from "node:assert/strict";

import { buildAnthropicRequest } from "../../../src/model/providers/anthropic/request.js";
import type { CanonicalModelRequest, ModelDefinition } from "../../../src/model/index.js";

const model: ModelDefinition = {
  id: "claude-test",
  capabilities: {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: false,
    supportsThinking: false,
    supportsJsonSchema: false,
    supportsSystemPrompt: true,
    supportsPromptCache: true,
    maxOutputTokens: 1024,
    maxContextTokens: 8192,
  },
  multimodal: { input: ["text"] },
};

function requestWithBreakpoints(cacheBreakpoints: number[]): CanonicalModelRequest {
  return {
    provider: "anthropic",
    model: model.id,
    systemPrompt: "Stable system prompt",
    messages: Array.from({ length: 8 }, (_, index) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `message-${index}` }],
    })),
    maxOutputTokens: 128,
    cacheBreakpoints,
  };
}

test("Anthropic keeps the most recent message cache breakpoints", () => {
  const body = buildAnthropicRequest(requestWithBreakpoints([1, 3, 5, 7]), model);

  const marked = body.messages
    .map((message, index) => ({ index, content: message.content }))
    .filter(({ content }) => content.some((block: any) => block.cache_control?.type === "ephemeral"))
    .map(({ index }) => index);

  assert.deepEqual(marked, [3, 5, 7]);
  for (const message of body.messages) {
    for (const block of message.content as Array<Record<string, any>>) {
      if (block.cache_control) assert.equal(block.cache_control.ttl, "1h");
    }
  }
  assert.deepEqual(body.system, [{
    type: "text",
    text: "Stable system prompt",
    cache_control: { type: "ephemeral", ttl: "1h" },
  }]);
});
