import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { checkpointInteger, checkpointJsonSnapshot, checkpointRecord } from "../../session/projection/SessionProjectionCheckpointCodec.js";
import type { SessionProjectionDefinition } from "../../session/projection/SessionProjection.js";
import type { GoalPhase, GoalSnapshot, GoalStateSnapshot } from "../protocol/types.js";

export const GOAL_PROJECTION_NAME = "goal.state";

export function createGoalStateSnapshot(): GoalStateSnapshot {
  return { goal: null, revision: 0 };
}

export function createGoalProjectionDefinition(): SessionProjectionDefinition<GoalStateSnapshot> {
  return {
    name: GOAL_PROJECTION_NAME,
    version: 1,
    create: () => createGoalStateSnapshot(),
    reduce(state, entry) {
      if (entry.type !== "goal_changed") return state;
      if (entry.revision !== state.revision + 1) {
        throw new TypeError(`Goal revision must increase by one: expected ${state.revision + 1}, received ${entry.revision}.`);
      }
      const goal = entry.goal ? normalizeGoal(entry.goal) : null;
      if (goal && goal.revision !== entry.revision) {
        throw new TypeError("Goal snapshot revision must match the event revision.");
      }
      return { goal, revision: entry.revision };
    },
    checkpoint: {
      encode: (state) => checkpointJsonSnapshot(state, "goal"),
      decode: (value) => parseGoalStateSnapshot(value),
    },
  };
}

export function parseGoalStateSnapshot(value: unknown): GoalStateSnapshot {
  const record = checkpointRecord(value, "goal");
  const revision = checkpointInteger(record.revision, "goal.revision");
  if (record.goal === null) return { goal: null, revision };
  const goal = normalizeGoal(record.goal);
  if (goal.revision !== revision) throw new TypeError("goal checkpoint revision mismatch.");
  return { goal, revision };
}

function normalizeGoal(value: unknown): GoalSnapshot {
  const record = checkpointRecord(value, "goal.snapshot");
  if (
    typeof record.id !== "string" || record.id.trim().length === 0
    || typeof record.objective !== "string" || record.objective.trim().length === 0
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1
    || !["active", "paused", "blocked", "complete"].includes(String(record.phase))
    || (record.blockedReason !== undefined && typeof record.blockedReason !== "string")
    || (record.maxGoalRounds !== undefined && (!Number.isSafeInteger(record.maxGoalRounds) || (record.maxGoalRounds as number) < 1))
  ) {
    throw new TypeError("goal snapshot is invalid.");
  }
  const goal: GoalSnapshot = {
    id: record.id,
    revision: record.revision as number,
    objective: record.objective,
    phase: record.phase as GoalPhase,
    ...(typeof record.blockedReason === "string" && record.blockedReason.trim() ? { blockedReason: record.blockedReason } : {}),
    ...(record.maxGoalRounds !== undefined ? { maxGoalRounds: record.maxGoalRounds as number } : {}),
  };
  if (goal.phase === "blocked" && !goal.blockedReason) {
    throw new TypeError("Blocked goals require a reason.");
  }
  return goal;
}
