import assert from "node:assert/strict";
import test from "node:test";

import { createNativeRetryPolicy, type ProviderConfig } from "../../src/model/index.js";

const provider = {
  id: "test",
  protocol: "openai",
  url: "https://example.test",
  apiKey: "test",
  headers: {},
  models: {},
  retry: { requestMaxRetries: 3, streamMaxRetries: 2, baseDelayMs: 100, maxDelayMs: 250, jitter: 0 },
} as ProviderConfig;

test("native retry policy separates request and stream retry budgets", () => {
  const policy = createNativeRetryPolicy({ random: () => 0 });
  assert.deepEqual(policy.decide({ provider, kind: "request", attempt: 0 }), { maxRetries: 3, delayMs: 100 });
  assert.deepEqual(policy.decide({ provider, kind: "stream", attempt: 1 }), { maxRetries: 2, delayMs: 200 });
  assert.deepEqual(policy.decide({ provider, kind: "stream", attempt: 4, retryAfterMs: 500 }), { maxRetries: 2, delayMs: 250 });
});
