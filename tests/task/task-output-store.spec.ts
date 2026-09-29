import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskOutputStore } from "../../src/task/storage/TaskOutputStore.js";

test("task output store reads spilled history before its retained in-memory window", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-task-output-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = new TaskOutputStore({
    taskId: "task-history",
    diskSpillDir: root,
    maxMemoryBytes: 4,
  });
  output.append("abcdefgh");
  await output.flush();

  assert.deepEqual(output.readSlice(0, 3), {
    content: "abc",
    nextOffset: 3,
    totalBytes: 8,
    truncated: false,
  });
  assert.deepEqual(output.readSlice(3, 3), {
    content: "def",
    nextOffset: 6,
    totalBytes: 8,
    truncated: false,
  });
  assert.deepEqual(output.readSlice(6, 3), {
    content: "gh",
    nextOffset: 8,
    totalBytes: 8,
    truncated: false,
  });

  const restored = new TaskOutputStore({
    taskId: "task-history",
    diskSpillDir: root,
    maxMemoryBytes: 4,
    restore: { expectedTotalBytes: 8 },
  });
  assert.deepEqual(restored.readSlice(0, 8), {
    content: "abcdefgh",
    nextOffset: 8,
    totalBytes: 8,
    truncated: false,
  });
  await Promise.all([output.close(), restored.close()]);
});
