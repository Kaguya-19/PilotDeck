import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeGatewayModeForLegacyInput,
  normalizeGatewayRunMode,
} from "../../src/gateway/client/InProcessGateway.js";

test("Gateway preserves its legacy fallback while consuming the shared run-mode definition", () => {
  assert.equal(normalizeGatewayRunMode(undefined), undefined);
  assert.equal(normalizeGatewayRunMode("plan"), "plan");
  assert.equal(normalizeGatewayRunMode("ask"), "ask");
  assert.equal(normalizeGatewayRunMode("unsupported"), "agent");
});

test("Gateway permission-mode normalizer consumes the shared permission definition", () => {
  assert.equal(normalizeGatewayModeForLegacyInput(undefined), undefined);
  assert.equal(normalizeGatewayModeForLegacyInput("plan"), "plan");
  assert.equal(normalizeGatewayModeForLegacyInput("bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeGatewayModeForLegacyInput("unsupported"), undefined);
});
