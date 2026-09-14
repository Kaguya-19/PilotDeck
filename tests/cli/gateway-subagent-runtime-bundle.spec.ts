import assert from "node:assert/strict";
import test from "node:test";

import { GatewaySubagentRuntimeBundle } from "../../src/cli/GatewaySubagentRuntimeBundle.js";

test("gateway subagent runtime bundle composes one native provider family and drains it once", async () => {
  const bundle = new GatewaySubagentRuntimeBundle({ agentRegistryName: "test-gateway-subagents" });

  assert.equal(bundle.agents.state, "active");
  assert.equal(bundle.continuations.host, bundle.host);
  assert.equal(bundle.continuations.manager, bundle.manager);
  assert.equal(bundle.continuations.providers, bundle.providers);
  assert.equal(bundle.providers.get(bundle.continuations.provider)?.name, bundle.continuations.provider);

  const first = bundle.dispose("test_shutdown");
  const second = bundle.dispose("ignored_duplicate_reason");
  assert.equal(first, second);
  await first;

  assert.equal(bundle.manager.state, "disposed");
  assert.equal(bundle.providers.state, "disposed");
  assert.equal(bundle.agents.state, "disposed");
});
