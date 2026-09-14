import type {
  PilotDeckToolCall,
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
  PilotDeckToolScheduler,
} from "../../../tool/index.js";
import type { AgentExecutionContext, ToolPort } from "../protocol.js";
import { withOperationDeadlineBudget } from "./executionDeadline.js";

/** Native provider adapter from PilotDeck's ToolScheduler to the stable ToolPort definition. */
export function createToolSchedulerPort(
  registry: { list(): PilotDeckToolDefinition[] },
  scheduler: PilotDeckToolScheduler,
): ToolPort {
  return {
    list: () => registry.list(),
    executeAll: (
      calls: PilotDeckToolCall[],
      context: PilotDeckToolRuntimeContext,
      execution: AgentExecutionContext,
    ) => scheduler.executeAll(calls, withOperationDeadlineBudget(context, execution)),
  };
}
