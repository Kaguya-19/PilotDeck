import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { EventEmitter } from "node:events";
import { BackgroundTaskRuntime } from "../../../src/task/runtime/BackgroundTaskRuntime.js";

test("BackgroundTaskRuntime does not detach Windows background tasks", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const calls: Array<{ options: { detached?: boolean; windowsHide?: boolean } }> = [];
    const runtime = new BackgroundTaskRuntime({
      spawn: ((command: string, options: { detached?: boolean; windowsHide?: boolean }) => {
        void command;
        calls.push({ options });
        return createFakeChild();
      }) as never,
    });

    const task = await runtime.start({ command: "powershell -NoProfile -Command Get-Date", cwd: "C:\\repo" });

    assert.equal(task.status, "running");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options.detached, false);
    assert.equal(calls[0]?.options.windowsHide, true);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("BackgroundTaskRuntime keeps non-Windows background tasks detached", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const calls: Array<{ options: { detached?: boolean; windowsHide?: boolean } }> = [];
    const runtime = new BackgroundTaskRuntime({
      spawn: ((command: string, options: { detached?: boolean; windowsHide?: boolean }) => {
        void command;
        calls.push({ options });
        return createFakeChild();
      }) as never,
    });

    await runtime.start({ command: "sleep 30", cwd: "/tmp" });

    assert.equal(calls[0]?.options.detached, true);
    assert.equal(calls[0]?.options.windowsHide, false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    unref: () => void;
    kill: () => boolean;
  };
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => undefined;
  child.kill = () => true;
  return child;
}
