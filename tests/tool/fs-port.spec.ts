import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import type { FsPort } from "../../src/tool/execution-world/FsPort.js";
import { createNodeFsPort } from "../../src/tool/execution-world/NodeFsPort.js";
import { createNodeSandboxedFsPort } from "../../src/tool/execution-world/SandboxedFsPort.js";

function context(cwd: string) {
  return {
    sessionId: "fs-session",
    turnId: "fs-turn",
    cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

test("read_file consumes an injected filesystem provider for metadata and ranges", async () => {
  const calls: string[] = [];
  const fs: FsPort = {
    async stat(path) {
      calls.push(`stat:${path}`);
      return { kind: "file", size: 11, mtimeMs: 1 };
    },
    async readDirectory() {
      throw new Error("not used");
    },
    async readFile(path, options) {
      calls.push(`read:${path}:${options?.encoding ?? "bytes"}`);
      return "alpha\nbeta\n";
    },
    async readFileInRange(path, startLine, limit) {
      calls.push(`range:${path}:${startLine}:${limit ?? "all"}`);
      return {
        content: "alpha\nbeta",
        fullContent: "alpha\nbeta\n",
        lineCount: 2,
        totalLines: 3,
        totalBytes: 11,
        readBytes: 10,
        mtimeMs: 1,
        startLine,
        endLine: startLine + 1,
        truncated: false,
      };
    },
    async writeText() {
      throw new Error("not used");
    },
  };

  const result = await createReadFileTool({ fs }).execute(
    { file_path: "sample.txt", offset: 1, limit: 2 },
    context("/workspace"),
  );

  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /1\|alpha/);
  assert.deepEqual(calls, [
    "stat:/workspace/sample.txt",
    "range:/workspace/sample.txt:1:2",
  ]);
});

test("native FsPort preserves file metadata and text/bytes read contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fs-port-"));
  try {
    const filePath = join(root, "sample.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf8");
    const fs = createNodeFsPort();

    const metadata = await fs.stat(filePath);
    const text = await fs.readFile(filePath, { encoding: "utf8" });
    const bytes = await fs.readFile(filePath);

    assert.equal(metadata.kind, "file");
    assert.equal(metadata.size, Buffer.byteLength("alpha\nbeta\n", "utf8"));
    assert.equal(typeof text, "string");
    assert.equal(text, "alpha\nbeta\n");
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(Buffer.from(bytes).toString("utf8"), "alpha\nbeta\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write_file and edit_file consume an injected filesystem provider with the resolved workspace", async () => {
  const writes: Array<{ path: string; content: string; allowOverwrite?: boolean; workspaceRoot?: string }> = [];
  const fs: FsPort = {
    async stat(path) {
      if (path.endsWith("existing.txt")) {
        return { kind: "file", size: 6, mtimeMs: 7 };
      }
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    },
    async readDirectory() {
      throw new Error("not used");
    },
    async readFile(path) {
      return path.endsWith("existing.txt") ? "before" : new Uint8Array();
    },
    async readFileInRange() {
      throw new Error("not used");
    },
    async writeText(path, content, options) {
      writes.push({
        path,
        content,
        allowOverwrite: options?.allowOverwrite,
        workspaceRoot: options?.workspaceRoot,
      });
      return { action: path.endsWith("existing.txt") ? "overwritten" : "created", mtimeMs: 9 };
    },
  };
  const cwd = "/workspace";
  const runtimeContext = {
    ...context(cwd),
    writeSnapshots: new Map([["/workspace/existing.txt", {
      absolutePath: "/workspace/existing.txt",
      mtimeMs: 7,
      contentHash: "unused-for-matching-mtime",
      offset: 1,
      limit: 1,
    }]]),
  };

  const write = await createWriteFileTool({ fs }).execute(
    { file_path: "new.txt", content: "new" },
    runtimeContext,
  );
  const edit = await createEditFileTool({ fs }).execute(
    { file_path: "existing.txt", old_string: "before", new_string: "after" },
    runtimeContext,
  );

  assert.match(write.content[0]?.type === "text" ? write.content[0].text : "", /Created new\.txt/);
  assert.match(edit.content[0]?.type === "text" ? edit.content[0].text : "", /Updated existing\.txt/);
  assert.deepEqual(writes, [
    { path: "/workspace/new.txt", content: "new", allowOverwrite: true, workspaceRoot: "/workspace" },
    { path: "/workspace/existing.txt", content: "after", allowOverwrite: true, workspaceRoot: "/workspace" },
  ]);
});

test("sandboxed FsPort denies read-only writes and canonicalizes workspace-write targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sandboxed-fs-root-"));
  const outside = await mkdtemp(join(process.cwd(), "pilotdeck-sandboxed-fs-outside-"));
  try {
    const readOnly = createNodeSandboxedFsPort({
      fs: createNodeFsPort(),
      sandboxMode: "read-only",
    });
    await assert.rejects(
      readOnly.writeText(join(root, "denied.txt"), "no", { workspaceRoot: root }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "permission_denied",
    );

    const workspaceWrite = createNodeSandboxedFsPort({
      fs: createNodeFsPort(),
      sandboxMode: "workspace-write",
    });
    const allowed = join(root, "nested", "allowed.txt");
    await workspaceWrite.writeText(allowed, "ok", { workspaceRoot: root });
    assert.equal(await readFile(allowed, "utf8"), "ok");

    await assert.rejects(
      workspaceWrite.writeText(join(outside, "outside.txt"), "no", { workspaceRoot: root }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "permission_denied",
    );

    await symlink(outside, join(root, "escape"));
    await assert.rejects(
      workspaceWrite.writeText(join(root, "escape", "through-link.txt"), "no", { workspaceRoot: root }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "permission_denied",
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
