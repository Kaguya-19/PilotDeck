import type { BackgroundTaskCompletionEvent } from "../../task/index.js";
import type { GatewayEvent } from "../protocol/types.js";

export type GatewayBackgroundTaskCompletionProjectionOptions = {
  /** The exact session scope this volatile projection belongs to. */
  sessionKey: string;
  emit: (event: GatewayEvent) => boolean;
};

/** Project a session-owned background task completion into an active Gateway turn. */
export function createGatewayBackgroundTaskCompletionProjection(
  options: GatewayBackgroundTaskCompletionProjectionOptions,
): (event: BackgroundTaskCompletionEvent) => void {
  return (event) => {
    if (event.sessionId !== options.sessionKey) return;
    options.emit(toGatewayBackgroundTaskCompletionStatus(event));
  };
}

export function toGatewayBackgroundTaskCompletionStatus(
  event: BackgroundTaskCompletionEvent,
): Extract<GatewayEvent, { type: "agent_status" }> {
  const outputPreview = event.outputPreview.trimEnd();
  return {
    type: "agent_status",
    event: "background_task_completed",
    detail: {
      taskId: event.taskId,
      status: event.status,
      exitCode: event.exitCode ?? null,
      totalBytes: event.totalBytes,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      ...(outputPreview ? { outputPreview } : {}),
    },
  };
}
