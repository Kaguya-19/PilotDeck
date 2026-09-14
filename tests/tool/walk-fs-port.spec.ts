import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { walkFiles } from "../../src/tool/builtin/filesystem/walk.js";
import { createNodeFsPort } from "../../src/tool/execution-world/NodeFsPort.js";
import type { FsPort } from "../../src/tool/execution-world/FsPort.js";
import { PilotDeckToolRuntimeError } from "../../src/tool/protocol/errors.js";

test("walkFiles uses an injected directory provider with stable ordering and ignored directories", async () => {
  const calls: string[] = [];
  const fs: Pick<FsPort, "readDirectory"> = {
    async readDirectory(directory) {
      calls.push(directory);
      if (directory === "/workspace") {
        return [
          { name: "z.txt", kind: "file" },
          { name: "node_modules", kind: "directory" },
          { name: "src", kind: "directory" },
          { name: "dist", kind: "directory" },
          { name: "linked-dir", kind: "other" },
          { name: "a.txt", kind: "file" },
        ];
      }
      if (directory === "/workspace/src") {
        return [
          { name: "z.ts", kind: "file" },
          { name: "a.ts", kind: "file" },
        ];
      }
      throw new Error(`unexpected directory: ${directory}`);
    },
  };

  const files = await walkFiles("/workspace", fs);

  assert.deepEqual(files, ["a.txt", "src/a.ts", "src/z.ts", "z.txt"]);
  assert.deepEqual(calls, ["/workspace", "/workspace/src"]);
});

test("walkFiles preserves provider permission errors", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const fs: Pick<FsPort, "readDirectory"> = {
    async readDirectory() {
      throw denied;
    },
  };

  await assert.rejects(walkFiles("/workspace", fs), denied);
});

test("walkFiles forwards cancellation to the directory provider", async () => {
  const controller = new AbortController();
  controller.abort();
  const fs: Pick<FsPort, "readDirectory"> = {
    async readDirectory(_directory, signal) {
      assert.equal(signal?.aborted, true);
      throw new PilotDeckToolRuntimeError("tool_aborted", "Directory walk was aborted.");
    },
  };

  await assert.rejects(
    walkFiles("/workspace", fs, controller.signal),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "tool_aborted",
  );
});

test("native FsPort lists direct entries and walkFiles keeps the established file-only behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-walk-fs-port-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "root.txt"), "root", "utf8");
    await writeFile(join(root, "src", "nested.txt"), "nested", "utf8");
    await writeFile(join(root, "dist", "ignored.txt"), "ignored", "utf8");

    const fs = createNodeFsPort();
    const entries = await fs.readDirectory(root);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ["dist", "root.txt", "src"]);
    assert.equal(entries.find((entry) => entry.name === "src")?.kind, "directory");
    assert.equal(entries.find((entry) => entry.name === "root.txt")?.kind, "file");
    assert.deepEqual(await walkFiles(root, fs), ["root.txt", "src/nested.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
