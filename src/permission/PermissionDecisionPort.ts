import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../tool/index.js";
import type { PermissionDecision } from "./protocol/types.js";

/** Stable permission decision boundary consumed by ToolRuntime. */
export type PermissionDecisionPort = {
  decide(
    tool: PilotDeckToolDefinition,
    input: unknown,
    context: PilotDeckToolRuntimeContext,
    toolCallId: string,
  ): Promise<PermissionDecision>;
};
