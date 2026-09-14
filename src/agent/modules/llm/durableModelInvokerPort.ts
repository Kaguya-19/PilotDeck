import type { ModelInvokerPort } from "../protocol.js";
import type { AgentSessionEventRecorder } from "../../session/AgentSessionEventRecorder.js";

export function createDurableModelInvokerPort(
  delegate: ModelInvokerPort,
  recorder: AgentSessionEventRecorder,
): ModelInvokerPort {
  return {
    prepare: (input) => delegate.prepare(input),
    async *stream(input) {
      const { sessionId, turnId } = input.context;
      await recorder.recordModelRequest(sessionId, turnId, input.prepared);
      for await (const event of delegate.stream(input)) {
        await recorder.recordModelEvent(sessionId, turnId, event);
        yield event;
      }
    },
  };
}
