import assert from "node:assert/strict";
import test from "node:test";

import {
  TelemetryObserverRegistry,
  createObservingTelemetryClient,
  type TelemetryClient,
  type TelemetryConfig,
} from "../../src/telemetry/index.js";

test("telemetry observer replacement publishes before an in-flight observation drains", async () => {
  const registry = new TelemetryObserverRegistry();
  let releaseOld!: () => void;
  let oldDisposed = 0;
  const oldStarted = new Promise<void>((resolve) => {
    registry.register("extension", {
      async observe() {
        resolve();
        await new Promise<void>((done) => { releaseOld = done; });
      },
      dispose() {
        oldDisposed += 1;
      },
    });
  });

  registry.observe(trackObservation("old"));
  await oldStarted;
  const replacement = registry.replace("extension", {
    observe() {},
  });

  assert.equal(replacement.registration.generation, 2);
  assert.equal(oldDisposed, 0);
  releaseOld();
  await replacement.previousDisposed;
  assert.equal(oldDisposed, 1);

  await registry.dispose();
});

test("observing telemetry preserves the client call and isolates observer failures", async () => {
  const failures: string[] = [];
  const registry = new TelemetryObserverRegistry({
    onObserverFailure: (failure) => failures.push(`${failure.name}:${(failure.error as Error).message}`),
  });
  const base = createFakeTelemetry();
  const seen: string[] = [];
  registry.register("broken", {
    observe() {
      throw new Error("observer failure");
    },
  });
  registry.register("healthy", {
    observe(observation) {
      seen.push(observation.type);
    },
  });

  const telemetry = createObservingTelemetryClient(base.client, registry);
  telemetry.track("feature_used", { source: "test" }, { sessionId: "session-1" });
  telemetry.trackFeatureLoopStage({ module: "session", loopStage: "loop_start" });
  telemetry.trackError(new Error("base error"), { module: "session" });

  assert.deepEqual(base.calls, ["track:feature_used", "feature_loop_stage", "error"]);
  assert.deepEqual(seen, ["track", "feature_loop_stage", "error"]);
  assert.deepEqual(failures, [
    "broken:observer failure",
    "broken:observer failure",
    "broken:observer failure",
  ]);

  await registry.dispose();
});

test("registry stop-new waits for async observer completion before disposal", async () => {
  const registry = new TelemetryObserverRegistry();
  let release!: () => void;
  let disposed = 0;
  const started = new Promise<void>((resolve) => {
    registry.register("async", {
      async observe() {
        resolve();
        await new Promise<void>((done) => { release = done; });
      },
      dispose() {
        disposed += 1;
      },
    });
  });

  registry.observe(trackObservation("before-stop"));
  await started;
  const closing = registry.dispose();
  assert.equal(registry.state, "draining");
  registry.observe(trackObservation("after-stop"));
  assert.equal(disposed, 0);

  release();
  await closing;
  assert.equal(registry.state, "disposed");
  assert.equal(disposed, 1);
  assert.throws(() => registry.register("late", { observe() {} }), /registry is disposed/);
});

function trackObservation(source: string) {
  return {
    type: "track" as const,
    eventName: "feature_used" as const,
    properties: { source },
    context: {},
  };
}

function createFakeTelemetry(): { client: TelemetryClient; calls: string[] } {
  const calls: string[] = [];
  const config = {} as TelemetryConfig;
  return {
    calls,
    client: {
      track(eventName) {
        calls.push(`track:${eventName}`);
      },
      trackFeatureUsed() {
        calls.push("feature_used");
      },
      trackFeatureLoopStage() {
        calls.push("feature_loop_stage");
      },
      trackError() {
        calls.push("error");
      },
      setEnabled() {},
      async flush() {},
      async shutdown() {},
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
      getConfig() {
        return config;
      },
    },
  };
}
