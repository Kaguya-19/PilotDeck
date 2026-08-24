import assert from "node:assert/strict";
import test from "node:test";

import { MessageProjector } from "../../src/context/projection/MessageProjector.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const projector = new MessageProjector();
const text = (value: string): CanonicalMessage => ({ role: "user", content: [{ type: "text", text: value }] });
const assistantCall = (id: string): CanonicalMessage => ({
  role: "assistant",
  content: [{ type: "tool_call", id, name: "read_file", input: { path: "README.md" } }],
});
const toolResult = (id: string): CanonicalMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolCallId: id, content: [{ type: "text", text: "ok" }] }],
});

test("MessageProjector leaves short conversations unchanged", () => {
  const messages = [text("one"), text("two")];
  const result = projector.project({ messages, maxMessages: 3 });
  assert.deepEqual(result.messages, messages);
  assert.equal(result.droppedCount, 0);
  assert.deepEqual(result.warnings, []);
});

test("MessageProjector truncates to a safe sliding window and reports dropped messages", () => {
  const result = projector.project({
    messages: [text("old"), text("middle"), text("recent"), text("latest")],
    maxMessages: 2,
  });
  assert.equal(result.droppedCount, 2);
  assert.deepEqual(result.messages.map((message) => message.content[0]), [
    { type: "text", text: "recent" },
    { type: "text", text: "latest" },
  ]);
  assert.equal(result.warnings[0]?.code, "context_truncated");
});

test("MessageProjector preserves a compaction checkpoint even when maxMessages is small", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "<compact-boundary id=1>" }] },
    { role: "assistant", content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY] summary" }] },
    text("tail"),
  ];
  const result = projector.project({ messages, maxMessages: 1 });
  assert.equal(result.droppedCount, 0);
  assert.equal(result.messages.length, 3);
});

test("MessageProjector injects placeholders for unmatched tool calls", () => {
  const result = projector.project({ messages: [assistantCall("missing")] });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1]?.content[0]?.type, "tool_result");
  assert.equal(result.messages[1]?.content[0]?.toolCallId, "missing");
  assert.equal(result.warnings[0]?.code, "tool_result_injected");
});

test("MessageProjector strips orphaned direct and media references while retaining normal content", () => {
  const result = projector.project({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "keep" },
        { type: "tool_result", toolCallId: "orphan", content: [{ type: "text", text: "drop" }] },
        {
          type: "media_reference", toolCallId: "orphan-media", path: "/tmp/a.png", originalBytes: 1,
          preview: "image", hasMore: false, mimeType: "image/png", mediaType: "image",
        },
      ],
    }],
  });
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0]?.content, [{ type: "text", text: "keep" }]);
  assert.equal(result.warnings.filter((warning) => warning.code === "tool_result_orphaned").length, 2);
});

test("MessageProjector keeps matched tool results and flushes pending calls before a later assistant", () => {
  const result = projector.project({
    messages: [assistantCall("call-1"), toolResult("call-1"), assistantCall("call-2")],
  });
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[1]?.content[0]?.type, "tool_result");
  assert.equal(result.messages[3]?.content[0]?.toolCallId, "call-2");
  assert.equal(result.warnings.at(-1)?.code, "tool_result_injected");
});

test("MessageProjector advances a cut past tool-result-only messages", () => {
  const result = projector.project({
    messages: [text("old"), assistantCall("call-1"), toolResult("call-1"), text("tail")],
    maxMessages: 2,
  });
  assert.equal(result.droppedCount, 3);
  assert.equal(result.messages[0]?.content[0]?.type, "text");
  assert.equal(result.messages[0]?.content[0]?.type === "text" ? result.messages[0].content[0].text : "", "tail");
});
