import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryWorkflowEventStore,
  JsonlWorkflowEventStore,
  WorkflowRun,
  type WorkflowExecutionAdapter,
} from "../../src/workflow/index.js";

const definition = {
  id: "jsonl-demo",
  version: "1",
  steps: [{ id: "prepare" }],
} as const;

const adapter: WorkflowExecutionAdapter = {
  async execute() {
    return { outcome: "completed", output: { delivered: true } };
  },
};

test("JSONL workflow EventStore preserves owner-bound event replay across a new provider instance", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-workflow-events-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = new JsonlWorkflowEventStore({ directory });
  const run = await WorkflowRun.create({
    runId: "caller/run:1",
    ownerId: "project-owner",
    definition,
    input: { request: "deliver" },
    eventStore: initial,
    adapter,
  });
  await run.start();

  const reopened = new JsonlWorkflowEventStore({ directory });
  const restored = await WorkflowRun.restore({
    runId: "caller/run:1",
    ownerId: "project-owner",
    eventStore: reopened,
    adapter,
  });
  assert.equal(restored.getSnapshot().status, "completed");
  assert.deepEqual(restored.getSnapshot().input, { request: "deliver" });
  assert.deepEqual((await reopened.read("caller/run:1")).map((event) => event.sequence), [1, 2, 3, 4, 5]);
  await assert.rejects(() => reopened.append({
    runId: "caller/run:1",
    ownerId: "other-owner",
    type: "run_started",
  }), /different owner/);
});

test("JSONL workflow EventStore atomically refuses duplicate run creation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-workflow-events-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JsonlWorkflowEventStore({ directory });
  await Promise.all([
    store.create({ runId: "same", ownerId: "owner", type: "run_created", definition, input: null }),
    assert.rejects(
      store.create({ runId: "same", ownerId: "owner", type: "run_created", definition, input: null }),
      /already exists/,
    ),
  ]);
});

test("InMemory workflow EventStore keeps sequence cursors independent per run", async () => {
  const store = new InMemoryWorkflowEventStore();
  for (const runId of ["run-a", "run-b"] as const) {
    await store.create({
      runId,
      ownerId: "owner",
      type: "run_created",
      definition: { id: runId, version: "1", steps: [{ id: "step" }] },
      input: runId,
    });
    await store.append({ runId, ownerId: "owner", type: "run_started" });
  }

  assert.deepEqual((await store.read("run-a")).map((event) => event.sequence), [1, 2]);
  assert.deepEqual((await store.read("run-b")).map((event) => event.sequence), [1, 2]);
});

test("JSONL workflow EventStore rejects a malformed or non-contiguous durable log", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-workflow-events-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runId = "broken";
  const filename = `${Buffer.from(runId, "utf8").toString("base64url")}.jsonl`;
  writeFileSync(join(directory, filename), [
    JSON.stringify({ sequence: 1, runId, ownerId: "owner", type: "run_created", definition, input: null }),
    JSON.stringify({ sequence: 3, runId, ownerId: "owner", type: "run_started" }),
  ].join("\n"));
  const store = new JsonlWorkflowEventStore({ directory });
  await assert.rejects(() => store.read(runId), /non-contiguous sequence/);

  writeFileSync(join(directory, filename), "{not-json}\n");
  await assert.rejects(() => store.read(runId), /invalid JSON/);

  writeFileSync(join(directory, filename), JSON.stringify({
    sequence: 1,
    runId,
    ownerId: "owner",
    type: "run_created",
    definition,
    input: null,
  }) + "\n" + JSON.stringify({
    sequence: 2,
    runId,
    ownerId: "owner",
    type: "made_up_event",
  }) + "\n");
  await assert.rejects(() => store.read(runId), /invalid event/);
});
