import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEditNotebookTool, type EditNotebookInput } from "../../src/tool/builtin/editNotebook.js";
import type { FsPort } from "../../src/tool/execution-world/FsPort.js";
import { createNodeFsPort } from "../../src/tool/execution-world/NodeFsPort.js";
import { recordWriteSnapshot } from "../../src/tool/builtin/filesystem/writeSnapshots.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

function createContext(cwd: string): PilotDeckToolRuntimeContext {
  return {
    sessionId: "notebook-session",
    turnId: "notebook-turn",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function createMemoryFs(filePath: string, initialContent: string, initialMtime = 7): {
  fs: FsPort;
  calls: string[];
  getContent(): string;
  setMtime(value: number): void;
} {
  let content = initialContent;
  let mtimeMs = initialMtime;
  const calls: string[] = [];

  const fs: FsPort = {
    async stat(path) {
      calls.push(`stat:${path}`);
      if (path !== filePath) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { kind: "file", size: Buffer.byteLength(content, "utf8"), mtimeMs };
    },
    async readDirectory() {
      throw new Error("not used");
    },
    async readFile(path, options) {
      calls.push(`read:${path}:${options?.encoding ?? "bytes"}`);
      if (path !== filePath) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return options?.encoding === "utf8" ? content : new TextEncoder().encode(content);
    },
    async readFileInRange() {
      throw new Error("not used");
    },
    async writeText(path, nextContent, options) {
      calls.push(`write:${path}:${options?.allowOverwrite ? "overwrite" : "create"}`);
      assert.equal(path, filePath);
      assert.equal(options?.allowOverwrite, true);
      content = nextContent;
      mtimeMs += 1;
      return { action: "overwritten", mtimeMs };
    },
  };

  return {
    fs,
    calls,
    getContent: () => content,
    setMtime: (value) => {
      mtimeMs = value;
    },
  };
}

async function setupNotebook(initialContent: string): Promise<{
  root: string;
  filePath: string;
  context: PilotDeckToolRuntimeContext;
  fake: ReturnType<typeof createMemoryFs>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-edit-notebook-"));
  const filePath = join(root, "sample.ipynb");
  // The real placeholder lets path safety verify the workspace, while all
  // notebook content and mutations are served by the injected provider.
  await writeFile(filePath, "native placeholder", "utf8");
  const context = createContext(root);
  const fake = createMemoryFs(filePath, initialContent);
  recordWriteSnapshot(context, filePath, initialContent, 7);
  return { root, filePath, context, fake };
}

function notebookJson(cells: unknown[]): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 4,
    metadata: { language_info: { name: "python" } },
    cells,
  });
}

async function validateAndExecute(
  input: EditNotebookInput,
  context: PilotDeckToolRuntimeContext,
  fs: FsPort,
) {
  const tool = createEditNotebookTool({ fs });
  const validation = await tool.validateInput?.(input, context);
  assert.equal(validation?.ok, true);
  return tool.execute(input, context);
}

test("edit_notebook uses the injected FsPort for replace, insert, and delete", async () => {
  const initial = notebookJson([
    { cell_type: "code", source: "print('old')", metadata: {}, execution_count: 1, outputs: [] },
    { cell_type: "markdown", source: "notes", metadata: {} },
  ]);
  const { root, filePath, context, fake } = await setupNotebook(initial);
  try {
    const replace = await validateAndExecute(
      { notebook_path: "sample.ipynb", cell_id: "cell-0", new_source: "print('new')" },
      context,
      fake.fs,
    );
    assert.equal(replace.data?.edit_mode, "replace");
    assert.equal(JSON.parse(fake.getContent()).cells[0].source, "print('new')");

    recordWriteSnapshot(context, filePath, fake.getContent(), 8);
    const insert = await validateAndExecute(
      {
        notebook_path: "sample.ipynb",
        cell_id: "cell-0",
        new_source: "inserted",
        cell_type: "markdown",
        edit_mode: "insert",
      },
      context,
      fake.fs,
    );
    assert.equal(insert.data?.edit_mode, "insert");
    assert.equal(JSON.parse(fake.getContent()).cells[1].source, "inserted");

    recordWriteSnapshot(context, filePath, fake.getContent(), 9);
    const remove = await validateAndExecute(
      { notebook_path: "sample.ipynb", cell_id: "cell-1", new_source: "", edit_mode: "delete" },
      context,
      fake.fs,
    );
    assert.equal(remove.data?.edit_mode, "delete");
    assert.equal(JSON.parse(fake.getContent()).cells.length, 2);
    assert.ok(fake.calls.some((call) => call.startsWith(`read:${filePath}:utf8`)));
    assert.ok(fake.calls.some((call) => call.startsWith(`write:${filePath}:overwrite`)));
    assert.equal(await readFile(filePath, "utf8"), "native placeholder");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_notebook rejects a stale snapshot before reading or writing", async () => {
  const initial = notebookJson([{ cell_type: "code", source: "old", metadata: {}, outputs: [] }]);
  const { root, filePath, context, fake } = await setupNotebook(initial);
  try {
    recordWriteSnapshot(context, filePath, initial, 7, { offset: 1, limit: 1 });
    fake.setMtime(12);
    const tool = createEditNotebookTool({ fs: fake.fs });
    const validation = await tool.validateInput?.(
      { notebook_path: "sample.ipynb", cell_id: "cell-0", new_source: "new" },
      context,
    );
    assert.equal(validation?.ok, false);
    assert.match(validation?.ok === false ? validation.issues[0]?.message ?? "" : "", /changed since the last read/);
    assert.equal(fake.calls.filter((call) => call.startsWith("read:")).length, 0);
    assert.equal(fake.calls.filter((call) => call.startsWith("write:")).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_notebook preserves JSON and non-text provider errors", async () => {
  const { root, context, fake } = await setupNotebook("not json");
  try {
    const tool = createEditNotebookTool({ fs: fake.fs });
    assert.ok(tool.validateInput);
    await assert.rejects(
      tool.validateInput(
        { notebook_path: "sample.ipynb", cell_id: "cell-0", new_source: "new" },
        context,
      ),
      /Notebook is not valid JSON/,
    );

    const bytesContext = createContext(root);
    recordWriteSnapshot(bytesContext, join(root, "sample.ipynb"), "{}", 7);
    const bytesFs: FsPort = {
      ...fake.fs,
      async readFile(path) {
        return new TextEncoder().encode("{}");
      },
    };
    const bytesTool = createEditNotebookTool({ fs: bytesFs });
    assert.ok(bytesTool.validateInput);
    await assert.rejects(
      bytesTool.validateInput(
        { notebook_path: "sample.ipynb", cell_id: "cell-0", new_source: "new" },
        bytesContext,
      ),
      /is not text/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_notebook native provider preserves the standard replacement output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-edit-notebook-native-"));
  try {
    const filePath = join(root, "sample.ipynb");
    const initial = notebookJson([{ cell_type: "code", source: "old", metadata: {}, outputs: [] }]);
    await writeFile(filePath, initial, "utf8");
    const context = createContext(root);
    recordWriteSnapshot(context, filePath, initial, Math.floor((await createNodeFsPort().stat(filePath)).mtimeMs));
    const result = await validateAndExecute(
      { notebook_path: "sample.ipynb", cell_id: "cell-0", new_source: "new" },
      context,
      createNodeFsPort(),
    );
    assert.equal(result.data?.edit_mode, "replace");
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).cells[0].source, "new");
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Updated notebook cell/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_notebook rejects a directory from the injected provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-edit-notebook-directory-"));
  try {
    const directoryPath = join(root, "sample.ipynb");
    const context = createContext(root);
    const fs: FsPort = {
      async stat() {
        return { kind: "directory", size: 0, mtimeMs: 1 };
      },
      async readDirectory() {
        throw new Error("not used");
      },
      async readFile() {
        throw new Error("read should not happen");
      },
      async readFileInRange() {
        throw new Error("not used");
      },
      async writeText() {
        throw new Error("write should not happen");
      },
    };
    // The path must exist for the safety check, but provider metadata decides its type.
    await mkdir(directoryPath);
    recordWriteSnapshot(context, directoryPath, "", 1);
    const tool = createEditNotebookTool({ fs });
    assert.ok(tool.validateInput);
    await assert.rejects(
      tool.validateInput(
        { notebook_path: "sample.ipynb", cell_id: "cell-0", new_source: "new" },
        context,
      ),
      /not a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
