import assert from "node:assert/strict";
import test from "node:test";

import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
} from "../../../src/model/index.js";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
} from "../../../src/model/providers/openai/stream.js";

test("openai stream parser preserves native reasoning content for replay", () => {
  const streamState = createOpenAIStreamState();
  const events = normalizeOpenAIStreamEvent({
    choices: [{
      delta: { reasoning_content: "native content" },
    }],
  }, streamState);

  const assembler = createModelMessageAssemblerState();
  for (const event of events) {
    applyModelEventToAssembler(assembler, event);
  }
  applyModelEventToAssembler(assembler, { type: "message_end", finishReason: "stop" });

  const assembled = assembleAssistantMessage(assembler);
  assert.deepEqual(assembled.message.content[0], {
    type: "thinking",
    text: "native content",
    reasoningContent: "native content",
  });
});
