import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskOutputStore } from "../../src/task/storage/TaskOutputStore.js";

test("TaskOutputStore reads bounded slices and reports truncation", () => {
  const store = new TaskOutputStore({ taskId: "task", maxMemoryBytes: 5 });
  store.append("abc");
  store.append("def");

  assert.equal(store.totalBytes(), 6);
  assert.deepEqual(store.readSlice(0), {
    content: "def",
    nextOffset: 6,
    totalBytes: 6,
    truncated: true,
  });
  assert.deepEqual(store.readSlice(4, 1), {
    content: "e",
    nextOffset: 5,
    totalBytes: 6,
    truncated: false,
  });
  assert.equal(store.readSlice(6).content, "");
  store.close();
  assert.equal(store.readSlice(0).content, "");
});

test("TaskOutputStore spills asynchronously without changing the memory cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-task-output-"));
  try {
    const store = new TaskOutputStore({ taskId: "task", maxMemoryBytes: 2, diskSpillDir: dir });
    store.append("hello");
    let spilled = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        spilled = (await readFile(join(dir, "task.log"))).toString();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    assert.equal(spilled, "hello");
    assert.equal(store.totalBytes(), 5);
    assert.equal(store.readSlice(0).truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
