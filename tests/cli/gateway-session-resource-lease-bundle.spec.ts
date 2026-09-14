import assert from "node:assert/strict";
import test from "node:test";

import { GatewaySessionResourceLeaseBundle } from "../../src/cli/GatewaySessionResourceLeaseBundle.js";

test("Gateway session resources release in reverse acquisition order and are idempotent", async () => {
  const events: string[] = [];
  const bundle = new GatewaySessionResourceLeaseBundle();
  bundle.add("runtime", async () => { events.push("runtime"); });
  bundle.add("plugin", async () => { events.push("plugin"); });
  bundle.add("shared MCP", async () => { events.push("shared-mcp"); });
  bundle.add("session MCP", async () => { events.push("mcp"); });

  const first = bundle.release();
  const second = bundle.release();
  assert.equal(first, second);
  await first;

  assert.deepEqual(events, ["mcp", "shared-mcp", "plugin", "runtime"]);
  assert.throws(() => bundle.add("late", async () => {}), /resources are releasing/);
});

test("Gateway session resources continue release after a provider cleanup failure", async () => {
  const events: string[] = [];
  const bundle = new GatewaySessionResourceLeaseBundle();
  bundle.add("runtime", async () => { events.push("runtime"); });
  bundle.add("plugin", async () => {
    events.push("plugin");
    throw new Error("plugin failed");
  });
  bundle.add("shared MCP", async () => { events.push("shared-mcp"); });
  bundle.add("session MCP", async () => { events.push("mcp"); });

  await assert.rejects(bundle.release(), /Failed to release plugin/);
  assert.deepEqual(events, ["mcp", "shared-mcp", "plugin", "runtime"]);
});
