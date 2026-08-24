import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AttachmentResolver } from "../../src/context/attachments/AttachmentResolver.js";

test("Office attachments are reported unsupported before size checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-resolver-"));
  try {
    const filePath = join(root, "sample.docx");
    await writeFile(filePath, Buffer.from("PK".padEnd(128, "x")));

    const result = await new AttachmentResolver({ maxFileBytes: 1 }).resolve({ type: "file", path: filePath });

    assert.equal(result.blocks.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, "attachment_unsupported");
    assert.equal(result.diagnostics[0]?.severity, "warning");
    assert.match(result.diagnostics[0]?.message ?? "", /read_file cannot inspect this format directly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AttachmentResolver reads whitelisted text, rejects missing/unsupported/large files, and builds a user message", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-text-"));
  try {
    const textPath = join(root, "notes.md");
    const binaryPath = join(root, "archive.zip");
    const unknownPath = join(root, "data.bin");
    await writeFile(textPath, "hello\n", "utf8");
    await writeFile(binaryPath, "archive", "utf8");
    await writeFile(unknownPath, "data", "utf8");
    const resolver = new AttachmentResolver({ maxFileBytes: 10 });

    const text = await resolver.resolve({ type: "file", path: textPath });
    assert.equal(text.diagnostics.length, 0);
    assert.match(text.blocks[0]?.type === "text" ? text.blocks[0].text : "", /<attachment path=".*notes\.md">/);
    assert.deepEqual(resolver.toUserMessage(text), { role: "user", content: text.blocks });

    const missing = await resolver.resolve({ type: "file", path: join(root, "missing.txt") });
    assert.equal(missing.diagnostics[0]?.code, "attachment_missing");
    const unsupported = await resolver.resolve({ type: "file", path: binaryPath });
    assert.equal(unsupported.diagnostics[0]?.code, "attachment_unsupported");
    assert.match(unsupported.diagnostics[0]?.message ?? "", /Office\/archive\/binary/);
    const unknown = await resolver.resolve({ type: "file", path: unknownPath });
    assert.equal(unknown.diagnostics[0]?.code, "attachment_unsupported");
    await writeFile(textPath, "01234567890", "utf8");
    const large = await resolver.resolve({ type: "file", path: textPath });
    assert.equal(large.diagnostics[0]?.code, "attachment_too_large");

    const all = await resolver.resolveAll([
      { type: "file", path: textPath },
      { type: "file", path: missingPath(root) },
    ]);
    assert.equal(all.blocks.length, 0);
    assert.equal(all.diagnostics.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AttachmentResolver handles image MIME detection, validation, limits and mismatch diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-image-"));
  try {
    const pngPath = join(root, "pixel.png");
    const mismatchPath = join(root, "pixel.jpg");
    const invalidPath = join(root, "invalid.png");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(pngPath, png);
    await writeFile(mismatchPath, png);
    await writeFile(invalidPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]));

    const resolver = new AttachmentResolver({ maxImageBytes: png.length + 1 });
    const image = await resolver.resolve({ type: "image", path: pngPath });
    assert.equal(image.diagnostics[0]?.code, "image_no_resize");
    assert.equal(image.blocks[0]?.type, "image");
    const explicit = await resolver.resolve({ type: "image", path: mismatchPath, mimeType: "image/png" });
    assert.equal(explicit.blocks.length, 1);
    const mismatch = await resolver.resolve({ type: "image", path: mismatchPath, mimeType: "image/jpeg" });
    assert.equal(mismatch.blocks.length, 0);
    assert.equal(mismatch.diagnostics[0]?.code, "image_invalid");
    const invalid = await resolver.resolve({ type: "image", path: invalidPath });
    assert.equal(invalid.diagnostics[0]?.code, "image_invalid");

    const unknown = await resolver.resolve({ type: "image", path: join(root, "pixel.unknown") });
    assert.equal(unknown.diagnostics[0]?.code, "attachment_missing");
    const unsupported = await resolver.resolve({ type: "image", path: pngPath.replace("pixel.png", "pixel.unknown") });
    assert.equal(unsupported.diagnostics[0]?.code, "attachment_missing");

    const limited = await new AttachmentResolver({ maxImageBytes: png.length - 1 }).resolve({ type: "image", path: pngPath });
    assert.equal(limited.diagnostics[0]?.code, "attachment_too_large");
    await writeFile(join(root, "unknown.bin"), png);
    const explicitUnknown = await resolver.resolve({ type: "image", path: join(root, "unknown.bin") });
    assert.equal(explicitUnknown.diagnostics[0]?.code, "attachment_unsupported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AttachmentResolver estimates PDF pages and reports missing PDFs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-attachment-pdf-"));
  try {
    const pdfPath = join(root, "document.pdf");
    await writeFile(pdfPath, Buffer.alloc(25));
    const resolver = new AttachmentResolver({ bytesPerPdfPage: 10 });
    const pdf = await resolver.resolve({ type: "pdf", path: pdfPath });
    assert.equal(pdf.blocks[0]?.type, "text");
    assert.match(pdf.blocks[0]?.type === "text" ? pdf.blocks[0].text : "", /estimated 3 pages/);
    assert.equal(pdf.diagnostics[0]?.code, "pdf_size_estimate");
    const missing = await resolver.resolve({ type: "pdf", path: join(root, "missing.pdf") });
    assert.equal(missing.diagnostics[0]?.code, "attachment_missing");
    assert.equal(await stat(pdfPath).then(() => true), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function missingPath(root: string): string {
  return join(root, "missing.txt");
}
