import assert from "node:assert/strict";
import test from "node:test";

import { SessionPlanTodoBundle } from "../../src/cli/SessionPlanTodoBundle.js";
import { PLAN_TODO_PROJECTION_NAME } from "../../src/plan-todo/projection/PlanTodoProjection.js";
import { InMemorySessionEventStore } from "../../src/session/events/InMemorySessionEventStore.js";
import { createDefaultSessionProjectionRegistry } from "../../src/session/projection/BuiltinSessionProjections.js";
import { SessionProjectionDriver } from "../../src/session/projection/SessionProjectionDriver.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import type { PlanStoragePort } from "../../src/tool/execution-world/PlanStoragePort.js";

const SESSION_ID = "session-plan-todo-bundle";
const TURN_ID = "turn-plan-todo-bundle";

test("session plan/todo bundle keeps plan files project-owned and todo state projection-backed", async () => {
  const events = new InMemorySessionEventStore();
  const projections = new SessionProjectionDriver({
    runtime: events,
    registry: createDefaultSessionProjectionRegistry(),
  });
  const transcript = new InMemoryTranscriptWriter({ eventStore: events });
  const storageCalls: string[] = [];
  const planStorage: PlanStoragePort = {
    ensureDirectory(path) { storageCalls.push(`ensure:${path}`); },
    readText(path) { storageCalls.push(`read:${path}`); return "# Durable plan\nShip it."; },
  };
  await events.append(SESSION_ID, TURN_ID, { type: "turn_started" });

  try {
    const result = new SessionPlanTodoBundle({
      sessionKey: SESSION_ID,
      projectRoot: "/project",
      storage: { transcript, projections },
      planStorage,
    }).compose();

    assert.equal(result.planFileManager.getPlanDirectoryPath(), "/project/.pilotdeck/plans");
    assert.equal(
      result.planFileManager.readPlanFile(".pilotdeck/plans/delivery.md", "/project"),
      "# Durable plan\nShip it.",
    );
    assert.deepEqual(storageCalls, [
      "ensure:/project/.pilotdeck/plans",
      "read:/project/.pilotdeck/plans/delivery.md",
    ]);

    const handle = result.planTodoManager.forSession(SESSION_ID);
    await handle.markPlanApproved("# Durable plan", { turnId: TURN_ID });
    await handle.writeTodos([
      { id: "implement", content: "Compose the capability", status: "in_progress" },
    ], { turnId: TURN_ID });

    assert.equal(handle.getSnapshot().approvedPlan, "# Durable plan");
    assert.deepEqual(handle.getSnapshot().todos.map((todo) => todo.id), ["implement"]);
    assert.deepEqual(
      projections.snapshot([PLAN_TODO_PROJECTION_NAME]).values[PLAN_TODO_PROJECTION_NAME],
      handle.getSnapshot(),
    );
    assert.throws(
      () => result.planTodoManager.forSession("other-session"),
      /belongs to session-plan-todo-bundle/,
    );
  } finally {
    projections.dispose();
  }
});
