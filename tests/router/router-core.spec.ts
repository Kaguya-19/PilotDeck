import test from "node:test";
import assert from "node:assert/strict";
import { planFallback, isFallbackEligible } from "../../src/router/fallback/runFallbackChain.js";
import { ProviderHealthTracker } from "../../src/router/health/ProviderHealthTracker.js";
import { createZeroUsageState, observeEventForZeroUsage, shouldRetryZeroUsage } from "../../src/router/retry/zeroUsageRetry.js";
import { SessionRouterStore } from "../../src/router/session/SessionRouterStore.js";
import { parseTier } from "../../src/router/tokenSaver/parseTier.js";

const ref = (id: string) => ({ id, provider: id.split("/")[0], model: id.split("/")[1] });

test("fallback planning handles explicit routes and caps attempts", () => {
  const fallback = { default: [ref("a/1"), ref("b/2"), ref("c/3")], maxFallbacks: 2 };
  assert.deepEqual(planFallback(undefined, "default"), { attempts: [] });
  assert.deepEqual(planFallback(fallback, "explicit"), { attempts: [] });
  assert.deepEqual(planFallback(fallback, "default").attempts.map((item) => item.id), ["a/1", "b/2"]);
  assert.deepEqual(planFallback({ default: [ref("a/1")], maxFallbacks: 0 }, "default"), { attempts: [] });
});

test("fallback eligibility excludes errors with a more specific recovery", () => {
  const error = (code: string, extra: Record<string, unknown> = {}) => ({ code, message: code, retryable: true, ...extra }) as never;
  assert.equal(isFallbackEligible(error("invalid_tool_arguments")), true);
  assert.equal(isFallbackEligible(error("auth_error", { retryable: false })), true);
  assert.equal(isFallbackEligible(error("prompt_too_long")), false);
  assert.equal(isFallbackEligible(error("server_error", { recoverableViaCompact: true })), false);
  assert.equal(isFallbackEligible(error("server_error", { recoverableViaImageStrip: true })), false);
  assert.equal(isFallbackEligible(error("bad_request", { retryable: false })), false);
  assert.equal(isFallbackEligible(error("server_error")), true);
});

test("zero usage retry requires a clean finished response", () => {
  const empty = createZeroUsageState();
  observeEventForZeroUsage(empty, { type: "message_end", finishReason: "stop" } as never);
  assert.equal(shouldRetryZeroUsage(empty), true);

  const text = createZeroUsageState();
  observeEventForZeroUsage(text, { type: "text_delta", text: "hello" } as never);
  observeEventForZeroUsage(text, { type: "message_end", finishReason: "stop" } as never);
  assert.equal(shouldRetryZeroUsage(text), false);

  const usage = createZeroUsageState();
  observeEventForZeroUsage(usage, { type: "usage", usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } } as never);
  observeEventForZeroUsage(usage, { type: "message_end", finishReason: "stop" } as never);
  assert.equal(shouldRetryZeroUsage(usage), false);

  const failed = createZeroUsageState();
  observeEventForZeroUsage(failed, { type: "error", error: new Error("failed") } as never);
  observeEventForZeroUsage(failed, { type: "message_end", finishReason: "stop" } as never);
  assert.equal(shouldRetryZeroUsage(failed), false);
});

test("provider health transitions through degraded, open and half-open", (t) => {
  let now = 0;
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; });
  Date.now = () => now;
  const tracker = new ProviderHealthTracker({ degradeThreshold: 2, openThreshold: 3, openDurationMs: 100 });
  const provider = "openai";
  tracker.recordFailure(provider);
  tracker.recordFailure(provider);
  assert.equal(tracker.getState(provider), "degraded");
  tracker.recordFailure(provider);
  assert.equal(tracker.shouldSkip(provider), true);
  now = 101;
  assert.equal(tracker.getState(provider), "half_open");
  tracker.recordSuccess(provider);
  assert.equal(tracker.getState(provider), "healthy");
  assert.equal(tracker.getSuccessRate(provider), 0.25);
  tracker.reset(provider);
  assert.equal(tracker.getState(provider), "healthy");
});

test("provider health tracks a bounded success window, probe failures, snapshots, and resets", (t) => {
  let now = 0;
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; });
  Date.now = () => now;

  const tracker = new ProviderHealthTracker({
    degradeThreshold: 2,
    openThreshold: 3,
    openDurationMs: 10,
    windowSize: 3,
  });
  assert.equal(tracker.getState("new"), "healthy");
  assert.equal(tracker.getSuccessRate("new"), 1);
  assert.equal(tracker.isAvailable("new"), true);

  tracker.recordFailure("provider");
  tracker.recordFailure("provider");
  tracker.recordFailure("provider");
  assert.equal(tracker.shouldSkip("provider"), true);
  assert.equal(tracker.isAvailable("provider"), false);
  assert.deepEqual(tracker.snapshot().get("provider"), {
    state: "open",
    successRate: 0,
    consecutiveFailures: 3,
  });

  now = 10;
  assert.equal(tracker.getState("provider"), "half_open");
  tracker.recordFailure("provider");
  assert.equal(tracker.getState("provider"), "open");
  now = 21;
  tracker.recordSuccess("provider");
  assert.equal(tracker.getState("provider"), "healthy");

  // The oldest result is dropped once the bounded window is full.
  tracker.recordFailure("provider");
  tracker.recordSuccess("provider");
  assert.equal(tracker.getSuccessRate("provider"), 2 / 3);
  tracker.reset("provider");
  assert.equal(tracker.getSuccessRate("provider"), 1);
  tracker.recordFailure("one");
  tracker.recordFailure("two");
  tracker.resetAll();
  assert.equal(tracker.snapshot().size, 0);
});

test("session router store isolates subagents and expires entries", () => {
  let now = 0;
  const store = new SessionRouterStore({ capacity: 2, ttlMs: 10, now: () => now });
  const state = (sessionId: string, isSubagent = false) => ({ sessionId, isSubagent, orchestrating: false, updatedAt: now });
  store.set(state("s1"));
  store.set(state("s1", true));
  assert.deepEqual(store.get("s1", false), state("s1"));
  assert.deepEqual(store.get("s1", true), state("s1", true));
  store.set(state("s2"));
  assert.equal(store.get("s1", false), undefined);
  now = 20;
  assert.equal(store.get("s2", false), undefined);
  store.clear();
  assert.equal(store.size(), 0);
});

test("token tier parser accepts tags and plain known tiers", () => {
  assert.equal(parseTier("```xml\n<tier> REASONING </tier>\n```", ["simple", "reasoning"]), "reasoning");
  assert.equal(parseTier("This is a medium request.", ["simple", "medium"]), "medium");
  assert.equal(parseTier("unknown", ["simple", "medium"]), undefined);
});
