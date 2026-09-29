import assert from "node:assert/strict";
import test from "node:test";

import { PilotDeckServerBootstrapBundle } from "../../src/cli/PilotDeckServerBootstrapBundle.js";

test("server bootstrap rolls back automation, Gateway, and telemetry when automation start fails", async () => {
  const events: string[] = [];
  const bundle = bundleWith(events, {
    async start() {
      events.push("automation.start");
      throw new Error("automation start failed");
    },
  });

  await assert.rejects(bundle.startAutomation(), /automation start failed/);
  assert.deepEqual(events, [
    "automation.start",
    "automation.stop",
    "gateway.dispose",
    "telemetry.shutdown",
  ]);
});

test("server bootstrap rolls back a started automation when server assembly fails", async () => {
  const events: string[] = [];
  const bundle = bundleWith(events);

  await bundle.startAutomation();
  await assert.rejects(bundle.run(async () => {
    events.push("server.start");
    throw new Error("server start failed");
  }), /server start failed/);
  assert.deepEqual(events, [
    "automation.start",
    "server.start",
    "automation.stop",
    "gateway.dispose",
    "telemetry.shutdown",
  ]);
});

test("server bootstrap transfers lifecycle ownership on commit", async () => {
  const events: string[] = [];
  const bundle = bundleWith(events);

  await bundle.startAutomation();
  const server = await bundle.run(async () => {
    events.push("server.start");
    return { started: true };
  });
  bundle.commit();
  await bundle.rollback();

  assert.deepEqual(server, { started: true });
  assert.deepEqual(events, ["automation.start", "server.start"]);
  await assert.rejects(bundle.run(async () => undefined), /already committed/);
});

test("server bootstrap continues rollback after an earlier cleanup failure", async () => {
  const events: string[] = [];
  const bundle = new PilotDeckServerBootstrapBundle({
    automation: {
      async start() { events.push("automation.start"); },
      async stop() {
        events.push("automation.stop");
        throw new Error("automation cleanup failed");
      },
    },
    async disposeGateway() { events.push("gateway.dispose"); },
    telemetry: { async shutdown() { events.push("telemetry.shutdown"); } },
    warn: (message, error) => {
      events.push(`warn:${message}:${(error as Error).message}`);
    },
  });

  await bundle.startAutomation();
  await assert.rejects(bundle.run(async () => {
    throw new Error("server start failed");
  }), /server start failed/);

  assert.deepEqual(events, [
    "automation.start",
    "automation.stop",
    "warn:[pilotdeck] automation cleanup after server boot failure failed::automation cleanup failed",
    "gateway.dispose",
    "telemetry.shutdown",
  ]);
});

function bundleWith(
  events: string[],
  automation: Partial<{ start(): Promise<unknown>; stop(): Promise<void> }> = {},
): PilotDeckServerBootstrapBundle {
  const lifecycle = {
    async start() { events.push("automation.start"); },
    async stop() { events.push("automation.stop"); },
    ...automation,
  };
  return new PilotDeckServerBootstrapBundle({
    automation: lifecycle,
    async disposeGateway() { events.push("gateway.dispose"); },
    telemetry: { async shutdown() { events.push("telemetry.shutdown"); } },
    warn: (message) => { events.push(`warn:${message}`); },
  });
}
