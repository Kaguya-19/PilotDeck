import { randomUUID } from "node:crypto";
import type { AgentContextRuntime, AutoCompactResult } from "../../context/index.js";
import { createDurableContextRuntime } from "../modules/context/durableContextRuntime.js";
import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { AgentSessionEventRecorder } from "./AgentSessionEventRecorder.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import type { AgentControlBoundaryTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { CompactionResult } from "../../context/compaction/CompactionEngine.js";

export type ManualCompactionRequest = {
  abortSignal: AbortSignal;
  turnId?: string;
};

export type ManualCompactionResult =
  | {
      type: "compacted";
      turnId: string;
      compactionId: string;
      preTokens: number;
      postTokens?: number;
      messagesSummarized: number;
      usage: CanonicalUsage;
    }
  | { type: "skipped"; turnId: string; reason: "no_compactable_history" | "unavailable"; usage: CanonicalUsage }
  | { type: "aborted"; turnId: string; error: string; usage: CanonicalUsage }
  | { type: "failed"; turnId: string; error: string; usage: CanonicalUsage };

export type ManualCompactionControllerOptions = {
  sessionId: string;
  context?: AgentContextRuntime;
  recorder: AgentSessionEventRecorder;
  transcript: AgentTranscriptWriter;
  messages: () => CanonicalMessage[];
  now?: () => Date;
  uuid?: () => string;
};

/**
 * Session-owned manual compaction consumer.
 *
 * It reserves an AgentHandle maintenance slot outside this class, writes the
 * same durable bracket used by automatic compaction, and never runs the main
 * AgentLoop or accepts a synthetic user input.
 */
export class ManualCompactionController {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly context: AgentContextRuntime | undefined;

  constructor(private readonly options: ManualCompactionControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.context = options.context
      ? createDurableContextRuntime(options.context, options.recorder)
      : undefined;
  }

  async compact(request: ManualCompactionRequest): Promise<ManualCompactionResult> {
    const turnId = request.turnId ?? this.uuid();
    const startedAt = this.now().toISOString();
    await this.options.recorder.startTurn(this.options.sessionId, turnId);

    if (!this.context?.tryAutoCompact) {
      const operationId = this.options.recorder.nextCompactionOperationId();
      await this.options.recorder.recordCompactionStarted(this.options.sessionId, turnId, {
        operationId,
        trigger: "manual",
        messageCount: this.options.messages().length,
      });
      await this.options.recorder.recordCompactionCompleted(this.options.sessionId, turnId, {
        operationId,
        status: "skipped",
        messageCount: this.options.messages().length,
      });
      const result = successTurnResult(this.options.sessionId, turnId, startedAt, this.now().toISOString(), {});
      await this.options.recorder.completeTurn(result);
      return { type: "skipped", turnId, reason: "unavailable", usage: {} };
    }

    try {
      throwIfAborted(request.abortSignal);
      const compact = await this.context.tryAutoCompact({
        sessionId: this.options.sessionId,
        turnId,
        trigger: "manual",
        manualForce: true,
        messages: this.options.messages(),
        abortSignal: request.abortSignal,
      });
      throwIfAborted(request.abortSignal);

      if (compact.type === "skipped") {
        const result = successTurnResult(this.options.sessionId, turnId, startedAt, this.now().toISOString(), {});
        await this.options.recorder.completeTurn(result);
        return { type: "skipped", turnId, reason: "no_compactable_history", usage: {} };
      }

      const compaction = compact.result;
      if (!compaction || compaction.error !== undefined || compaction.summaryMessage === undefined) {
        throw new Error("Manual compaction provider returned no durable replacement result.");
      }
      await this.persistReplacement(turnId, compact, compaction);

      const usage = compaction.summaryUsage ?? {};
      const result = successTurnResult(this.options.sessionId, turnId, startedAt, this.now().toISOString(), usage);
      await this.options.recorder.completeTurn(result);
      return {
        type: "compacted",
        turnId,
        compactionId: compaction.compactionId,
        preTokens: compaction.preTokens,
        postTokens: compact.snapshot.tokens,
        messagesSummarized: compaction.messagesSummarized,
        usage,
      };
    } catch (error) {
      const aborted = request.abortSignal.aborted;
      const message = errorMessage(error);
      // `tryAutoCompact` defers a successful compact lifecycle until its
      // replacement is written. Cancellation can arrive in that small window;
      // close the pending bracket before terminalizing this maintenance turn.
      await this.options.recorder.failDeferredCompaction(this.options.sessionId, turnId, error).catch(() => {});
      const result = aborted
        ? abortedTurnResult(this.options.sessionId, turnId, startedAt, this.now().toISOString())
        : failedTurnResult(this.options.sessionId, turnId, startedAt, this.now().toISOString(), message);
      await this.options.recorder.completeTurn(result);
      return aborted
        ? { type: "aborted", turnId, error: message, usage: {} }
        : { type: "failed", turnId, error: message, usage: {} };
    }
  }

  private async persistReplacement(
    turnId: string,
    compact: Extract<AutoCompactResult, { type: "compacted" }>,
    result: CompactionResult,
  ): Promise<void> {
    if (!this.options.transcript.recordCompactionReplacement) {
      const error = new Error("Transcript writer does not support atomic compaction replacement.");
      await this.options.recorder.failDeferredCompaction(this.options.sessionId, turnId, error).catch(() => {});
      throw error;
    }
    const boundary = compactBoundary(compact, result);
    try {
      await this.options.transcript.recordCompactionReplacement(
        this.options.sessionId,
        turnId,
        boundary,
        markCompactReplacementMessages(compact.messages, result.compactionId),
      );
      await this.options.recorder.commitDeferredCompaction(this.options.sessionId, turnId);
    } catch (error) {
      await this.options.recorder.failDeferredCompaction(this.options.sessionId, turnId, error).catch(() => {});
      throw error;
    }
  }
}

function compactBoundary(
  compact: Extract<AutoCompactResult, { type: "compacted" }>,
  result: CompactionResult,
): Extract<AgentControlBoundaryTranscriptEntry["boundary"], { kind: "compact"; subtype: "compact_boundary" }> {
  return {
    kind: "compact",
    subtype: "compact_boundary",
    compactMetadata: {
      compactionId: result.compactionId,
      trigger: result.trigger,
      preTokens: result.preTokens,
      postTokens: compact.snapshot.tokens,
      messagesSummarized: result.messagesSummarized,
      ...(result.targetPostTokens !== undefined ? { targetTokens: result.targetPostTokens } : {}),
      summaryGenerated: result.summaryGenerated ?? result.summaryMessage !== undefined,
      checkpointMerged: result.checkpointMerged ?? result.cacheReset === true,
      finalRatio: compact.snapshot.ratio,
      extra: {
        tier: compact.tier,
        summarySucceeded: result.error === undefined && result.summaryMessage !== undefined,
        ...(result.cacheReset ? { cacheReset: true } : {}),
        ...(compact.error
          ? {
              finalBudgetTokens: compact.snapshot.maxContextTokens,
              finalUsedTokens: compact.snapshot.tokens,
              finalBudgetRatio: compact.snapshot.ratio,
              error: compact.error,
            }
          : {}),
      },
    },
  };
}

function markCompactReplacementMessages(messages: CanonicalMessage[], compactionId: string): CanonicalMessage[] {
  return messages.map((message) => ({
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      compactReplacement: true,
      compactSnapshotId: compactionId,
    },
  }));
}

function successTurnResult(
  sessionId: string,
  turnId: string,
  startedAt: string,
  completedAt: string,
  usage: CanonicalUsage,
): AgentTurnResult {
  return {
    type: "success",
    sessionId,
    turnId,
    stopReason: "completed",
    usage,
    permissionDenials: [],
    turns: 0,
    startedAt,
    completedAt,
  };
}

function abortedTurnResult(sessionId: string, turnId: string, startedAt: string, completedAt: string): AgentTurnResult {
  return {
    type: "aborted",
    sessionId,
    turnId,
    stopReason: "aborted_streaming",
    usage: {},
    permissionDenials: [],
    turns: 0,
    startedAt,
    completedAt,
  };
}

function failedTurnResult(
  sessionId: string,
  turnId: string,
  startedAt: string,
  completedAt: string,
  message: string,
): AgentTurnResult {
  return {
    type: "error",
    sessionId,
    turnId,
    stopReason: "model_error",
    usage: {},
    permissionDenials: [],
    turns: 0,
    startedAt,
    completedAt,
    errors: [{ code: "agent_invalid_state", message }],
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "manual compaction aborted"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
