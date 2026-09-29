import assert from "node:assert/strict";
import test from "node:test";

import { GatewayTelemetryBundle } from "../../src/cli/GatewayTelemetryBundle.js";
import type {
  TelemetryClient,
  TelemetryConfig,
} from "../../src/telemetry/index.js";

test("Gateway telemetry bundle forwards live observations and closes its native collector after observers", async () => {
  const events: string[] = [];
  const base = createTelemetry(events);
  const bundle = new GatewayTelemetryBundle({
    env: {},
    pilotHome: "/pilot-home",
    createCollector: ({ pilotHome }) => {
      events.push(`collector:${pilotHome}`);
      return base;
    },
  });
  bundle.observers.register("observer", {
    observe(observation) { events.push(`observe:${observation.type}`); },
    dispose() { events.push("observer:dispose"); },
  });

  bundle.client.track("feature_used");
  assert.deepEqual(events, [
    "collector:/pilot-home",
    "base:track:feature_used",
    "observe:track",
  ]);

  const first = bundle.dispose();
  const second = bundle.dispose();
  assert.equal(first, second);
  await first;
  assert.deepEqual(events, [
    "collector:/pilot-home",
    "base:track:feature_used",
    "observe:track",
    "observer:dispose",
    "base:shutdown",
  ]);
});

test("Gateway telemetry bundle drains observers but never closes an injected client", async () => {
  const events: string[] = [];
  const bundle = new GatewayTelemetryBundle({
    env: {},
    pilotHome: "/pilot-home",
    telemetry: createTelemetry(events),
    createCollector: () => {
      throw new Error("injected telemetry must not create a collector");
    },
  });
  bundle.observers.register("observer", {
    observe() {},
    dispose() { events.push("observer:dispose"); },
  });

  await bundle.dispose();
  assert.deepEqual(events, ["observer:dispose"]);
});

test("Gateway telemetry bundle still closes an owned collector when observer disposal fails", async () => {
  const events: string[] = [];
  const bundle = new GatewayTelemetryBundle({
    env: {},
    pilotHome: "/pilot-home",
    createCollector: () => createTelemetry(events),
  });
  bundle.observers.register("broken", {
    observe() {},
    dispose() {
      events.push("observer:dispose");
      throw new Error("observer dispose failed");
    },
  });

  await assert.rejects(bundle.dispose(), /observer dispose failed/);
  assert.deepEqual(events, ["observer:dispose", "base:shutdown"]);
});

function createTelemetry(events: string[]): TelemetryClient {
  const config = {} as TelemetryConfig;
  return {
    track(eventName) { events.push(`base:track:${eventName}`); },
    trackFeatureUsed() { events.push("base:feature"); },
    trackFeatureLoopStage() { events.push("base:loop"); },
    trackError() { events.push("base:error"); },
    setEnabled() {},
    async flush() {},
    async shutdown() { events.push("base:shutdown"); },
    snapshot() {
      return {
        queued: 0,
        sent: 0,
        sendFailures: 0,
        retries: 0,
        dropped: 0,
        queueDepth: 0,
      };
    },
    getConfig() { return config; },
  };
}
