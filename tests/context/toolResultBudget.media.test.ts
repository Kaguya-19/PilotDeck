import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { CanonicalMessage } from "../../src/model/index.js";
import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";

test("ToolResultBudget persists large supplemental image media as a reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-media-budget-"));
  const toolResultsDir = join(root, "tool-results");
  const data = "a".repeat(128);
  const message: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "image",
        source: "base64",
        data,
        mimeType: "image/png",
        bytes: 96,
        detail: "high",
      },
    ],
  };

  const budget = new ToolResultBudget({
    toolResultsDir,
    maxResultSizeChars: 16,
    previewBytes: 8,
  });

  const result = await budget.applyToSupplementalMessage(message, "call-1");
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.equal(block.type, "media_reference");
  if (block.type !== "media_reference") return;

  assert.equal(block.toolCallId, "call-1");
  assert.equal(block.mimeType, "image/png");
  assert.equal(block.mediaType, "image");
  assert.equal(block.originalBytes, 96);
  assert.equal(block.detail, "high");
  assert.equal(await readFile(block.path, "utf8"), data);
  assert.ok(block.path.startsWith(toolResultsDir));
});

test("ToolResultBudget keeps small supplemental media inline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-media-budget-"));
  const message: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "pdf",
        source: "base64",
        data: "short",
        mimeType: "application/pdf",
        bytes: 4,
        pages: 1,
      },
    ],
  };

  const budget = new ToolResultBudget({
    toolResultsDir: join(root, "tool-results"),
    maxResultSizeChars: 64,
  });

  const result = await budget.applyToSupplementalMessage(message, "call-1");
  assert.equal(result, message);
  assert.equal(result.content[0]?.type, "pdf");
});
