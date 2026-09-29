import assert from "node:assert/strict";
import test from "node:test";

import { createNativeGoalRuntime } from "../../../src/goal/index.js";
import { InMemorySessionEventStore } from "../../../src/session/events/InMemorySessionEventStore.js";
import { createDefaultSessionProjectionRegistry } from "../../../src/session/projection/BuiltinSessionProjections.js";
import { SessionProjectionDriver } from "../../../src/session/projection/SessionProjectionDriver.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import { createCreateGoalTool, createGetGoalTool, createUpdateGoalTool } from "../../../src/tool/builtin/goal.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const sessionId = "goal-tool-session";
const turnId = "goal-tool-turn";

function context(goal: PilotDeckToolRuntimeContext["goal"]): PilotDeckToolRuntimeContext {
  return {
    sessionId, turnId, cwd: "/workspace", permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions", cwd: "/workspace", rules: { allow: [], deny: [], ask: [] },
      additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true,
    },
    goal,
  };
}

test("goal tools are real consumers of the session goal runtime", async () => {
  const events = new InMemorySessionEventStore();
  const projections = new SessionProjectionDriver({ runtime: events, registry: createDefaultSessionProjectionRegistry() });
  const transcript = new InMemoryTranscriptWriter({ eventStore: events });
  await events.append(sessionId, turnId, { type: "turn_started" });
  const goal = createNativeGoalRuntime({ sessionId, transcript, projections, uuid: () => "tool" }).forSession(sessionId);

  const created = await createCreateGoalTool().execute({ objective: "Deliver durable goals" }, context(goal));
  assert.equal((created.data as { revision: number }).revision, 1);
  const read = await createGetGoalTool().execute({}, context(goal));
  assert.equal((read.data as { objective: string }).objective, "Deliver durable goals");
  const updated = await createUpdateGoalTool().execute({ action: "complete", expected_revision: 1 }, context(goal));
  assert.equal((updated.data as { phase: string }).phase, "complete");
  await assert.rejects(
    createUpdateGoalTool().execute({ action: "pause", expected_revision: 1 }, context(goal)),
    /Goal revision conflict/,
  );
  projections.dispose();
});

test("goal tools fail clearly when no provider is composed", async () => {
  await assert.rejects(
    createGetGoalTool().execute({}, context(undefined)),
    /session-scoped goal provider/,
  );
});
