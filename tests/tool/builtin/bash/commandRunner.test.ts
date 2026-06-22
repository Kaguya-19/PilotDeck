import assert from "node:assert/strict";
import test from "node:test";
import {
  createShellOutputDecoder,
  decodeShellOutput,
  NodeShellCommandRunner,
} from "../../../../src/tool/builtin/bash/commandRunner.js";

test("decodeShellOutput preserves utf-8 output", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    assert.equal(decodeShellOutput(Buffer.from("hello 世界", "utf8")), "hello 世界");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("decodeShellOutput falls back to gb18030 for Windows shell output", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const gbkBytes = Buffer.from([
      0x27, 0x73, 0x6c, 0x65, 0x65, 0x70, 0x27, 0x20,
      0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf,
      0xbb, 0xf2, 0xcd, 0xe2, 0xb2, 0xbf, 0xc3, 0xfc,
      0xc1, 0xee,
    ]);
    assert.equal(decodeShellOutput(gbkBytes), "'sleep' 不是内部或外部命令");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("createShellOutputDecoder handles split gb18030 chunks", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const decoder = createShellOutputDecoder();
    assert.equal(decoder.decode(Buffer.from([0xb2])), "");
    assert.equal(decoder.decode(Buffer.from([0xbb])), "不");
    assert.equal(decoder.decode(Buffer.from([0xca, 0xc7])), "是");
    assert.equal(decoder.flush(), "");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("NodeShellCommandRunner does not detach Windows shell commands", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const calls: Array<{ options: { detached?: boolean; windowsHide?: boolean } }> = [];
    const runner = new NodeShellCommandRunner(((command: string, options: { detached?: boolean; windowsHide?: boolean }) => {
      void command;
      calls.push({ options });
      return createFakeChildProcess();
    }) as never);

    const result = await runner.run("echo hi", {
      cwd: "C:\\repo",
      timeoutMs: 1000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options.detached, false);
    assert.equal(calls[0]?.options.windowsHide, true);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("NodeShellCommandRunner resolves Windows commands after exit if close is delayed", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const runner = new NodeShellCommandRunner((() => createFakeChildProcess("exit")) as never);

    const result = await runner.run("echo hi", {
      cwd: "C:\\repo",
      timeoutMs: 1000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

function createFakeChildProcess(event: "close" | "exit" = "close") {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child = {
    pid: 123,
    stdout: undefined,
    stderr: undefined,
    on(event: string, listener: (...args: unknown[]) => void) {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(listener);
      listeners.set(event, eventListeners);
      return child;
    },
  };
  queueMicrotask(() => {
    for (const listener of listeners.get(event) ?? []) {
      listener(0);
    }
  });
  return child;
}
