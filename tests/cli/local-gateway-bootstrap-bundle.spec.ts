import assert from "node:assert/strict";
import test from "node:test";

import { LocalGatewayBootstrapBundle } from "../../src/cli/LocalGatewayBootstrapBundle.js";

test("local Gateway bootstrap stops watchers then rolls back resources in reverse acquisition order", async () => {
  const events: string[] = [];
  const bundle = new LocalGatewayBootstrapBundle();
  bundle.own("telemetry", async () => { events.push("telemetry"); });
  bundle.own("runtime", async () => { events.push("runtime"); });
  bundle.own("router", async () => { events.push("router"); });
  bundle.ownWatcher("config watcher", () => { events.push("config-watch"); });
  bundle.ownWatcher("extension watcher", () => { events.push("extension-watch"); });

  const first = bundle.rollback();
  const second = bundle.rollback();
  assert.equal(first, second);
  await first;

  assert.deepEqual(events, [
    "config-watch",
    "extension-watch",
    "router",
    "runtime",
    "telemetry",
  ]);
  assert.throws(() => bundle.own("late", () => {}), /rolling back/);
});

test("local Gateway bootstrap aggregates cleanup failures and commit transfers ownership", async () => {
  const events: string[] = [];
  const failing = new LocalGatewayBootstrapBundle();
  failing.own("first", () => { events.push("first"); throw new Error("first failed"); });
  failing.own("second", () => { events.push("second"); throw new Error("second failed"); });

  await assert.rejects(failing.rollback(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "Failed to roll back local Gateway bootstrap.");
    assert.deepEqual(error.errors.map((failure) => (failure as Error).message), [
      "Failed to roll back second.",
      "Failed to roll back first.",
    ]);
    return true;
  });
  assert.deepEqual(events, ["second", "first"]);

  const committed = new LocalGatewayBootstrapBundle();
  committed.own("runtime", () => { events.push("committed"); });
  committed.commit();
  await committed.rollback();
  assert.equal(events.includes("committed"), false);
  assert.throws(() => committed.own("late", () => {}), /already committed/);
});
