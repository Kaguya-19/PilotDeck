import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import {
  createExecutionWorldBundle,
  createNodeExecutionWorldBundle,
} from "../../src/tool/execution-world/ExecutionWorldBundle.js";
import { DEFAULT_SANDBOX_MODE } from "../../src/tool/execution-world/SandboxPort.js";
import type { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import type { AttachmentDeliveryPort } from "../../src/tool/execution-world/AttachmentDeliveryPort.js";
import type { CodeRuntimePort } from "../../src/tool/execution-world/CodeRuntimePort.js";
import type { DetachedShellPort } from "../../src/tool/execution-world/DetachedShellPort.js";
import type { ExecutionTransportPort } from "../../src/tool/execution-world/ExecutionTransportPort.js";
import type { ExecutionWorkspacePort } from "../../src/tool/execution-world/ExecutionWorkspacePort.js";
import type { FsPort } from "../../src/tool/execution-world/FsPort.js";
import type { PlanStoragePort } from "../../src/tool/execution-world/PlanStoragePort.js";
import type { SandboxPort } from "../../src/tool/execution-world/SandboxPort.js";
import type { ShellPort } from "../../src/tool/execution-world/ShellPort.js";
import type { SubprocessPort } from "../../src/tool/execution-world/SubprocessPort.js";

test("execution-world bundle disposes each owned provider exactly once", async () => {
  let codeDisposals = 0;
  let taskDisposals = 0;
  const bundle = createExecutionWorldBundle(parts({
    codeRuntime: {
      async resolveExecutable() { return undefined; },
      async run() { throw new Error("not used"); },
      async dispose() { codeDisposals += 1; },
    },
    backgroundTasks: {
      async dispose() { taskDisposals += 1; },
    } as unknown as BackgroundTaskRuntime,
  }));

  await Promise.all([bundle.dispose(), bundle.dispose(), bundle.dispose()]);

  assert.equal(codeDisposals, 1);
  assert.equal(taskDisposals, 1);
});

test("execution-world bundle drains both providers when disposal reports failures", async () => {
  let codeDisposals = 0;
  let taskDisposals = 0;
  const bundle = createExecutionWorldBundle(parts({
    codeRuntime: {
      async resolveExecutable() { return undefined; },
      async run() { throw new Error("not used"); },
      async dispose() {
        codeDisposals += 1;
        throw new Error("code dispose failed");
      },
    },
    backgroundTasks: {
      async dispose() {
        taskDisposals += 1;
        throw new Error("task dispose failed");
      },
    } as unknown as BackgroundTaskRuntime,
  }));

  await assert.rejects(bundle.dispose(), AggregateError);
  await assert.rejects(bundle.dispose(), AggregateError);

  assert.equal(codeDisposals, 1);
  assert.equal(taskDisposals, 1);
});

test("node execution-world bundle carries its selected sandbox profile to execute_code", async () => {
  const bundle = createNodeExecutionWorldBundle({ sandboxMode: "read-only" });
  try {
    assert.deepEqual(
      bundle.executeCodeSandbox.resolvePolicy({ workspaceRoot: "/workspace", executionRoot: "/execution" }),
      { mode: "read-only", workspaceRoot: "/workspace", executionRoot: "/execution" },
    );
  } finally {
    await bundle.dispose();
  }
});

test("node execution-world bundle preserves the direct native sandbox default", async () => {
  const bundle = createNodeExecutionWorldBundle();
  try {
    assert.equal(
      bundle.executeCodeSandbox.resolvePolicy({ workspaceRoot: "/workspace", executionRoot: "/execution" }).mode,
      DEFAULT_SANDBOX_MODE,
    );
  } finally {
    await bundle.dispose();
  }
});

test("node execution-world bundle confines foreground shell in read-only mode", { skip: process.platform !== "darwin" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-execution-world-"));
  const bundle = createNodeExecutionWorldBundle({ sandboxMode: "read-only" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(async () => { await bundle.dispose(); });

  const result = await bundle.shell.execute({
    command: "touch denied-by-bundle.txt",
    cwd: root,
    timeoutMs: 5_000,
  });

  assert.notEqual(result.exitCode, 0);
  assert.equal(existsSync(join(root, "denied-by-bundle.txt")), false);
});

test("node execution-world bundle confines detached background tasks in read-only mode", { skip: process.platform !== "darwin" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-execution-world-background-"));
  const bundle = createNodeExecutionWorldBundle({ sandboxMode: "read-only" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(async () => { await bundle.dispose(); });

  const task = await bundle.backgroundTasks.start({
    command: "touch denied-background.txt",
    cwd: root,
  });
  const settled = await bundle.backgroundTasks.waitFor(task.taskId);

  assert.equal(settled.status, "failed");
  assert.equal(existsSync(join(root, "denied-background.txt")), false);
});

test("node execution-world bundle confines write_file in read-only mode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-execution-world-fs-"));
  const bundle = createNodeExecutionWorldBundle({ sandboxMode: "read-only" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(async () => { await bundle.dispose(); });

  await assert.rejects(
    createWriteFileTool({ fs: bundle.fs }).execute(
      { file_path: "denied-by-bundle.txt", content: "no" },
      toolContext(root),
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "permission_denied",
  );
  assert.equal(existsSync(join(root, "denied-by-bundle.txt")), false);
});

test("node execution-world bundle permits write_file in workspace-write mode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-execution-world-fs-write-"));
  const bundle = createNodeExecutionWorldBundle({ sandboxMode: "workspace-write" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(async () => { await bundle.dispose(); });

  const result = await createWriteFileTool({ fs: bundle.fs }).execute(
    { file_path: "allowed-by-bundle.txt", content: "ok" },
    toolContext(root),
  );

  assert.equal(result.data?.type, "create");
  assert.equal(existsSync(join(root, "allowed-by-bundle.txt")), true);
});

function toolContext(cwd: string) {
  return {
    sessionId: "execution-world-session",
    turnId: "execution-world-turn",
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

function parts(overrides: {
  codeRuntime: CodeRuntimePort;
  backgroundTasks: BackgroundTaskRuntime;
}) {
  return {
    fs: {} as FsPort,
    subprocess: {} as SubprocessPort,
    shell: {} as ShellPort,
    detachedShell: {} as DetachedShellPort,
    attachmentDelivery: {} as AttachmentDeliveryPort,
    planStorage: {} as PlanStoragePort,
    executionWorkspace: {} as ExecutionWorkspacePort,
    codeRuntime: overrides.codeRuntime,
    executionTransport: {} as ExecutionTransportPort,
    executeCodeSandbox: {
      port: {} as SandboxPort,
      resolvePolicy: ({ workspaceRoot, executionRoot }: { workspaceRoot: string; executionRoot: string }) => ({
        mode: "danger-full-access" as const,
        workspaceRoot,
        executionRoot,
      }),
    },
    backgroundTasks: overrides.backgroundTasks,
  };
}
