import assert from "node:assert/strict";
import test from "node:test";

import { GatewayTurnTelemetryContextResolver } from "../../src/gateway/client/GatewayTurnTelemetryContextResolver.js";

test("GatewayTurnTelemetryContextResolver preserves explicit attribution and derives always-on phase", () => {
  const resolver = new GatewayTurnTelemetryContextResolver();

  assert.deepEqual(resolver.resolve({
    channelKey: "always-on/daily",
    telemetry: { ownerModule: "cron_job", executionKind: "cron_job", phase: "explicit" },
  }), {
    ownerModule: "cron_job",
    executionKind: "cron_job",
    phase: "explicit",
  });
  assert.deepEqual(resolver.resolve({ channelKey: "always-on/daily" }), {
    ownerModule: "always_on",
    executionKind: "always_on",
    phase: "daily",
  });
  assert.deepEqual(resolver.resolve({
    channelKey: "cli",
    telemetry: { ownerModule: "router", phase: "judge" },
  }), {
    ownerModule: "router",
    executionKind: "user_session",
    phase: "judge",
  });
});
