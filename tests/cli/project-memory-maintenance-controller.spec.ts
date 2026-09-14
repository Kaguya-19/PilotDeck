import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectMemoryMaintenanceController,
  type ProjectMemoryMaintenanceRuntime,
} from "../../src/cli/ProjectMemoryMaintenanceController.js";

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value | PromiseLike<Value>): void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  return {
    promise: new Promise<Value>((resolve_) => { resolve = resolve_; }),
    resolve,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected maintenance controller to settle.");
}

function createTelemetry() {
  const successes: unknown[] = [];
  const errors: Array<{ error: unknown; input: unknown }> = [];
  return {
    successes,
    errors,
    telemetry: {
      trackFeatureLoopStage(input: unknown) { successes.push(input); },
      trackError(error: unknown, input: unknown) { errors.push({ error, input }); },
    },
  };
}

test("memory maintenance controller is a no-op when the resolved generation has no service", async () => {
  const telemetry = createTelemetry();
  const runtime: ProjectMemoryMaintenanceRuntime = { projectRoot: "/project" };
  const controller = new ProjectMemoryMaintenanceController({
    resolveRuntime: () => runtime,
    telemetry: telemetry.telemetry,
  });

  controller.schedule("/project");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(telemetry.successes, []);
  assert.deepEqual(telemetry.errors, []);
});

test("memory maintenance controller coalesces repeated requests for one generation", async () => {
  const telemetry = createTelemetry();
  const first = deferred<void>();
  let calls = 0;
  const runtime: ProjectMemoryMaintenanceRuntime = {
    projectRoot: "/project",
    memoryService: {
      async runDueScheduledMaintenance() {
        calls += 1;
        if (calls === 1) await first.promise;
        return undefined as never;
      },
    },
  };
  const controller = new ProjectMemoryMaintenanceController({
    resolveRuntime: () => runtime,
    telemetry: telemetry.telemetry,
  });

  controller.schedule("/project");
  await waitFor(() => calls === 1);
  controller.schedule("/project");
  controller.schedule("/project");
  assert.equal(calls, 1);

  first.resolve();
  await waitFor(() => calls === 2 && telemetry.successes.length === 2);
  assert.equal(calls, 2);
  assert.equal(telemetry.errors.length, 0);
});

test("memory maintenance controller records failures without rejecting the completed turn path", async () => {
  const telemetry = createTelemetry();
  const diagnostics: Array<{ message: string; error: unknown }> = [];
  const failure = new TypeError("maintenance failed");
  const runtime: ProjectMemoryMaintenanceRuntime = {
    projectRoot: "/project",
    memoryService: {
      async runDueScheduledMaintenance() { throw failure; },
    },
  };
  const controller = new ProjectMemoryMaintenanceController({
    resolveRuntime: () => runtime,
    telemetry: telemetry.telemetry,
    onDiagnostic(message, error) { diagnostics.push({ message, error }); },
  });

  controller.schedule("/project");
  await waitFor(() => telemetry.errors.length === 1);
  assert.equal(telemetry.successes.length, 0);
  assert.equal(telemetry.errors[0].error, failure);
  assert.deepEqual(diagnostics, [{
    message: "[pilotdeck] memory maintenance failed for project /project:",
    error: failure,
  }]);
});

test("memory maintenance state stays attached to an exact runtime generation across replacement", async () => {
  const telemetry = createTelemetry();
  const oldRun = deferred<void>();
  let oldCalls = 0;
  let newCalls = 0;
  const oldRuntime: ProjectMemoryMaintenanceRuntime = {
    projectRoot: "/project",
    memoryService: {
      async runDueScheduledMaintenance() {
        oldCalls += 1;
        await oldRun.promise;
        return undefined as never;
      },
    },
  };
  const newRuntime: ProjectMemoryMaintenanceRuntime = {
    projectRoot: "/project",
    memoryService: {
      async runDueScheduledMaintenance() {
        newCalls += 1;
        return undefined as never;
      },
    },
  };
  let current = oldRuntime;
  const controller = new ProjectMemoryMaintenanceController({
    resolveRuntime: () => current,
    telemetry: telemetry.telemetry,
  });

  controller.schedule("/project");
  await waitFor(() => oldCalls === 1);
  current = newRuntime;
  controller.schedule("/project");
  await waitFor(() => newCalls === 1);
  oldRun.resolve();
  await waitFor(() => telemetry.successes.length === 2);

  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);
});
