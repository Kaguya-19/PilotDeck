export { GoalConflictError } from "./protocol/errors.js";
export type { GoalPort, GoalSessionPort, GoalSnapshot, GoalStateSnapshot, GoalUpdate, GoalPhase } from "./protocol/types.js";
export { GOAL_PROJECTION_NAME, createGoalProjectionDefinition, createGoalStateSnapshot, parseGoalStateSnapshot } from "./projection/GoalProjection.js";
export { NativeGoalRuntime, createNativeGoalRuntime, type NativeGoalRuntimeOptions } from "./runtime/NativeGoalRuntime.js";
