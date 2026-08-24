import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { readSessionLite, SESSION_LITE_READ_BYTES } from "../../src/session/storage/SessionLiteReader.js";

test("readSessionLite returns null for missing and empty transcript files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-session-lite-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await readSessionLite(join(root, "missing.jsonl")), null);
  const empty = join(root, "empty.jsonl");
  await writeFile(empty, "", "utf8");
  assert.equal(await readSessionLite(empty), null);
});

test("readSessionLite reads the whole small file as both head and tail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-session-lite-small-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "session.jsonl");
  await writeFile(file, "first\nsecond\n", "utf8");

  const result = await readSessionLite(file);
  assert.ok(result);
  assert.equal(result.path, file);
  assert.equal(result.size, Buffer.byteLength("first\nsecond\n"));
  assert.equal(result.head, "first\nsecond\n");
  assert.equal(result.tail, result.head);
  assert.equal(typeof result.mtime, "number");
});

test("readSessionLite keeps bounded head and tail for a large transcript", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-session-lite-large-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "large.jsonl");
  const head = "HEAD\n";
  const tail = "\nTAIL";
  await writeFile(file, `${head}${"x".repeat(SESSION_LITE_READ_BYTES + 100)}${tail}`, "utf8");

  const result = await readSessionLite(file);
  assert.ok(result);
  assert.equal(result.head.length, SESSION_LITE_READ_BYTES);
  assert.equal(result.head.startsWith(head), true);
  assert.equal(result.tail.length, SESSION_LITE_READ_BYTES);
  assert.equal(result.tail.endsWith(tail), true);
});

test("readSessionLite closes the file and returns null when a path is not readable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-session-lite-unreadable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "directory");
  await mkdir(directory);
  assert.equal(await readSessionLite(directory), null);
});
