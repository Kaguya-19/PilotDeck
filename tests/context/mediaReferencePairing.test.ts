import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMessage } from "../../src/model/index.js";
import { MessageProjector } from "../../src/context/index.js";

test("MessageProjector strips media references whose tool call was dropped", () => {
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "media_reference",
          toolCallId: "missing-call",
          path: "/tmp/missing.b64",
          originalBytes: 100,
          preview: "[Image: omitted]",
          hasMore: true,
          mimeType: "image/png",
          mediaType: "image",
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  ];

  const result = new MessageProjector().project({ messages });
  assert.deepEqual(result.messages, [messages[1]]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "tool_result_orphaned");
});
