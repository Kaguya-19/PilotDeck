import assert from "node:assert/strict";
import test from "node:test";

import { createNodeCodeRuntimePort } from "../../src/tool/execution-world/NodeCodeRuntimePort.js";

const runtime = createNodeCodeRuntimePort();

function request(args: string[], overrides: Partial<{
  timeoutMs: number;
  signal: AbortSignal;
}> = {}) {
  return {
    executable: process.execPath,
    args,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    signal: overrides.signal,
    stdoutMaxBytes: 1_024,
    stderrMaxBytes: 1_024,
  };
}

test("native code runtime captures bounded process output without owning tool semantics", async () => {
  const result = await runtime.run(request([
    "-e",
    "process.stdout.write('stdout'); process.stderr.write('stderr')",
  ]));

  assert.equal(result.exitCode, 0);
  assert.equal(result.exitSignal, null);
  assert.equal(result.stdout, "stdout");
  assert.equal(result.stderr, "stderr");
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
});

test("native code runtime resolves the first usable interpreter", async () => {
  const executable = await runtime.resolveExecutable(["pilotdeck-command-that-does-not-exist", process.execPath]);
  assert.equal(executable, process.execPath);
});

test("native code runtime reports timeout and abort as distinct process outcomes", async () => {
  const timeout = await runtime.run(request([
    "-e",
    "setTimeout(() => {}, 10_000)",
  ], { timeoutMs: 20 }));
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.cancelled, false);

  const controller = new AbortController();
  const aborted = runtime.run(request([
    "-e",
    "setTimeout(() => {}, 10_000)",
  ], { signal: controller.signal }));
  setTimeout(() => controller.abort(), 20).unref();
  const result = await aborted;
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, true);
});

test("native code runtime dispose stops new runs and drains an active process", async () => {
  const provider = createNodeCodeRuntimePort();
  const active = provider.run(request([
    "-e",
    "setTimeout(() => {}, 10_000)",
  ]));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await provider.dispose?.();

  const result = await active;
  assert.equal(result.cancelled, true);
  await assert.rejects(provider.run(request(["-e", "process.exit(0)"])), /refusing a new run/);
});
