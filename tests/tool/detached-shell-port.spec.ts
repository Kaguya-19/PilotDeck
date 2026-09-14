import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import {
  BackgroundTaskSnapshotRecoveryError,
  JsonFileBackgroundTaskSnapshotStore,
} from "../../src/task/storage/BackgroundTaskSnapshotStore.js";
import { createNodeSandboxPort } from "../../src/tool/execution-world/NodeSandboxPort.js";
import type {
  DetachedShellHandle,
  DetachedShellPort,
} from "../../src/tool/execution-world/DetachedShellPort.js";
import { createNodeSandboxedDetachedShellPort } from "../../src/tool/execution-world/SandboxedDetachedShellPort.js";
import { SandboxUnavailableError, type SandboxPort } from "../../src/tool/execution-world/SandboxPort.js";

function fakeShell(): {
  port: DetachedShellPort;
  handles: DetachedShellHandle[];
  emitExit: (index: number, exitCode: number | null, exitSignal?: NodeJS.Signals | null) => void;
} {
  const handles: DetachedShellHandle[] = [];
  const exits: Array<(value: { exitCode: number | null; exitSignal: NodeJS.Signals | null }) => void> = [];
  const port: DetachedShellPort = {
    async start(request) {
      request.onStdout?.("provider output\n");
      const index = handles.length;
      const exit = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
        exits[index] = resolve;
      });
      const handle: DetachedShellHandle = {
        pid: 9000 + index,
        exit,
        terminate() {
          request.onStderr?.("terminated\n");
        },
      };
      handles.push(handle);
      return handle;
    },
  };
  return {
    port,
    handles,
    emitExit(index, exitCode, exitSignal = null) {
      exits[index]?.({ exitCode, exitSignal });
    },
  };
}

test("background task runtime consumes a detached shell provider", async () => {
  const fake = fakeShell();
  const runtime = new BackgroundTaskRuntime({ shell: fake.port });
  const task = await runtime.start({ command: "echo provider", cwd: process.cwd() });

  assert.equal(task.status, "running");
  assert.equal(task.pid, 9000);
  assert.equal(runtime.getOutput(task.taskId, 0).content, "provider output\n");

  fake.emitExit(0, 0);
  const completed = await runtime.waitFor(task.taskId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.exitCode, 0);
});

test("background task stop uses provider-owned termination", async () => {
  const fake = fakeShell();
  const runtime = new BackgroundTaskRuntime({ shell: fake.port });
  const task = await runtime.start({ command: "sleep 10", cwd: process.cwd() });

  const stopping = runtime.stop(task.taskId, { graceMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2));
  fake.emitExit(0, null, "SIGTERM");
  await stopping;

  assert.equal(fake.handles[0]?.pid, 9000);
  assert.equal((await runtime.waitFor(task.taskId)).status, "cancelled");
});

test("background task runtime stops new tasks and drains provider-owned children on dispose", async () => {
  const fake = fakeShell();
  const runtime = new BackgroundTaskRuntime({ shell: fake.port });
  const task = await runtime.start({ command: "sleep 10", cwd: process.cwd() });

  const disposing = runtime.dispose();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await assert.rejects(
    runtime.start({ command: "late", cwd: process.cwd() }),
    /draining/,
  );
  fake.emitExit(0, null, "SIGTERM");
  await disposing;

  assert.equal((await runtime.waitFor(task.taskId)).status, "cancelled");
  await runtime.dispose();
});

test("background task completion observers are session-aware, isolated, and disposable", async () => {
  const fake = fakeShell();
  const diagnostics: unknown[] = [];
  const runtime = new BackgroundTaskRuntime({
    shell: fake.port,
    onCompletionSubscriberError: (error) => diagnostics.push(error),
  });
  const observed: import("../../src/task/index.js").BackgroundTaskCompletionEvent[] = [];
  runtime.subscribeCompletionEvents(() => {
    throw new Error("observer failed");
  });
  const subscription = runtime.subscribeCompletionEvents((event) => observed.push(event));

  const task = await runtime.start({
    command: "echo completion",
    cwd: process.cwd(),
    sessionId: "completion-session",
  });
  fake.emitExit(0, 0);
  await runtime.waitFor(task.taskId);

  assert.equal(diagnostics.length, 1);
  assert.deepEqual(observed.map((event) => event.sessionId), ["completion-session"]);
  assert.equal(observed[0]?.status, "completed");
  assert.equal(observed[0]?.outputPreview, "provider output\n");

  subscription.dispose();
  const later = await runtime.start({ command: "echo later", cwd: process.cwd(), sessionId: "completion-session" });
  fake.emitExit(1, 0);
  await runtime.waitFor(later.taskId);
  assert.equal(observed.length, 1);

  await runtime.dispose();
  assert.equal(subscription.active, false);
});

test("background task runtime fences model-facing reads and controls to the owning session", async () => {
  const fake = fakeShell();
  const runtime = new BackgroundTaskRuntime({ shell: fake.port });
  const ownerTask = await runtime.start({
    command: "echo owner",
    cwd: process.cwd(),
    sessionId: "owner-session",
  });
  const otherTask = await runtime.start({
    command: "echo other",
    cwd: process.cwd(),
    sessionId: "other-session",
  });
  const ownerAccess = { sessionId: "owner-session" };

  assert.deepEqual(
    runtime.list({}, ownerAccess).map((task) => task.taskId),
    [ownerTask.taskId],
  );
  assert.equal(runtime.get(otherTask.taskId, ownerAccess), undefined);
  assert.throws(
    () => runtime.getOutput(otherTask.taskId, 0, undefined, ownerAccess),
    /Unknown taskId/,
  );
  assert.equal(await runtime.wait(otherTask.taskId, {}, ownerAccess), undefined);
  await assert.rejects(
    runtime.stop(otherTask.taskId, {}, ownerAccess),
    /Unknown taskId/,
  );
  assert.equal(otherTask.status, "running");

  fake.emitExit(0, 0);
  fake.emitExit(1, 0);
  await Promise.all([runtime.waitFor(ownerTask.taskId), runtime.waitFor(otherTask.taskId)]);
  await runtime.dispose();
});

test("background task concurrency limit excludes settled historical entries", async () => {
  const fake = fakeShell();
  const runtime = new BackgroundTaskRuntime({ shell: fake.port, maxTasks: 1 });
  const first = await runtime.start({ command: "echo first", cwd: process.cwd() });
  fake.emitExit(0, 0);
  await runtime.waitFor(first.taskId);

  const second = await runtime.start({ command: "echo second", cwd: process.cwd() });
  assert.equal(second.status, "running");
  fake.emitExit(1, 0);
  await runtime.waitFor(second.taskId);
  await runtime.dispose();
});

test("background task runtime settles a rejected provider exit as failed", async () => {
  const runtime = new BackgroundTaskRuntime({
    shell: {
      async start(request) {
        request.onStdout?.("before provider failure\n");
        return {
          pid: 9123,
          exit: Promise.reject(new Error("detached provider lost its child")),
          terminate() {},
        };
      },
    },
  });
  const task = await runtime.start({ command: "echo rejected", cwd: process.cwd() });
  const settled = await runtime.waitFor(task.taskId);

  assert.equal(settled.status, "failed");
  assert.equal(settled.exitCode, null);
  assert.match(runtime.getOutput(task.taskId, 0).content, /exit error: detached provider lost its child/);
  await runtime.dispose();
});

test("background task runtime flushes accepted output spill writes before dispose resolves", async (t) => {
  const spillDir = mkdtempSync(join(tmpdir(), "pilotdeck-task-spill-"));
  t.after(() => rmSync(spillDir, { recursive: true, force: true }));
  const fake = fakeShell();
  const runtime = new BackgroundTaskRuntime({ shell: fake.port, diskSpillDir: spillDir });
  const task = await runtime.start({ command: "echo spill", cwd: process.cwd() });
  fake.emitExit(0, 0);
  await runtime.waitFor(task.taskId);
  await runtime.dispose();

  assert.equal(readFileSync(join(spillDir, `${task.taskId}.log`), "utf8"), "provider output\n");
});

test("background task durable restore preserves terminal output without replaying completion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-task-recovery-terminal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const outputDir = join(root, "output");
  const firstShell = fakeShell();
  const first = new BackgroundTaskRuntime({
    shell: firstShell.port,
    diskSpillDir: outputDir,
    snapshotStore: new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
  });
  const task = await first.start({
    command: "echo durable",
    cwd: root,
    sessionId: "owner-session",
  });
  firstShell.emitExit(0, 0);
  await first.waitFor(task.taskId);

  const restored = new BackgroundTaskRuntime({
    shell: fakeShell().port,
    diskSpillDir: outputDir,
    snapshotStore: new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
  });
  const completionEvents: import("../../src/task/index.js").BackgroundTaskCompletionEvent[] = [];
  restored.subscribeCompletionEvents((event) => completionEvents.push(event));

  const restoredTask = restored.get(task.taskId, { sessionId: "owner-session" });
  assert.equal(restoredTask?.status, "completed");
  assert.equal(restored.getOutput(task.taskId, 0, undefined, { sessionId: "owner-session" }).content, "provider output\n");
  assert.equal((await restored.wait(task.taskId, {}, { sessionId: "owner-session" }))?.outcome, "completed");
  assert.equal(restored.get(task.taskId, { sessionId: "other-session" }), undefined);
  assert.deepEqual(completionEvents, []);

  await Promise.all([first.dispose(), restored.dispose()]);
});

test("background task durable restore accepts a zero-output terminal task", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-task-recovery-empty-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const outputDir = join(root, "output");
  const first = new BackgroundTaskRuntime({
    shell: {
      async start() {
        return {
          pid: 9011,
          exit: Promise.resolve({ exitCode: 0, exitSignal: null }),
          terminate() {},
        };
      },
    },
    diskSpillDir: outputDir,
    snapshotStore: new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
  });
  const task = await first.start({ command: "true", cwd: root, sessionId: "owner-session" });
  await first.waitFor(task.taskId);

  const restored = new BackgroundTaskRuntime({
    shell: fakeShell().port,
    diskSpillDir: outputDir,
    snapshotStore: new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
  });
  assert.equal(restored.get(task.taskId, { sessionId: "owner-session" })?.status, "completed");
  assert.deepEqual(
    restored.getOutput(task.taskId, 0, undefined, { sessionId: "owner-session" }),
    { content: "", nextOffset: 0, totalBytes: 0, truncated: false },
  );
  await Promise.all([first.dispose(), restored.dispose()]);
});

test("background task recovery converts unresolved work to unknown without PID control or completion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-task-recovery-unknown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const outputDir = join(root, "output");
  const firstShell = fakeShell();
  const first = new BackgroundTaskRuntime({
    shell: firstShell.port,
    diskSpillDir: outputDir,
    snapshotStore: new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
  });
  const task = await first.start({
    command: "sleep 100",
    cwd: root,
    sessionId: "owner-session",
  });

  const restored = new BackgroundTaskRuntime({
    shell: fakeShell().port,
    diskSpillDir: outputDir,
    snapshotStore: new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
  });
  const completionEvents: import("../../src/task/index.js").BackgroundTaskCompletionEvent[] = [];
  restored.subscribeCompletionEvents((event) => completionEvents.push(event));

  const restoredTask = restored.get(task.taskId, { sessionId: "owner-session" });
  assert.equal(restoredTask?.status, "unknown");
  assert.equal(restoredTask?.pid, undefined);
  assert.equal((await restored.wait(task.taskId, {}, { sessionId: "owner-session" }))?.outcome, "unknown");
  await assert.rejects(
    restored.stop(task.taskId, {}, { sessionId: "owner-session" }),
    /unknown restored state/,
  );
  assert.equal(restored.get(task.taskId, { sessionId: "other-session" }), undefined);
  assert.equal(restored.getOutput(task.taskId, 0, undefined, { sessionId: "owner-session" }).content, "provider output\n");
  assert.deepEqual(completionEvents, []);

  firstShell.emitExit(0, null, "SIGTERM");
  await first.waitFor(task.taskId);
  await Promise.all([first.dispose(), restored.dispose()]);
});

test("background task snapshot corruption fails closed instead of starting empty", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-task-recovery-corrupt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  writeFileSync(statePath, "{not-json", "utf8");

  assert.throws(
    () => new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
    BackgroundTaskSnapshotRecoveryError,
  );
});

test("background task output metadata mismatch fails closed during recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-task-recovery-output-mismatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const outputDir = join(root, "output");
  const firstShell = fakeShell();
  const first = new BackgroundTaskRuntime({
    shell: firstShell.port,
    diskSpillDir: outputDir,
    snapshotStore: new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
  });
  const task = await first.start({ command: "echo durable", cwd: root, sessionId: "owner-session" });
  firstShell.emitExit(0, 0);
  await first.waitFor(task.taskId);
  rmSync(join(outputDir, `${task.taskId}.log`));

  assert.throws(
    () => new BackgroundTaskRuntime({
      shell: fakeShell().port,
      diskSpillDir: outputDir,
      snapshotStore: new JsonFileBackgroundTaskSnapshotStore({ filePath: statePath }),
    }),
    /Could not restore task output/,
  );
  await first.dispose();
});

test("sandboxed detached shell confines the exact inner shell argv through the direct executable substrate", async () => {
  const prepared: Array<{ executable: string; args: readonly string[]; policy: unknown }> = [];
  const started: unknown[] = [];
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
  const shell = createNodeSandboxedDetachedShellPort({
    sandbox,
    platform: "darwin",
    resolvePolicy: ({ workspaceRoot }) => ({ mode: "read-only", workspaceRoot }),
    startExecutable: async (request) => {
      started.push(request);
      return {
        pid: 5001,
        exit: Promise.resolve({ exitCode: 0, exitSignal: null }),
        terminate() {},
      };
    },
  });

  const handle = await shell.start({
    command: "printf '%s' sandboxed",
    cwd: "/workspace",
    env: { TEST: "1" },
  });

  assert.equal(handle.pid, 5001);
  assert.deepEqual(prepared, [{
    executable: "/bin/sh",
    args: ["-c", "printf '%s' sandboxed"],
    cwd: "/workspace",
    env: { TEST: "1" },
    policy: { mode: "read-only", workspaceRoot: "/workspace" },
  }]);
  assert.deepEqual(started, [{
    executable: "/sandbox-exec",
    args: ["--", "/bin/sh", "-c", "printf '%s' sandboxed"],
    cwd: "/workspace",
    env: { TEST: "1" },
    onStdout: undefined,
    onStderr: undefined,
    onError: undefined,
  }]);
});

test("sandboxed detached shell fails closed before starting a background task", async () => {
  let starts = 0;
  const shell = createNodeSandboxedDetachedShellPort({
    sandbox: {
      async prepare() {
        throw new SandboxUnavailableError("read-only");
      },
    },
    startExecutable: async () => {
      starts += 1;
      throw new Error("not reached");
    },
    resolvePolicy: ({ workspaceRoot }) => ({ mode: "read-only", workspaceRoot }),
  });

  await assert.rejects(
    shell.start({ command: "touch forbidden.txt", cwd: process.cwd() }),
    SandboxUnavailableError,
  );
  assert.equal(starts, 0);
});

test("macOS sandboxed detached shell denies read-only writes and permits workspace-write", { skip: process.platform !== "darwin" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sandboxed-detached-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sandbox = createNodeSandboxPort();
  const readOnly = createNodeSandboxedDetachedShellPort({
    sandbox,
    resolvePolicy: ({ workspaceRoot }) => ({ mode: "read-only", workspaceRoot }),
  });

  const denied = await readOnly.start({ command: "touch read-only.txt", cwd: root });
  const deniedExit = await denied.exit;
  assert.notEqual(deniedExit.exitCode, 0);
  assert.equal(existsSync(join(root, "read-only.txt")), false);

  const workspaceWrite = createNodeSandboxedDetachedShellPort({
    sandbox,
    resolvePolicy: ({ workspaceRoot }) => ({ mode: "workspace-write", workspaceRoot }),
  });
  const allowed = await workspaceWrite.start({ command: "touch workspace-write.txt", cwd: root });
  const allowedExit = await allowed.exit;
  assert.equal(allowedExit.exitCode, 0);
  assert.equal(existsSync(join(root, "workspace-write.txt")), true);
});
