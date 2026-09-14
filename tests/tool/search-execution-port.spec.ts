import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createGrepTool } from "../../src/tool/builtin/grep.js";
import { runRipgrep } from "../../src/tool/builtin/filesystem/ripgrep.js";
import type { FsPort } from "../../src/tool/execution-world/FsPort.js";
import type { SubprocessPort } from "../../src/tool/execution-world/SubprocessPort.js";
import { PilotDeckToolRuntimeError } from "../../src/tool/protocol/errors.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";

function context(cwd: string) {
  return {
    sessionId: "search-session",
    turnId: "search-turn",
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

function createFs(stats: Record<string, { kind: "file" | "directory" | "other"; mtimeMs: number }>): FsPort {
  return {
    async stat(filePath) {
      const entry = stats[filePath];
      if (!entry) throw Object.assign(new Error(`missing: ${filePath}`), { code: "ENOENT" });
      return { ...entry, size: 0 };
    },
    async readDirectory() {
      throw new Error("not used");
    },
    async readFile() {
      throw new Error("not used");
    },
    async readFileInRange() {
      throw new Error("not used");
    },
    async writeText() {
      throw new Error("not used");
    },
  };
}

test("glob consumes injected FsPort for backslash disambiguation and subprocess for search", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-glob-port-"));
  try {
    const requests: Array<Parameters<NonNullable<SubprocessPort["executeFile"]>>[0]> = [];
    const fs = createFs({ [join(root, "src")]: { kind: "directory", mtimeMs: 1 } });
    const subprocess: Pick<SubprocessPort, "executeFile"> = {
      async executeFile(request) {
        requests.push(request);
        return { exitCode: 0, stdout: "a.ts\nz.ts\n", stderr: "", timedOut: false, durationMs: 1 };
      },
    };

    const glob = createBuiltinRegistry({
      fs,
      subprocess: subprocess as SubprocessPort,
      agent: false,
      askUserQuestion: false,
      planMode: false,
      structuredOutput: false,
      webFetch: false,
      webSearch: false,
    }).get("glob");
    assert.ok(glob);
    const result = await glob.execute(
      { pattern: "src\\*.ts" },
      context(root),
    );

    assert.deepEqual(result.data, { files: ["a.ts", "z.ts"], count: 2, truncated: false });
    assert.equal(requests.length, 1);
    assert.ok(requests[0]?.args.includes("src/*.ts"));
    assert.equal(requests[0]?.cwd, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grep consumes injected providers for target classification and modified-time ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-grep-port-"));
  try {
    const fs = createFs({
      [root]: { kind: "directory", mtimeMs: 1 },
      [join(root, "a.ts")]: { kind: "file", mtimeMs: 1 },
      [join(root, "z.ts")]: { kind: "file", mtimeMs: 2 },
    });
    const requests: Array<Parameters<NonNullable<SubprocessPort["executeFile"]>>[0]> = [];
    const subprocess: Pick<SubprocessPort, "executeFile"> = {
      async executeFile(request) {
        requests.push(request);
        return { exitCode: 0, stdout: "a.ts\nz.ts\n", stderr: "", timedOut: false, durationMs: 1 };
      },
    };

    const result = await createGrepTool({ fs, subprocess }).execute(
      { pattern: "needle" },
      context(root),
    );

    assert.deepEqual(result.data, {
      mode: "files_with_matches",
      files: ["z.ts", "a.ts"],
      count: 2,
      truncated: false,
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.args.slice(-2), ["needle", "."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ripgrep provider results preserve empty, timeout, and abort semantics", async () => {
  const empty: Pick<SubprocessPort, "executeFile"> = {
    async executeFile() {
      return { exitCode: 1, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
    },
  };
  assert.equal(await runRipgrep({ cwd: process.cwd(), args: ["needle", "."], subprocess: empty, toolName: "grep" }), "");

  const timeout: Pick<SubprocessPort, "executeFile"> = {
    async executeFile() {
      return { exitCode: null, stdout: "partial", stderr: "", timedOut: true, durationMs: 20_000 };
    },
  };
  await assert.rejects(
    runRipgrep({ cwd: process.cwd(), args: ["needle", "."], subprocess: timeout, toolName: "grep" }),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "tool_timeout",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runRipgrep({
      cwd: process.cwd(),
      args: ["needle", "."],
      signal: controller.signal,
      subprocess: empty,
      toolName: "grep",
    }),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "tool_aborted",
  );

  const signalled: Pick<SubprocessPort, "executeFile"> = {
    async executeFile() {
      return { exitCode: null, exitSignal: "SIGTERM", stdout: "", stderr: "", timedOut: false, durationMs: 1 };
    },
  };
  await assert.rejects(
    runRipgrep({ cwd: process.cwd(), args: ["needle", "."], subprocess: signalled, toolName: "grep" }),
    /exited via signal SIGTERM/,
  );

  await assert.rejects(
    runRipgrep({ cwd: process.cwd(), args: ["needle", "."], subprocess: {}, toolName: "grep" }),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "unsupported_tool",
  );
});
