import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeRouterRetryPolicy,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "provider/model", provider: "provider", model: "model" } },
  transientRetry: { enabled: true, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
  zeroUsageRetry: { enabled: true, maxAttempts: 2 },
};

test("native router retry policy owns transient retry admission and delay", () => {
  const policy = createNativeRouterRetryPolicy(config, { random: () => 0 });
  assert.deepEqual(policy.decide({ kind: "transient", attempt: 0 }), { retry: true, maxAttempts: 3, delayMs: 100 });
  assert.deepEqual(policy.decide({ kind: "transient", attempt: 2, retryAfterMs: 900 }), { retry: true, maxAttempts: 3, delayMs: 500 });
  assert.deepEqual(policy.decide({ kind: "transient", attempt: 3 }), { retry: false, maxAttempts: 3, delayMs: 0 });
});

test("native router retry policy preserves zero-usage retry semantics", () => {
  const policy = createNativeRouterRetryPolicy(config);
  assert.deepEqual(policy.decide({ kind: "zero_usage", attempt: 0 }), { retry: true, maxAttempts: 2, delayMs: 0 });
  assert.deepEqual(policy.decide({ kind: "zero_usage", attempt: 1 }), { retry: true, maxAttempts: 2, delayMs: 500 });
  assert.deepEqual(policy.decide({ kind: "zero_usage", attempt: 2 }), { retry: false, maxAttempts: 2, delayMs: 1000 });
});
