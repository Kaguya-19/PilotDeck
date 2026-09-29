import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../../src/agent/session/AgentSession.js";
import {
  AgentHandle,
  AgentRegistry,
} from "../../../src/agent/scope/index.js";

test("agent handle stops new turns, aborts the active turn, and drains before disposal", async () => {
  let finishTurn!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  let abortReason: string | undefined;
  let disposed = false;
  const session = {
    async *submit() {
      yield { type: "session_started", sessionId: "agent-1" } as const;
      await turnFinished;
    },
    abort(reason?: string) {
      abortReason = reason;
      finishTurn();
    },
  } as unknown as AgentSession;
  const handle = new AgentHandle(session, {
    onDispose: () => {
      disposed = true;
    },
  });

  const iterator = handle.submit({ type: "text", text: "run" }, { turnId: "turn-1" });
  assert.equal((await iterator.next()).value?.type, "session_started");
  const completion = iterator.next();

  const firstDispose = handle.dispose("test_shutdown");
  const secondDispose = handle.dispose("ignored");
  assert.equal(firstDispose, secondDispose);
  assert.equal(handle.state, "draining");
  assert.equal(handle.inFlight, 1);
  assert.equal(abortReason, "test_shutdown");
  await assert.rejects(
    handle.submit({ type: "text", text: "late" }).next(),
    /agent handle is draining/,
  );

  assert.equal((await completion).done, true);
  await firstDispose;
  assert.equal(handle.state, "disposed");
  assert.equal(handle.inFlight, 0);
  assert.equal(disposed, true);
});

test("agent registry replaces and removes handles with owned disposal", async () => {
  const registry = new AgentRegistry({ name: "test-agents" });
  const disposed: string[] = [];
  const first = new AgentHandle(fakeSession("first"), {
    onDispose: () => { disposed.push("first"); },
  });
  const second = new AgentHandle(fakeSession("second"), {
    onDispose: () => { disposed.push("second"); },
  });

  registry.register("agent-1", first);
  const replacement = registry.replace("agent-1", second);
  assert.equal(registry.get("agent-1"), second);
  await replacement.previousDisposed;
  assert.equal(first.state, "disposed");
  assert.deepEqual(disposed, ["first"]);

  assert.equal(await registry.remove("agent-1"), second);
  assert.equal(registry.get("agent-1"), undefined);
  assert.equal(second.state, "disposed");
  assert.deepEqual(disposed, ["first", "second"]);

  await registry.dispose();
  assert.equal(registry.state, "disposed");
});

test("agent handle propagates dispose-start ownership before releasing its own resources", async () => {
  const order: string[] = [];
  const handle = new AgentHandle(fakeSession("agent-1"), {
    onDispose: () => { order.push("own-resources"); },
  });
  handle.addDisposeStartListener(async (reason) => {
    order.push(`descendants:${reason}`);
  });

  await handle.dispose("parent_closed");
  assert.deepEqual(order, ["descendants:parent_closed", "own-resources"]);
});

function fakeSession(sessionId: string): AgentSession {
  return {
    async *submit() {},
    abort() {},
    snapshot() {
      return {
        sessionId,
        messages: [],
        usage: {},
        status: "idle",
        permissionDenials: [],
        abortController: new AbortController(),
      };
    },
  } as unknown as AgentSession;
}
