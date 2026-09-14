import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryWorkflowEventStore,
  composeWorkflow,
  type WorkflowExecutionAdapter,
} from "../../src/workflow/index.js";

test("composition exposes caller-owned run and control projections without a registry", async () => {
  const calls: string[] = [];
  const adapter: WorkflowExecutionAdapter = {
    async execute(step) {
      calls.push(step.id);
      return { outcome: "completed", output: step.id };
    },
  };
  const { run, control } = await composeWorkflow({
    runId: "composed-run",
    ownerId: "caller",
    definition: { id: "composed", version: "1", steps: [{ id: "one" }, { id: "two", dependsOn: ["one"] }] },
    input: { requested: true },
    eventStore: new InMemoryWorkflowEventStore(),
    adapter,
  });
  assert.equal(control.status().status, "created");
  await control.start();
  assert.deepEqual(calls, ["one", "two"]);
  assert.equal(run.getSnapshot().status, "completed");
  assert.equal(control.status().runId, "composed-run");
});
