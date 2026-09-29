import assert from "node:assert/strict";
import test from "node:test";

import { createBashTool } from "../../src/tool/builtin/bash.js";
import type { SubprocessPort } from "../../src/tool/execution-world/SubprocessPort.js";
import { createNodeSubprocessPort } from "../../src/tool/execution-world/SubprocessPort.js";

test("bash consumes an execution-world subprocess provider", async () => {
  const calls: unknown[] = [];
  const subprocess: SubprocessPort = {
    async execute(request) {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: "provider stdout\n",
        stderr: "",
        timedOut: false,
        durationMs: 7,
      };
    },
    async executeFile() {
      throw new Error("not used");
    },
  };
  const tool = createBashTool({ subprocess });
  const result = await tool.execute(
    { command: "echo provider", timeout: 123, description: "provider test" },
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
  assert.equal(result.data?.stdout, "provider stdout\n");
  assert.deepEqual(calls, [{
    command: "echo provider",
    cwd: process.cwd(),
    env: undefined,
    timeoutMs: 123,
    signal: undefined,
    onStdout: undefined,
    onStderr: undefined,
  }]);
});

test("native subprocess provider executes a direct program without shell interpolation", async () => {
  const result = await createNodeSubprocessPort().executeFile?.({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", "literal & value"],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });

  assert.equal(result?.exitCode, 0);
  assert.equal(result?.stdout, "literal & value");
  assert.equal(result?.stderr, "");
  assert.equal(result?.timedOut, false);
});

test("native subprocess provider forwards direct-program output callbacks", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await createNodeSubprocessPort().executeFile?.({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr')"],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: (chunk) => stderr.push(chunk),
  });

  assert.equal(result?.exitCode, 0);
  assert.equal(stdout.join(""), "stdout");
  assert.equal(stderr.join(""), "stderr");
});
