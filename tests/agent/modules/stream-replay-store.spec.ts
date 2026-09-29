import assert from "node:assert/strict";
import test from "node:test";

import { SidecarStreamReplayStore } from "../../../src/agent/modules/transport/streamReplayStore.js";
import type { ModuleBinding, ModuleEvent } from "../../../src/agent/modules/protocol.js";

const binding: ModuleBinding = {
  moduleInstanceId: "sidecar-1",
  connectionGeneration: "connection-1",
};

function event(sequence: number): ModuleEvent {
  return {
    kind: "event",
    eventType: sequence === 2 ? "agent.execute.completed" : "agent.delta",
    streamId: "stream-1",
    sequence,
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    final: sequence === 2,
    ...(sequence === 2 ? { outcome: "completed" as const } : {}),
    payload: { sequence },
  };
}

test("stream replay retains ordered events, binds the prior connection, and trims acknowledged history", () => {
  const store = new SidecarStreamReplayStore({ maxEventsPerStream: 8, maxBytesPerStream: 8_192 });
  store.start("stream-1", binding);
  store.append(event(0));
  store.append(event(1));
  store.append(event(2));

  assert.deepEqual(store.resume({ streamId: "stream-1", previousBinding: binding, lastAppliedSequence: 0 }), {
    ok: true,
    events: [event(1), event(2)],
    replayedThroughSequence: 2,
  });
  assert.deepEqual(store.acknowledge({ streamId: "stream-1", lastAppliedSequence: 1 }), { ok: true });
  assert.deepEqual(store.resume({ streamId: "stream-1", previousBinding: binding, lastAppliedSequence: -1 }), {
    ok: false,
    code: "CURSOR_EXPIRED",
  });
  assert.deepEqual(store.resume({ streamId: "stream-1", previousBinding: binding, lastAppliedSequence: 1 }), {
    ok: true,
    events: [event(2)],
    replayedThroughSequence: 2,
  });
});

test("stream replay fails closed for wrong bindings, unsupported cursors, bounded eviction, and expiry", () => {
  let now = 1_000;
  const store = new SidecarStreamReplayStore({
    maxEventsPerStream: 1,
    maxBytesPerStream: 8_192,
    ttlMs: 10,
    now: () => now,
  });
  store.start("stream-1", binding);
  store.append(event(0));
  store.append(event(1));

  assert.deepEqual(store.resume({
    streamId: "stream-1",
    previousBinding: { ...binding, connectionGeneration: "wrong" },
    lastAppliedSequence: 1,
  }), { ok: false, code: "BINDING_MISMATCH" });
  assert.deepEqual(store.resume({ streamId: "stream-1", previousBinding: binding, lastAppliedSequence: -1 }), {
    ok: false,
    code: "CURSOR_EXPIRED",
  });
  assert.deepEqual(store.acknowledge({ streamId: "stream-1", lastAppliedSequence: 2 }), {
    ok: false,
    code: "INVALID_ACK_CURSOR",
  });

  store.append(event(2));
  now += 11;
  assert.deepEqual(store.resume({ streamId: "stream-1", previousBinding: binding, lastAppliedSequence: 1 }), {
    ok: false,
    code: "CURSOR_EXPIRED",
  });
});

test("stream replay accepts -1 only for resuming before the first event is applied", () => {
  const store = new SidecarStreamReplayStore();
  store.start("stream-1", binding);
  store.append(event(0));

  assert.deepEqual(store.resume({ streamId: "stream-1", previousBinding: binding, lastAppliedSequence: -1 }), {
    ok: true,
    events: [event(0)],
    replayedThroughSequence: 0,
  });
});

test("stream replay retains an active stream through a quiet interval and expires it after terminal", () => {
  let now = 1_000;
  const store = new SidecarStreamReplayStore({
    maxEventsPerStream: 8,
    maxBytesPerStream: 8_192,
    ttlMs: 10,
    now: () => now,
  });
  store.start("stream-1", binding);

  // A model or host tool can take longer than the replay retention window.
  // The execution is still live, so a later event must not crash the server,
  // including after a reconnect rebinding.
  const reboundBinding = { ...binding, connectionGeneration: "connection-2" };
  assert.equal(store.rebind("stream-1", reboundBinding), true);
  now += 11;
  store.append(event(0));
  assert.deepEqual(store.resume({ streamId: "stream-1", previousBinding: reboundBinding, lastAppliedSequence: -1 }), {
    ok: true,
    events: [event(0)],
    replayedThroughSequence: 0,
  });

  store.append(event(1));
  store.append(event(2));
  now += 11;
  assert.deepEqual(store.resume({ streamId: "stream-1", previousBinding: reboundBinding, lastAppliedSequence: 1 }), {
    ok: false,
    code: "CURSOR_EXPIRED",
  });
});
