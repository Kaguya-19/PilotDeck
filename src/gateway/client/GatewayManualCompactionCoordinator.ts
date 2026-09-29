import type { ManualCompactionResult } from "../../agent/session/ManualCompactionController.js";
import type { GatewayEvent } from "../protocol/types.js";
import type {
  GatewayManualCompactionCoordinatorPort,
  GatewayManualCompactionInput,
} from "./GatewayManualCompactionCoordinatorPort.js";

export type GatewayManualCompactionRouterPort = {
  compact(
    sessionKey: string,
    options: { turnId?: string; abortSignal?: AbortSignal },
  ): Promise<ManualCompactionResult>;
};

export type GatewayManualCompactionCoordinatorOptions = {
  router: GatewayManualCompactionRouterPort;
};

/**
 * Native command consumer for session-owned manual compaction.
 *
 * The Router remains responsible for the maintenance slot and the Session
 * remains responsible for its durable compaction transaction. This provider
 * only owns the command deadline and Gateway projection.
 */
export class GatewayManualCompactionCoordinator implements GatewayManualCompactionCoordinatorPort {
  constructor(private readonly options: GatewayManualCompactionCoordinatorOptions) {}

  async *execute(input: GatewayManualCompactionInput): AsyncIterable<GatewayEvent> {
    const timeoutController = new AbortController();
    const timeoutHandle = input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? setTimeout(() => timeoutController.abort(`timeout:${input.runId}`), input.timeoutMs)
      : undefined;
    try {
      const result = await this.options.router.compact(input.sessionKey, {
        turnId: input.runId,
        abortSignal: timeoutController.signal,
      });
      yield {
        type: "agent_status",
        runId: input.runId,
        event: "manual_compaction",
        detail: { outcome: result.type, turnId: result.turnId },
      };
      yield { type: "assistant_text_delta", text: manualCompactionText(result) };
      yield {
        type: "turn_completed",
        runId: input.runId,
        usage: result.usage,
        finishReason: result.type === "aborted" ? "aborted_streaming" : result.type === "failed" ? "model_error" : "completed",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const busy = /active turn|not idle|not available/i.test(message);
      yield {
        type: "error",
        runId: input.runId,
        code: busy ? "session_busy" : "manual_compaction_failed",
        message: busy
          ? "Compaction is unavailable because this session has an active turn or queued work."
          : message,
        recoverable: true,
        userHint: busy ? "Wait for the current work to finish, then run /compact again." : "Retry /compact after checking the session state.",
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

function manualCompactionText(result: ManualCompactionResult): string {
  switch (result.type) {
    case "compacted":
      return `Compacted ${result.messagesSummarized} history items (~${result.preTokens} tokens).`;
    case "skipped":
      return result.reason === "unavailable"
        ? "Compaction is unavailable for this session."
        : "No compactable history yet.";
    case "aborted":
      return "Compaction cancelled.";
    case "failed":
      return `Compaction failed: ${result.error}`;
  }
}
