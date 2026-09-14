import type { AgentSessionEventRecorder } from "../../session/AgentSessionEventRecorder.js";
import type { ToolPort } from "../protocol.js";

export function createDurableToolPort(
  delegate: ToolPort,
  recorder: AgentSessionEventRecorder,
): ToolPort {
  return {
    list: () => delegate.list(),
    async executeAll(calls, context, execution) {
      await recorder.recordToolCalls(execution.sessionId, execution.turnId, calls);
      const results = await delegate.executeAll(calls, context, execution);
      await recorder.recordToolResults(execution.sessionId, execution.turnId, results);
      return results;
    },
  };
}
