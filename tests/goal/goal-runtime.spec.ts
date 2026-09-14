import assert from "node:assert/strict";
import test from "node:test";

import { createNativeGoalRuntime } from "../../src/goal/index.js";
import { GOAL_PROJECTION_NAME } from "../../src/goal/projection/GoalProjection.js";
import { InMemorySessionEventStore } from "../../src/session/events/InMemorySessionEventStore.js";
import { createDefaultSessionProjectionRegistry } from "../../src/session/projection/BuiltinSessionProjections.js";
import { SessionProjectionDriver } from "../../src/session/projection/SessionProjectionDriver.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

const SESSION_ID = "goal-session";
const TURN_ID = "goal-turn";

test("native goal runtime persists, enforces CAS, and restores from checkpoint", async () => {
  const events = new InMemorySessionEventStore({ now: () => new Date("2026-09-12T00:00:00.000Z") });
  const projections = new SessionProjectionDriver({ runtime: events, registry: createDefaultSessionProjectionRegistry() });
  const transcript = new InMemoryTranscriptWriter({ eventStore: events });
  await events.append(SESSION_ID, TURN_ID, { type: "turn_started" });
  const runtime = createNativeGoalRuntime({ sessionId: SESSION_ID, transcript, projections, uuid: () => "fixed" });
  const goal = runtime.forSession(SESSION_ID);

  const created = await goal.create("Ship the DSH roadmap", { maxGoalRounds: 3, turnId: TURN_ID });
  assert.deepEqual(created, {
    id: "goal-fixed", revision: 1, objective: "Ship the DSH roadmap", phase: "active", maxGoalRounds: 3,
  });
  const paused = await goal.update({ action: "pause", expectedRevision: 1, turnId: TURN_ID });
  assert.equal(paused?.phase, "paused");
  await assert.rejects(
    goal.update({ action: "resume", expectedRevision: 1, turnId: TURN_ID }),
    /Goal revision conflict/,
  );
  const cleared = await goal.update({ action: "clear", expectedRevision: 2, turnId: TURN_ID });
  assert.equal(cleared, null);
  assert.deepEqual(goal.getSnapshot(), { goal: null, revision: 3 });
  await assert.rejects(
    events.append(SESSION_ID, TURN_ID, {
      type: "goal_changed",
      revision: 5,
      goal: { id: "skipped", revision: 5, objective: "Invalid skipped revision", phase: "active" },
    }),
    /Goal revision must increase/,
  );

  const { entries } = await events.read();
  assert.deepEqual(entries.map((entry) => entry.type), ["turn_started", "goal_changed", "goal_changed", "goal_changed"]);
  const restoredEvents = new InMemorySessionEventStore();
  restoredEvents.restore(entries);
  const restoredProjections = new SessionProjectionDriver({
    runtime: restoredEvents,
    registry: createDefaultSessionProjectionRegistry(),
    entries,
    checkpoint: projections.checkpoint(),
  });
  const restored = createNativeGoalRuntime({
    sessionId: SESSION_ID,
    transcript: new InMemoryTranscriptWriter({ eventStore: restoredEvents }),
    projections: restoredProjections,
  }).forSession(SESSION_ID);
  assert.deepEqual(restored.getSnapshot(), goal.getSnapshot());
  assert.deepEqual(
    projections.snapshot([GOAL_PROJECTION_NAME]).values[GOAL_PROJECTION_NAME],
    goal.getSnapshot(),
  );
  projections.dispose();
  restoredProjections.dispose();
});

test("goal runtime is session-bound and blocked goals require a reason", async () => {
  const events = new InMemorySessionEventStore();
  const projections = new SessionProjectionDriver({ runtime: events, registry: createDefaultSessionProjectionRegistry() });
  const transcript = new InMemoryTranscriptWriter({ eventStore: events });
  await events.append(SESSION_ID, TURN_ID, { type: "turn_started" });
  const goal = createNativeGoalRuntime({ sessionId: SESSION_ID, transcript, projections }).forSession(SESSION_ID);
  await assert.rejects(
    goal.create("", { turnId: TURN_ID }),
    /objective must not be empty/,
  );
  await goal.create("A goal", { turnId: TURN_ID });
  await assert.rejects(
    goal.update({ action: "block", turnId: TURN_ID }),
    /Blocked goals require a reason/,
  );
  assert.throws(() => createNativeGoalRuntime({ sessionId: SESSION_ID, transcript, projections }).forSession("other"), /belongs to/);
  projections.dispose();
});
