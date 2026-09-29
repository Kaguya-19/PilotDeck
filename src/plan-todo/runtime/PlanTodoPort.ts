import type { PilotDeckPlanTodoStateHandle } from "../../tool/protocol/types.js";

/**
 * Session-bound plan/todo capability consumed by the agent runtime.
 *
 * The port deliberately returns the existing tool-facing handle shape so the
 * core loop can consume it without knowing which persistence provider owns it.
 */
export type PlanTodoPort = {
  forSession(sessionId: string): PilotDeckPlanTodoStateHandle;
};
