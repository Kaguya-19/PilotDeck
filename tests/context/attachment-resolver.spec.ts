import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AttachmentResolver } from "../../src/context/attachments/AttachmentResolver.js";
import type { AttachmentPort } from "../../src/context/attachments/AttachmentPort.js";

test("Office attachments use their original name when the stored path is opaque", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-resolver-"));
  try {
    const filePath = join(root, "opaque-upload-id");
    await writeFile(filePath, Buffer.from("PK".padEnd(128, "x")));

    const result = await new AttachmentResolver({ maxFileBytes: 1 }).resolve({
      type: "file",
      path: filePath,
      name: "sample.docx",
    });

    assert.equal(result.blocks.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, "attachment_unsupported");
    assert.equal(result.diagnostics[0]?.severity, "info");
    assert.match(result.diagnostics[0]?.message ?? "", /read_file cannot inspect this format directly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AttachmentResolver consumes an injected attachment storage provider", async () => {
  const calls: string[] = [];
  const attachmentPort: AttachmentPort = {
    async stat(path) {
      calls.push(`stat:${path}`);
      return { size: 12 };
    },
    async readText(path) {
      calls.push(`text:${path}`);
      return "from provider";
    },
    async readBytes(path) {
      calls.push(`bytes:${path}`);
      return new Uint8Array([0, 1, 2]);
    },
  };
  const resolver = new AttachmentResolver({ attachmentPort });

  const text = await resolver.resolve({ type: "file", path: "/attachments/notes.txt" });
  const image = await resolver.resolve({ type: "image", path: "/attachments/image.png" });

  assert.deepEqual(text.blocks, [{
    type: "text",
    text: '<attachment path="/attachments/notes.txt">\nfrom provider\n</attachment>',
  }]);
  assert.equal(image.diagnostics[0]?.code, "image_invalid");
  assert.deepEqual(calls, [
    "stat:/attachments/notes.txt",
    "text:/attachments/notes.txt",
    "stat:/attachments/image.png",
    "bytes:/attachments/image.png",
  ]);
});
