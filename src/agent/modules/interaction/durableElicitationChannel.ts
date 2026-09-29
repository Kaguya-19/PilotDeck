import { randomUUID } from "node:crypto";
import type { AgentSessionEventRecorder } from "../../session/AgentSessionEventRecorder.js";
import type {
  PilotDeckElicitationAnswer,
  PilotDeckElicitationChannel,
  PilotDeckElicitationRequest,
} from "../../../tool/elicitation/PilotDeckElicitationChannel.js";

const DURABLE_ELICITATION_DELEGATE = Symbol("pilotdeck.durable-elicitation-delegate");

export type DurableElicitationChannelOptions = {
  sessionId: string;
  uuid?: () => string;
};

/**
 * Session-owned interaction consumer. The channel remains responsible for
 * transport and answer delivery; this adapter records only the lifecycle
 * bracket so replay can distinguish answered, cancelled, failed, and crash-
 * tail questions without persisting the user's answer payload.
 */
export function createDurableElicitationChannel(
  delegate: PilotDeckElicitationChannel,
  recorder: AgentSessionEventRecorder,
  options: DurableElicitationChannelOptions,
): PilotDeckElicitationChannel {
  const existing = (delegate as DurableElicitationChannelLike)[DURABLE_ELICITATION_DELEGATE];
  if (existing) return delegate;
  const uuid = options.uuid ?? randomUUID;
  const channel: PilotDeckElicitationChannel = {
    async askUser(request: PilotDeckElicitationRequest): Promise<PilotDeckElicitationAnswer> {
      const operationId = uuid();
      const sessionId = options.sessionId;
      const turnId = request.toolCallId;
      await recorder.recordQuestionStarted(sessionId, turnId, {
        operationId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        questionCount: request.questions.length,
      });
      try {
        const answer = await delegate.askUser(request);
        await recorder.recordQuestionCompleted(sessionId, turnId, {
          operationId,
          status: answer.type === "cancelled" ? "cancelled" : "answered",
          questionCount: request.questions.length,
          ...(answer.type === "cancelled" && answer.reason ? { reason: answer.reason } : {}),
        });
        return answer;
      } catch (error) {
        await Promise.resolve(recorder.recordQuestionFailed(sessionId, turnId, {
          operationId,
          error: error instanceof Error ? error.message : String(error),
        })).catch(() => {});
        throw error;
      }
    },
    async dispose(reason?: string): Promise<void> {
      await delegate.dispose?.(reason);
    },
  };
  Object.defineProperty(channel, DURABLE_ELICITATION_DELEGATE, { value: delegate });
  return channel;
}

type DurableElicitationChannelLike = PilotDeckElicitationChannel & {
  [DURABLE_ELICITATION_DELEGATE]?: PilotDeckElicitationChannel;
};
