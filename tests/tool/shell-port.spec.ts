import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBashTool } from "../../src/tool/builtin/bash.js";
import { createNodeSandboxPort } from "../../src/tool/execution-world/NodeSandboxPort.js";
import {
  createNodeSandboxedShellPort,
} from "../../src/tool/execution-world/SandboxedShellPort.js";
import type { SandboxPort } from "../../src/tool/execution-world/SandboxPort.js";
import type { ShellPort } from "../../src/tool/execution-world/ShellPort.js";
import { createNodeShellPort } from "../../src/tool/execution-world/ShellPort.js";
import { createNodeSubprocessPort, type SubprocessPort } from "../../src/tool/execution-world/SubprocessPort.js";

test("bash consumes the narrower shell provider seam", async () => {
  const calls: unknown[] = [];
  const shell: ShellPort = {
    async execute(request) {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: "shell stdout\n",
        stderr: "",
        timedOut: false,
        durationMs: 3,
      };
    },
  };

  const tool = createBashTool({ shell });
  const result = await tool.execute(
    { command: "echo shell", timeout: 321 },
    {
      sessionId: "session-1",
      turnId: "turn-1",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: {
        mode: "bypassPermissions",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: true,
        bypassAvailable: true,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
  );

  assert.equal(result.data?.stdout, "shell stdout\n");
  assert.deepEqual(calls, [{
    command: "echo shell",
    cwd: process.cwd(),
    env: undefined,
    timeoutMs: 321,
    signal: undefined,
    onStdout: undefined,
    onStderr: undefined,
  }]);
});

test("native shell provider preserves shell expansion semantics", async () => {
  const result = await createNodeShellPort().execute({
    command: "printf '%s' \"$PILOTDECK_SHELL_PORT_TEST\"",
    cwd: process.cwd(),
    env: { ...process.env, PILOTDECK_SHELL_PORT_TEST: "expanded" },
    timeoutMs: 5_000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "expanded");
  assert.equal(result.timedOut, false);
});

test("native shell provider tolerates a command that closes stdin before runner cleanup", async () => {
  const result = await createNodeShellPort().execute({
    command: "exec 0<&-; printf '%s' stdin-closed",
    cwd: process.cwd(),
    stdin: "input that may race the command exit",
    timeoutMs: 5_000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "stdin-closed");
  assert.equal(result.timedOut, false);
});

test("sandboxed shell confines the exact inner shell argv through the direct subprocess seam", async () => {
  const prepared: Array<{ executable: string; args: readonly string[]; policy: unknown }> = [];
  const dispatched: unknown[] = [];
  const sandbox: SandboxPort = {
    async prepare(request) {
      prepared.push(request);
      return {
        executable: "/sandbox-exec",
        args: ["--", request.executable, ...request.args],
        cwd: request.cwd,
        env: request.env,
      };
    },
  };
  const subprocess: Pick<SubprocessPort, "executeFile"> = {
    async executeFile(request) {
      dispatched.push(request);
      return { exitCode: 0, stdout: "sandboxed\n", stderr: "", timedOut: false, durationMs: 1 };
    },
  };
  const shell = createNodeSandboxedShellPort({
    sandbox,
    subprocess,
    platform: "darwin",
    resolvePolicy: ({ workspaceRoot }) => ({ mode: "read-only", workspaceRoot }),
  });

  const result = await shell.execute({
    command: "printf '%s' sandboxed",
    cwd: "/workspace",
    env: { TEST: "1" },
    timeoutMs: 456,
  });

  assert.equal(result.stdout, "sandboxed\n");
  assert.deepEqual(prepared, [{
    executable: "/bin/sh",
    args: ["-c", "printf '%s' sandboxed"],
    cwd: "/workspace",
    env: { TEST: "1" },
    policy: { mode: "read-only", workspaceRoot: "/workspace" },
    signal: undefined,
  }]);
  assert.deepEqual(dispatched, [{
    executable: "/sandbox-exec",
    args: ["--", "/bin/sh", "-c", "printf '%s' sandboxed"],
    cwd: "/workspace",
    env: { TEST: "1" },
    timeoutMs: 456,
    signal: undefined,
    stdin: undefined,
    onStdout: undefined,
    onStderr: undefined,
  }]);
});

test("sandboxed shell fails closed when the direct executable capability is absent", async () => {
  const shell = createNodeSandboxedShellPort({
    sandbox: { async prepare(request) { return request; } },
    subprocess: {},
    resolvePolicy: ({ workspaceRoot }) => ({ mode: "read-only", workspaceRoot }),
  });

  await assert.rejects(
    shell.execute({ command: "true", cwd: process.cwd(), timeoutMs: 1_000 }),
    /direct-executable subprocess provider/,
  );
});

test("macOS sandboxed shell denies read-only writes and permits workspace-write", { skip: process.platform !== "darwin" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sandboxed-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sandbox = createNodeSandboxPort();
  const readOnly = createNodeSandboxedShellPort({
    sandbox,
    subprocess: createNodeSubprocessPort(),
    resolvePolicy: ({ workspaceRoot }) => ({ mode: "read-only", workspaceRoot }),
  });

  const denied = await readOnly.execute({ command: "touch read-only.txt", cwd: root, timeoutMs: 5_000 });
  assert.notEqual(denied.exitCode, 0);
  assert.equal(existsSync(join(root, "read-only.txt")), false);

  const workspaceWrite = createNodeSandboxedShellPort({
    sandbox,
    subprocess: createNodeSubprocessPort(),
    resolvePolicy: ({ workspaceRoot }) => ({ mode: "workspace-write", workspaceRoot }),
  });
  const allowed = await workspaceWrite.execute({ command: "touch workspace-write.txt", cwd: root, timeoutMs: 5_000 });
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  assert.equal(existsSync(join(root, "workspace-write.txt")), true);
});
