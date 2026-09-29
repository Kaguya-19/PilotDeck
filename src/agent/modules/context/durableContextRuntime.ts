import type { AgentContextRuntime } from "../../../context/index.js";
import type { AgentSessionEventRecorder } from "../../session/AgentSessionEventRecorder.js";

const DURABLE_CONTEXT_DELEGATE = Symbol("pilotdeck.durable-context-delegate");

/**
 * Durable context recording belongs to one exact AgentSession. Consumers that
 * compose a descendant session must recover the native context provider before
 * binding the descendant's recorder.
 */
export function unwrapDurableContextRuntime(runtime: AgentContextRuntime): AgentContextRuntime {
  let current = runtime;
  const seen = new Set<AgentContextRuntime>();
  while (!seen.has(current)) {
    seen.add(current);
    const delegate = (current as DurableContextRuntime)[DURABLE_CONTEXT_DELEGATE];
    if (!delegate) return current;
    current = delegate;
  }
  return current;
}

export function createDurableContextRuntime(
  delegate: AgentContextRuntime,
  recorder: AgentSessionEventRecorder,
): AgentContextRuntime {
  // Session-owned consumers can defensively request the durable wrapper
  // without creating nested lifecycle brackets around one context operation.
  if ((delegate as DurableContextRuntime)[DURABLE_CONTEXT_DELEGATE]) {
    return delegate;
  }
  const durableDelegate = delegate;
  const runtime: AgentContextRuntime = {
    async prepareForModel(input) {
      const stepId = recorder.peekAdmissionStep(input.turnId);
      const prepared = await durableDelegate.prepareForModel({
        ...input,
        stepId,
      });
      if (prepared.materialization) {
        const materialization = {
          ...prepared.materialization,
          stepId: prepared.materialization.stepId ?? stepId,
        };
        await recorder.recordContextMaterialization(
          input.sessionId,
          input.turnId,
          materialization,
        );
        return { ...prepared, materialization };
      }
      return prepared;
    },
  };
  if (durableDelegate.applyToolResults) {
    runtime.applyToolResults = (input) => durableDelegate.applyToolResults!(input);
  }
  if (durableDelegate.recoverFromModelError) {
    runtime.recoverFromModelError = (input) => durableDelegate.recoverFromModelError!(input);
  }
  if (durableDelegate.captureTurn) {
    runtime.captureTurn = (input) => durableDelegate.captureTurn!(input);
  }
  if (durableDelegate.dispose) {
    runtime.dispose = () => durableDelegate.dispose!();
  }
  if (durableDelegate.tryAutoCompact) {
    runtime.tryAutoCompact = async (input) => {
      const sessionId = input.sessionId ?? "";
      const turnId = input.turnId ?? "";
      const operationId = recorder.nextCompactionOperationId();
      const trigger = input.trigger ?? (input.allowFallbackOnFailure ? "reactive" : "auto");
      await recorder.recordCompactionStarted(sessionId, turnId, {
        operationId,
        trigger,
        messageCount: input.messages.length,
        ...(input.maxContextTokens !== undefined ? { maxContextTokens: input.maxContextTokens } : {}),
      });
      try {
        const result = await durableDelegate.tryAutoCompact!({ ...input, trigger });
        const completion = {
          operationId,
          status: result.type,
          ...(result.type === "compacted"
            ? {
                tier: result.tier,
                ...(result.result?.compactionId ? { compactionId: result.result.compactionId } : {}),
                messageCount: result.messages.length,
                ...(result.error ? { error: result.error } : {}),
              }
            : { messageCount: input.messages.length }),
        };
        if (result.type === "compacted" && result.result) {
          if (trigger === "manual" && (result.result.error !== undefined || result.result.summaryMessage === undefined)) {
            throw new Error("Manual compaction provider returned no useful summary replacement.");
          }
          // AgentLoop reports the replacement callback after this provider
          // returns. Defer the terminal fact until that callback commits the
          // model-visible replacement surface.
          recorder.deferCompactionCompletion(sessionId, turnId, completion);
        } else if (result.type === "compacted" && trigger === "manual") {
          // A manual operation has no AgentLoop callback to persist a
          // best-effort replacement. Do not record success without the
          // durable result needed by the session-owned command consumer.
          throw new Error("Manual compaction provider returned no durable replacement result.");
        } else {
          await recorder.recordCompactionCompleted(sessionId, turnId, completion);
        }
        return result;
      } catch (error) {
        await recorder.recordCompactionFailed(sessionId, turnId, {
          operationId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }
  Object.defineProperty(runtime, DURABLE_CONTEXT_DELEGATE, { value: durableDelegate });
  return runtime as DurableContextRuntime;
}

type DurableContextRuntime = AgentContextRuntime & {
  [DURABLE_CONTEXT_DELEGATE]?: AgentContextRuntime;
};
