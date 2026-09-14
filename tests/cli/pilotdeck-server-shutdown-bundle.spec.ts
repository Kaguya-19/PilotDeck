import assert from "node:assert/strict";
import test from "node:test";

import { PilotDeckServerShutdownBundle } from "../../src/cli/PilotDeckServerShutdownBundle.js";

test("server shutdown flushes state and stops providers in dependency order exactly once", async () => {
  const events: string[] = [];
  const bundle = new PilotDeckServerShutdownBundle({
    automation: { async stop() { events.push("automation"); } },
    closeServer: async () => { events.push("server"); },
    flushChannelState: async () => { events.push("flush"); },
    disposeGateway: async () => { events.push("gateway"); },
    telemetry: {
      snapshot: () => ({ active: 0 }),
      async shutdown() { events.push("telemetry"); },
    },
    log: (message) => { events.push(message); },
  });

  const first = bundle.stop();
  const second = bundle.stop();
  assert.equal(first, second);
  await first;

  assert.deepEqual(events, [
    "automation",
    "server",
    "flush",
    "[telemetry] shutdown snapshot {\"active\":0}",
    "gateway",
    "telemetry",
  ]);
});

test("server shutdown preserves every cleanup failure after disposing downstream providers", async () => {
  const events: string[] = [];
  const bundle = new PilotDeckServerShutdownBundle({
    automation: {
      async stop() {
        events.push("automation");
        throw new Error("automation failed");
      },
    },
    closeServer: async () => { events.push("server"); throw new Error("server failed"); },
    flushChannelState: async () => {
      events.push("flush");
      throw new Error("flush failed");
    },
    disposeGateway: async () => { events.push("gateway"); throw new Error("gateway failed"); },
    telemetry: {
      snapshot: () => ({ active: 0 }),
      async shutdown() { events.push("telemetry"); throw new Error("telemetry failed"); },
    },
    log: () => { events.push("log"); },
  });

  await assert.rejects(bundle.stop(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "PilotDeck server shutdown failed.");
    assert.deepEqual(error.errors.map((failure) => (failure as Error).message), [
      "automation failed",
      "server failed",
      "flush failed",
      "gateway failed",
      "telemetry failed",
    ]);
    return true;
  });
  assert.deepEqual(events, ["automation", "server", "flush", "gateway", "telemetry"]);
});
