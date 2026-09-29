import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandHookExecutor,
  type CommandHookExecutionOptions,
} from "../../src/extension/index.js";
import type { ShellPort } from "../../src/tool/execution-world/ShellPort.js";

function input(overrides: Partial<CommandHookExecutionOptions> = {}): CommandHookExecutionOptions {
  return {
    hook: { type: "command", command: "hook-command" },
    hookInput: { event: "PermissionRequest", sessionId: "session-1" } as never,
    cwd: "/workspace",
    ...overrides,
  };
}

test("command hook executor consumes the shell provider and stdin contract", async () => {
  const requests: unknown[] = [];
  const shell: ShellPort = {
    async execute(request) {
      requests.push(request);
      return {
        exitCode: 0,
        stdout: '{"continue":true}\n',
        stderr: "",
        timedOut: false,
        durationMs: 4,
      };
    },
  };

  const result = await new CommandHookExecutor(shell).execute(input());
  assert.equal(result.outcome, "success");
  assert.equal(result.output.type, "sync");
  assert.equal(result.output.continue, true);
  assert.equal(requests.length, 1);
  const request = requests[0] as { command: string; stdin?: string; cwd: string; timeoutMs: number };
  assert.equal(request.command, "hook-command");
  assert.equal(request.cwd, "/workspace");
  assert.equal(request.timeoutMs, 10 * 60 * 1000);
  assert.match(request.stdin ?? "", /PermissionRequest/);
});

test("command hook executor preserves blocking and timeout outcomes", async () => {
  const blocking = new CommandHookExecutor({
    async execute() {
      return { exitCode: 2, stdout: "", stderr: "blocked", timedOut: false, durationMs: 1 };
    },
  }).execute(input());
  assert.equal((await blocking).outcome, "blocking");

  const timeout = new CommandHookExecutor({
    async execute() {
      return { exitCode: null, stdout: "partial", stderr: "", timedOut: true, durationMs: 10 };
    },
  }).execute(input({ timeoutMs: 10 }));
  const timeoutResult = await timeout;
  assert.equal(timeoutResult.outcome, "timeout");
  assert.equal(timeoutResult.stdout, "partial");
});
