import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { CanonicalMessage } from "../../src/model/index.js";
import { materializeMediaReferences } from "../../src/model/index.js";

test("materializeMediaReferences restores persisted media blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-materialize-media-"));
  const mediaPath = join(root, "image.b64");
  await writeFile(mediaPath, "base64-image-data", "utf8");
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "media_reference",
          toolCallId: "call-1",
          path: mediaPath,
          originalBytes: 42,
          preview: "[Image: image/png, 42 bytes]",
          hasMore: true,
          mimeType: "image/png",
          mediaType: "image",
          detail: "low",
        },
      ],
    },
  ];

  const result = await materializeMediaReferences(messages);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.messages, messages);

  const block = result.messages[0]?.content[0];
  assert.equal(block?.type, "image");
  if (block?.type !== "image") return;
  assert.equal(block.data, "base64-image-data");
  assert.equal(block.mimeType, "image/png");
  assert.equal(block.bytes, 42);
  assert.equal(block.detail, "low");
});

test("materializeMediaReferences falls back to preview text when media is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-materialize-media-"));
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "media_reference",
          toolCallId: "call-1",
          path: join(root, "missing.b64"),
          originalBytes: 42,
          preview: "[Image: missing]",
          hasMore: true,
          mimeType: "image/png",
          mediaType: "image",
        },
      ],
    },
  ];

  const result = await materializeMediaReferences(messages);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "media_reference_materialization_failed");

  const block = result.messages[0]?.content[0];
  assert.deepEqual(block, { type: "text", text: "[Image: missing]" });
});
