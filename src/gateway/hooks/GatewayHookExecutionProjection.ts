import type { PilotDeckHookExecutionEvent } from "../../extension/index.js";
import type { GatewayEvent } from "../protocol/types.js";

export type GatewayHookExecutionProjectionOptions = {
  /** The exact session scope this live projection belongs to. */
  sessionKey: string;
  emit: (event: GatewayEvent) => boolean;
};

/**
 * Project one session's volatile hook lifecycle into its active Gateway turn.
 *
 * Hook stdout and stderr deliberately remain in HookRuntime's execution
 * result. They are neither Gateway-visible nor durable session state.
 */
export function createGatewayHookExecutionProjection(
  options: GatewayHookExecutionProjectionOptions,
): (event: PilotDeckHookExecutionEvent) => void {
  return (event) => {
    if (event.sessionId !== options.sessionKey) return;
    options.emit(toGatewayHookExecutionStatus(event));
  };
}

export function toGatewayHookExecutionStatus(
  event: PilotDeckHookExecutionEvent,
): Extract<GatewayEvent, { type: "agent_status" }> {
  if (event.type === "started") {
    return {
      type: "agent_status",
      event: "hook_execution_started",
      detail: {
        hookName: event.hookName,
        hookEvent: event.hookEvent,
      },
    };
  }
  return {
    type: "agent_status",
    event: "hook_execution_completed",
    detail: {
      hookName: event.hookName,
      hookEvent: event.hookEvent,
      outcome: event.outcome,
      ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    },
  };
}
