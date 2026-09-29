import { registerAgentTranscriptProjections } from "./AgentTranscriptProjections.js";
import { registerFileHistoryProjections } from "./FileHistoryProjection.js";
import { createPlanTodoProjectionDefinition } from "../../plan-todo/projection/PlanTodoProjection.js";
import { SessionProjectionRegistry } from "./SessionProjectionRegistry.js";
import { registerWebHistoryProjections } from "./WebHistoryProjections.js";
import { createGoalProjectionDefinition } from "../../goal/projection/GoalProjection.js";

export function createDefaultSessionProjectionRegistry(): SessionProjectionRegistry {
  const registry = new SessionProjectionRegistry();
  registerAgentTranscriptProjections(registry);
  registerFileHistoryProjections(registry);
  registerWebHistoryProjections(registry);
  registry.register(createPlanTodoProjectionDefinition());
  registry.register(createGoalProjectionDefinition());
  return registry;
}
