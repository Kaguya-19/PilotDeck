import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryWorkflowEventStore,
  InvalidWorkflowDefinitionError,
  WorkflowRun,
  WorkflowRunBindingError,
  type WorkflowExecutionAdapter,
  type WorkflowEvent,
  type WorkflowEventStore,
} from "../../src/workflow/index.js";

const definition = {
  id: "demo",
  version: "1",
  steps: [
    { id: "prepare" },
    { id: "publish", dependsOn: ["prepare"], capability: "publish" },
  ],
} as const;

function adapterFor(
  handler: WorkflowExecutionAdapter["execute"],
): WorkflowExecutionAdapter {
  return { execute: handler };
}

test("validates duplicate, missing dependency, and cyclic definitions", async () => {
  const store = new InMemoryWorkflowEventStore();
  await assert.rejects(
    () => WorkflowRun.create({
      runId: "invalid",
      ownerId: "caller",
      definition: { id: "bad", version: "1", steps: [{ id: "a" }, { id: "a" }] },
      input: null,
      eventStore: store,
      adapter: adapterFor(async () => ({ outcome: "completed" })),
    }),
    InvalidWorkflowDefinitionError,
  );
  await assert.rejects(
    () => WorkflowRun.create({
      runId: "missing",
      ownerId: "caller",
      definition: { id: "bad", version: "1", steps: [{ id: "a", dependsOn: ["missing"] }] },
      input: null,
      eventStore: store,
      adapter: adapterFor(async () => ({ outcome: "completed" })),
    }),
    InvalidWorkflowDefinitionError,
  );
  await assert.rejects(
    () => WorkflowRun.create({
      runId: "cycle",
      ownerId: "caller",
      definition: { id: "bad", version: "1", steps: [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }] },
      input: null,
      eventStore: store,
      adapter: adapterFor(async () => ({ outcome: "completed" })),
    }),
    InvalidWorkflowDefinitionError,
  );
});

test("executes dependency-ordered steps and settles exactly once", async () => {
  const store = new InMemoryWorkflowEventStore();
  const calls: string[] = [];
  const run = await WorkflowRun.create({
    runId: "run-1",
    ownerId: "caller",
    definition,
    input: { request: "publish" },
    eventStore: store,
    adapter: adapterFor(async (step, context) => {
      calls.push(`${step.id}:${context.completed.size}`);
      return { outcome: "completed", output: `${step.id}-output` };
    }),
  });
  await run.start();
  await run.start();
  assert.deepEqual(calls, ["prepare:0", "publish:1"]);
  assert.equal(run.getSnapshot().status, "completed");
  assert.deepEqual(run.getSnapshot().steps.map((step) => step.status), ["completed", "completed"]);
  assert.equal((await store.read("run-1")).filter((event) => event.type === "run_completed").length, 1);
});

test("notifies a read-only observer in committed order and isolates observer failures", async () => {
  const observed: string[] = [];
  const run = await WorkflowRun.create({
    runId: "observed-run",
    ownerId: "owner",
    definition: { id: "observed", version: "1", steps: [{ id: "step" }] },
    input: null,
    eventStore: new InMemoryWorkflowEventStore(),
    adapter: { async execute() { return { outcome: "completed", output: 1 }; } },
    eventObserver: (event) => {
      observed.push(`${event.sequence}:${event.type}`);
      throw new Error("observer must not break the run");
    },
  });
  await run.start();
  assert.deepEqual(observed, [
    "1:run_created",
    "2:run_started",
    "3:step_started",
    "4:step_completed",
    "5:run_completed",
  ]);
  assert.equal(run.getSnapshot().status, "completed");
});

test("pause requested during a step stops at the step boundary and resumes", async () => {
  const store = new InMemoryWorkflowEventStore();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const run = await WorkflowRun.create({
    runId: "run-pause",
    ownerId: "caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async (step) => {
      if (step.id === "prepare") await blocked;
      return { outcome: "completed" };
    }),
  });
  const started = run.start();
  await new Promise((resolve) => setImmediate(resolve));
  await run.pause();
  release();
  await started;
  assert.equal(run.getSnapshot().status, "paused");
  await run.start();
  assert.equal(run.getSnapshot().status, "completed");
  assert.deepEqual((await store.read("run-pause")).filter((event) => event.type === "run_paused").length, 1);
});

test("cancel aborts a running step and late completion cannot settle success", async () => {
  const store = new InMemoryWorkflowEventStore();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const run = await WorkflowRun.create({
    runId: "run-cancel",
    ownerId: "caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async () => {
      await blocked;
      return { outcome: "completed", output: "late" };
    }),
  });
  const started = run.start();
  await new Promise((resolve) => setImmediate(resolve));
  await run.cancel();
  release();
  await started;
  assert.equal(run.getSnapshot().status, "cancelled");
  const events = await store.read("run-cancel");
  assert.equal(events.filter((event) => event.type === "run_cancelled").length, 1);
  assert.equal(events.filter((event) => event.type === "run_completed").length, 0);
});

test("unknown step settles run unknown and restore replays owner-scoped state", async () => {
  const store = new InMemoryWorkflowEventStore();
  const run = await WorkflowRun.create({
    runId: "run-unknown",
    ownerId: "caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async (step) => step.id === "prepare"
      ? { outcome: "unknown", code: "SIDE_EFFECT_STATUS_UNAVAILABLE", message: "status unavailable" }
      : { outcome: "completed" }),
  });
  await run.start();
  assert.equal(run.getSnapshot().status, "unknown");
  const restored = await WorkflowRun.restore({
    runId: "run-unknown",
    ownerId: "caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async () => ({ outcome: "completed" })),
  });
  assert.equal(restored.getSnapshot().status, "unknown");
  await assert.rejects(() => WorkflowRun.restore({
    runId: "run-unknown",
    ownerId: "other-caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async () => ({ outcome: "completed" })),
  }));
});

test("serializes concurrent start/cancel and does not run a step before its start event commits", async () => {
  const events: WorkflowEvent["type"][] = [];
  let releaseStart!: () => void;
  const startAppend = new Promise<void>((resolve) => { releaseStart = resolve; });
  const store: WorkflowEventStore = {
    async create(event) {
      events.push(event.type);
      return { ...event, sequence: events.length };
    },
    async append(event) {
      if (event.type === "run_started") await startAppend;
      events.push(event.type);
      return { ...event, sequence: events.length };
    },
    async read() { return []; },
  };
  let executions = 0;
  const run = await WorkflowRun.create({
    runId: "run-concurrent-cancel",
    ownerId: "caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async () => {
      executions += 1;
      return { outcome: "completed" };
    }),
  });
  const starting = run.start();
  const cancelling = run.cancel();
  releaseStart();
  await Promise.all([starting, cancelling]);
  assert.equal(executions, 0);
  assert.equal(run.getSnapshot().status, "cancelled");
  assert.deepEqual(events, ["run_created", "run_started", "run_cancel_requested", "run_cancelled"]);
});

test("restore settles an interrupted running step as unknown without re-executing it", async () => {
  const store = new InMemoryWorkflowEventStore();
  await store.create({ runId: "run-interrupted", ownerId: "caller", type: "run_created", definition, input: null });
  await store.append({ runId: "run-interrupted", ownerId: "caller", type: "run_started" });
  await store.append({ runId: "run-interrupted", ownerId: "caller", type: "step_started", stepId: "prepare" });
  let executions = 0;
  const restored = await WorkflowRun.restore({
    runId: "run-interrupted",
    ownerId: "caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async () => {
      executions += 1;
      return { outcome: "completed" };
    }),
  });
  assert.equal(restored.getSnapshot().status, "unknown");
  assert.equal(restored.getSnapshot().steps[0]?.status, "unknown");
  await restored.start();
  assert.equal(executions, 0);
  assert.deepEqual((await store.read("run-interrupted")).slice(-2).map((event) => event.type), ["step_unknown", "run_unknown"]);
});

test("event-store failure surfaces unknown local state without executing a duplicate step", async () => {
  const events: WorkflowEvent[] = [];
  const store: WorkflowEventStore = {
    async create(event) {
      const committed = { ...event, sequence: events.length + 1 };
      events.push(committed);
      return committed;
    },
    async append(event) {
      if (event.type === "step_completed") throw new Error("store unavailable");
      const committed = { ...event, sequence: events.length + 1 };
      events.push(committed);
      return committed;
    },
    async read() { return events; },
  };
  let executions = 0;
  const run = await WorkflowRun.create({
    runId: "run-store-failure",
    ownerId: "caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async () => {
      executions += 1;
      return { outcome: "completed" };
    }),
  });
  await assert.rejects(() => run.start(), /store unavailable/);
  assert.equal(executions, 1);
  assert.equal(run.getSnapshot().status, "unknown");
  assert.equal(run.getSnapshot().steps[0]?.status, "unknown");
});

test("create rejects a duplicate run identity and restore uses its durable definition and input", async () => {
  const store = new InMemoryWorkflowEventStore();
  const input = { request: "publish", nested: { stable: true } };
  await WorkflowRun.create({
    runId: "bound-run",
    ownerId: "caller",
    definition,
    input,
    eventStore: store,
    adapter: adapterFor(async () => ({ outcome: "completed" })),
  });
  await assert.rejects(() => WorkflowRun.create({
    runId: "bound-run",
    ownerId: "caller",
    definition,
    input,
    eventStore: store,
    adapter: adapterFor(async () => ({ outcome: "completed" })),
  }), /already exists/);

  const restored = await WorkflowRun.restore({
    runId: "bound-run",
    ownerId: "caller",
    eventStore: store,
    adapter: adapterFor(async () => ({ outcome: "completed" })),
  });
  assert.deepEqual(restored.getSnapshot().input, input);
  await assert.rejects(() => WorkflowRun.restore({
    runId: "bound-run",
    ownerId: "caller",
    definition: { ...definition, version: "2" },
    eventStore: store,
    adapter: adapterFor(async () => ({ outcome: "completed" })),
  }), WorkflowRunBindingError);
  await assert.rejects(() => WorkflowRun.restore({
    runId: "bound-run",
    ownerId: "caller",
    input: { request: "other" },
    eventStore: store,
    adapter: adapterFor(async () => ({ outcome: "completed" })),
  }), WorkflowRunBindingError);
});

test("deadline settles as a failed workflow and is distinct from cancellation", async () => {
  const store = new InMemoryWorkflowEventStore();
  let observedAbort = false;
  const run = await WorkflowRun.create({
    runId: "deadline-run",
    ownerId: "caller",
    definition,
    input: null,
    deadlineAt: Date.now() + 5,
    eventStore: store,
    adapter: adapterFor(async (_step, context) => {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          observedAbort = true;
          resolve();
          return;
        }
        context.signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
      return { outcome: "completed" };
    }),
  });
  await run.start();
  assert.equal(observedAbort, true);
  assert.equal(run.getSnapshot().status, "failed");
  const terminal = (await store.read("deadline-run")).find((event) => event.type === "run_failed");
  assert.equal(terminal?.code, "WORKFLOW_DEADLINE_EXCEEDED");
  assert.equal((await store.read("deadline-run")).some((event) => event.type === "run_cancelled"), false);
});

test("dispose drains an admitted step, settles cancellation once, and rejects later starts", async () => {
  const store = new InMemoryWorkflowEventStore();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const run = await WorkflowRun.create({
    runId: "dispose-run",
    ownerId: "caller",
    definition,
    input: null,
    eventStore: store,
    adapter: adapterFor(async () => {
      await blocked;
      return { outcome: "completed" };
    }),
  });
  const started = run.start();
  await new Promise((resolve) => setImmediate(resolve));
  const disposed = run.dispose();
  release();
  await Promise.all([started, disposed]);
  assert.equal(run.getSnapshot().status, "cancelled");
  assert.equal((await store.read("dispose-run")).filter((event) => event.type === "run_cancelled").length, 1);
  await run.dispose();
  await run.start();
  assert.equal(run.getSnapshot().status, "cancelled");
});
