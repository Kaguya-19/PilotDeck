import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { CanonicalMessage } from "../../src/model/index.js";
import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";

function textMessage(text: string, role: "user" | "assistant" = "user"): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function toolMessage(content: CanonicalMessage["content"], toolCallId = "call-1"): CanonicalMessage {
  return { role: "user", content: [{ type: "tool_result", toolCallId, content: content as never }] };
}

test("ToolResultBudget leaves non-user and inline messages unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-budget-inline-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 100, maxResultSizeTokens: 100 });
    const assistant = textMessage("assistant", "assistant");
    assert.equal(await budget.applyToMessage(assistant), assistant);
    const inline = toolMessage([{ type: "text", text: "small" }]);
    assert.equal(await budget.applyToMessage(inline), inline);
    const noMedia = textMessage("small");
    assert.equal(await budget.applyToSupplementalMessage(noMedia, "call-1"), noMedia);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("large text results persist as JSON or text references and reuse state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-budget-text-"));
  const dir = join(root, "tool-results");
  try {
    const budget = new ToolResultBudget({
      toolResultsDir: dir,
      maxResultSizeChars: 20,
      maxResultSizeTokens: 5_000,
      previewBytes: 10,
    });
    const json = toolMessage([{ type: "text", text: `  ${JSON.stringify({ value: "x".repeat(100) })}` }], "bad id/1");
    const first = await budget.applyToMessage(json, { turnId: "turn/1" });
    const ref = first.content[0];
    assert.equal(ref.type, "tool_result_reference");
    assert.match(ref.path, /turn-1-bad-id-1\.json$/);
    assert.equal(Buffer.byteLength(ref.preview, "utf8") <= 10, true);
    assert.equal(ref.hasMore, true);
    assert.equal(ref.mimeType, "application/json");
    assert.match(ref.readFilePath ?? "", /refs\/result-0001\.json$/);
    assert.equal((await readFile(ref.path, "utf8")).includes('"value"'), true);

    const second = await budget.applyToMessage(json, { turnId: "turn/1" });
    assert.deepEqual(second, first);
    assert.equal(budget.getState().replacements.size, 1);

    const plain = toolMessage([{ type: "text", text: "plain\n" + "z".repeat(100) }], "plain");
    const plainResult = await budget.applyToMessage(plain);
    assert.equal(plainResult.content[0]?.type, "tool_result_reference");
    assert.equal(plainResult.content[0]?.type === "tool_result_reference" && plainResult.content[0].mimeType, "text/plain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-file alias allocation skips an existing alias without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-budget-alias-"));
  const dir = join(root, "tool-results");
  try {
    await mkdir(join(dir, "refs"), { recursive: true });
    await writeFile(join(dir, "refs", "result-0001.txt"), "keep me");
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 10, maxResultSizeTokens: 10, previewBytes: 40 });
    const result = await budget.applyToMessage(toolMessage([{ type: "text", text: "x".repeat(100) }], "alias"));
    const ref = result.content[0];
    assert.equal(ref.type, "tool_result_reference");
    assert.match(ref.readFilePath ?? "", /refs\/result-0002\.txt$/);
    assert.equal(await readFile(join(dir, "refs", "result-0001.txt"), "utf8"), "keep me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large image and PDF tool results become media references while preserving a text placeholder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-budget-media-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 10, maxResultSizeTokens: 10 });
    const image = { type: "image" as const, source: "base64" as const, data: "a".repeat(100), mimeType: "image/png", bytes: 256, detail: "high" as const };
    const pdf = { type: "pdf" as const, source: "base64" as const, data: "b".repeat(100), mimeType: "application/pdf" as const, bytes: 512, pages: 3 };
    const result = await budget.applyToMessage(toolMessage([
      { type: "text", text: "before" },
      image,
      pdf,
    ], "media"), { turnId: "turn-media" });
    const references = result.content.filter((block) => block.type === "media_reference");
    assert.equal(references.length, 2);
    assert.equal(references[0]?.type === "media_reference" && references[0].mediaType, "image");
    assert.equal(references[0]?.type === "media_reference" && references[0].detail, "high");
    assert.equal(references[1]?.type === "media_reference" && references[1].mediaType, "pdf");
    assert.equal(references[1]?.type === "media_reference" && references[1].pages, 3);
    const tool = result.content.find((block) => block.type === "tool_result");
    assert.equal(tool?.type, "tool_result");
    assert.equal(tool?.content.some((block) => block.type === "text" && block.text.includes("image omitted")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("supplemental audio and small media keep their original shape when under the cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-budget-supplemental-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 10, maxResultSizeTokens: 10 });
    const audio = textMessage("audio");
    audio.content = [{ type: "audio", source: "base64", data: "c".repeat(100), mimeType: "audio/wav", bytes: 300 }];
    const large = await budget.applyToSupplementalMessage(audio, "supplemental", { turnId: "turn-supplemental" });
    assert.equal(large.content[0]?.type, "media_reference");
    assert.equal(large.content[0]?.type === "media_reference" && large.content[0].mediaType, "audio");

    const small = textMessage("small");
    small.content = [{ type: "image", source: "base64", data: "ok", mimeType: "image/png" }];
    assert.deepEqual(await budget.applyToSupplementalMessage(small, "small"), small);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
