import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { checkFilesystemWritePermission } from "../../src/tool/builtin/filesystem/writePermissions.js";
import { normalizeEditInput, normalizeQuotes, findActualString, stripTrailingWhitespace } from "../../src/tool/builtin/filesystem/editNormalization.js";
import { buildStructuredPatch, buildUnifiedDiff } from "../../src/tool/builtin/filesystem/structuredPatch.js";
import {
  getImageMimeType,
  getPathExtension,
  hasBinaryExtension,
  isBlockedDevicePath,
  isImagePath,
  isNotebookPath,
  isPdfPath,
  parsePdfPageRange,
  countPdfPages,
} from "../../src/tool/builtin/filesystem/fileTypeSafety.js";
import { readTextFile } from "../../src/tool/builtin/filesystem/readTextFile.js";
import { writeTextFile } from "../../src/tool/builtin/filesystem/writeTextFile.js";
import { readFileInRange } from "../../src/tool/builtin/filesystem/readFileInRange.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function context(cwd: string, overrides: Partial<PilotDeckToolRuntimeContext> = {}): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session",
    turnId: "turn",
    cwd,
    permissionMode: "default",
    permissionContext: { additionalWorkingDirectories: [] },
    ...overrides,
  } as PilotDeckToolRuntimeContext;
}

test("readTextFile and writeTextFile cover create, overwrite, conflict, binary and missing paths", async (t) => {
  const root = await tempDir("pilotdeck-file-helpers-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "nested", "note.txt");
  assert.equal(await writeTextFile(file, "one"), "created");
  assert.equal(await readTextFile(file), "one");
  await assert.rejects(writeTextFile(file, "two"), /already exists/);
  assert.equal(await writeTextFile(file, "two", { allowOverwrite: true }), "overwritten");
  assert.equal(await readFile(file, "utf8"), "two");
  await mkdir(join(root, "directory"));
  await assert.rejects(writeTextFile(join(root, "directory"), "x"), /not a regular file/);
  await assert.rejects(readTextFile(join(root, "directory")), /not a regular file/);
  await assert.rejects(readTextFile(join(root, "missing.txt")), /does not exist/);
  const binary = join(root, "binary.bin");
  await writeFile(binary, Buffer.from([0x41, 0x00, 0x42]));
  await assert.rejects(readTextFile(binary), /appears to be a binary file/);
});

test("filesystem write permission distinguishes workspace, outside and denied paths", async () => {
  const root = "/workspace/project";
  const workspace = checkFilesystemWritePermission("write_file", "inside.txt", context(root));
  assert.deepEqual(workspace, { type: "passthrough" });
  const outside = checkFilesystemWritePermission("edit_file", "/tmp/outside.txt", context(root));
  assert.equal(outside.type, "ask");
  if (outside.type === "ask") {
    assert.equal(outside.request.options.length, 4);
    assert.equal(outside.request.metadata?.allowedDirectory, "/tmp");
    assert.match(outside.request.inputSummary, /outside\.txt/);
  }
  const denied = checkFilesystemWritePermission("write_file", "/workspace/project/.git/config", context(root));
  assert.equal(denied.type, "deny");
  const noOutside = checkFilesystemWritePermission("write_file", "/tmp/outside.txt", context(root, {
    permissionContext: { additionalWorkingDirectories: [] },
  }));
  assert.equal(noOutside.type, "ask");
});

test("edit normalization handles smart quotes, whitespace and markdown exceptions", () => {
  assert.equal(normalizeQuotes("‘one’ “two”"), "'one' \"two\"");
  assert.equal(stripTrailingWhitespace("a  \n b\t\n"), "a\n b\n");
  assert.equal(findActualString("const value = ‘one’;", "const value = 'one';"), "const value = ‘one’;");
  assert.equal(findActualString("abc", "missing"), null);
  assert.deepEqual(normalizeEditInput("file.ts", "old", "new  \n"), { oldString: "old", newString: "new\n" });
  assert.deepEqual(normalizeEditInput("README.md", "old", "new  \n"), { oldString: "old", newString: "new  \n" });
});

test("structured patches and unified diffs handle create, no-op and contextual edits", () => {
  assert.deepEqual(buildStructuredPatch(null, "one\ntwo"), [{
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: 2,
    lines: [{ type: "add", text: "one" }, { type: "add", text: "two" }],
  }]);
  assert.deepEqual(buildStructuredPatch("same", "same"), []);
  const patch = buildStructuredPatch("a\nb\nc\nd", "a\nb\nchanged\nd");
  assert.deepEqual(patch[0]?.lines, [
    { type: "context", text: "a" },
    { type: "context", text: "b" },
    { type: "delete", text: "c" },
    { type: "add", text: "changed" },
    { type: "context", text: "d" },
  ]);
  assert.equal(buildUnifiedDiff("file.txt", "same", "same"), "");
  assert.match(buildUnifiedDiff("file.txt", null, "new"), /--- \/dev\/null\n\+\+\+ b\/file\.txt/);
  assert.match(buildUnifiedDiff("file.txt", "old", "new"), /@@ -1 \+1 @@/);
});

test("file type safety recognizes media, binary extensions, devices and PDF ranges", () => {
  assert.equal(getPathExtension("PHOTO.JPEG"), ".jpeg");
  assert.equal(getImageMimeType("photo.jpg"), "image/jpeg");
  assert.equal(isImagePath("photo.webp"), true);
  assert.equal(isImagePath("photo.txt"), false);
  assert.equal(isPdfPath("manual.PDF"), true);
  assert.equal(isNotebookPath("analysis.ipynb"), true);
  assert.equal(hasBinaryExtension("archive.zip"), true);
  assert.equal(hasBinaryExtension("photo.jpg"), false);
  assert.equal(hasBinaryExtension("manual.pdf"), false);
  assert.equal(isBlockedDevicePath("/dev/null"), false);
  assert.equal(isBlockedDevicePath("/dev/urandom"), true);
  assert.equal(isBlockedDevicePath("/proc/self/fd/1"), true);
  assert.equal(isBlockedDevicePath("\\\\.\\PhysicalDrive0"), true);
  assert.equal(isBlockedDevicePath("CON.txt"), true);
  assert.equal(isBlockedDevicePath("NUL"), true);
  assert.equal(isBlockedDevicePath("normal.txt"), false);
  assert.deepEqual(parsePdfPageRange("1"), { firstPage: 1, lastPage: 1 });
  assert.deepEqual(parsePdfPageRange("2 - 5"), { firstPage: 2, lastPage: 5 });
  assert.equal(parsePdfPageRange(""), undefined);
  assert.equal(parsePdfPageRange("0-2"), undefined);
  assert.equal(parsePdfPageRange("5-2"), undefined);
  assert.equal(parsePdfPageRange("a"), undefined);
});

test("readFileInRange handles full reads, BOMs, empty ranges, binaries and aborts", async (t) => {
  const root = await tempDir("pilotdeck-read-range-boundaries-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "text.txt");
  await writeFile(file, "\uFEFFfirst\nsecond\nthird", "utf8");
  const full = await readFileInRange(file, 0);
  assert.equal(full.content, "first\nsecond\nthird");
  assert.equal(full.fullContent, full.content);
  assert.equal(full.startLine, 1);
  assert.equal(full.endLine, 3);
  assert.equal(full.truncated, false);
  const empty = await readFileInRange(file, 99);
  assert.equal(empty.content, "");
  assert.equal(empty.startLine, 4);
  assert.equal(empty.endLine, 3);
  const binary = join(root, "binary");
  await writeFile(binary, Buffer.from([0x01, 0x00, 0x02]));
  await assert.rejects(readFileInRange(binary, 1), /appears to be a binary file/);
  await assert.rejects(readFileInRange(join(root, "missing"), 1), /does not exist/);
  await mkdir(join(root, "dir"));
  await assert.rejects(readFileInRange(join(root, "dir"), 1), /not a regular file/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readFileInRange(file, 1, undefined, controller.signal), /File reading was aborted/);
  assert.equal(await countPdfPages(Buffer.from("not a pdf")), undefined);
});
