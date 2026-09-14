import assert from "node:assert/strict";
import test from "node:test";

import { SessionMcpRuntimeRegistry } from "../../src/mcp/runtime/SessionMcpRuntimeRegistry.js";

test("a retiring session registration cannot stop its dirty-recreated replacement", async () => {
  const registry = new SessionMcpRuntimeRegistry();
  const stopped: string[] = [];
  const oldRegistration = registry.register("session-1", {
    async stop() { stopped.push("old"); },
  });
  const replacementRegistration = registry.register("session-1", {
    async stop() { stopped.push("replacement"); },
  });

  await oldRegistration.dispose();
  assert.deepEqual(stopped, ["old"]);
  assert.equal(registry.size, 1);

  await replacementRegistration.dispose();
  assert.deepEqual(stopped, ["old", "replacement"]);
  assert.equal(registry.size, 0);
});

test("global cleanup stops every remaining per-session runtime exactly once", async () => {
  const registry = new SessionMcpRuntimeRegistry();
  let stops = 0;
  const registration = registry.register("session-1", {
    async stop() { stops += 1; },
  });

  await registry.dispose();
  await registration.dispose();

  assert.equal(stops, 1);
  assert.equal(registry.size, 0);
});

test("global cleanup stops new registration before draining existing runtimes", async () => {
  const registry = new SessionMcpRuntimeRegistry();
  let releaseStop!: () => void;
  const stopStarted = new Promise<void>((resolve) => { releaseStop = resolve; });
  let beginStop!: () => void;
  const stopRunning = new Promise<void>((resolve) => { beginStop = resolve; });
  registry.register("session-1", {
    async stop() {
      beginStop();
      await stopStarted;
    },
  });

  const disposal = registry.dispose();
  await stopRunning;
  assert.equal(registry.state, "draining");
  assert.throws(
    () => registry.register("late-session", { async stop() {} }),
    /registry is draining/,
  );

  releaseStop();
  await disposal;
  assert.equal(registry.state, "disposed");
  assert.throws(
    () => registry.register("later-session", { async stop() {} }),
    /registry is disposed/,
  );
});
