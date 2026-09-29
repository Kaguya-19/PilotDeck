import type { AgentEvent, AgentEventEmitter } from "../../protocol/events.js";
import type { ModuleCallRequest, ModuleResponse } from "../protocol.js";

type EventModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
};

export type HostEventModuleClient = (request: EventModuleCall) => Promise<ModuleResponse>;

export type HostEventModuleBinding = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

export type HostAgentEventBridge = {
  emitter: AgentEventEmitter;
  /** Settles all events accepted before a sidecar execution publishes final. */
  flush(): Promise<void>;
};

/**
 * Serializes volatile AgentLoop-emitted events into ordered host module calls.
 * Delivery failures do not change the AgentLoop terminal, matching the native
 * fire-and-forget event-emitter contract.
 */
export function createHostAgentEventBridge(
  callModule: HostEventModuleClient,
  binding: HostEventModuleBinding,
  uuid: () => string = () => Math.random().toString(36).slice(2),
): HostAgentEventBridge {
  let tail = Promise.resolve();
  return {
    emitter(event) {
      tail = tail
        .then(async () => {
          const response = await callModule({
            ...binding,
            requestId: `agent-event-${uuid()}`,
            module: "event",
            recordFailure: false,
            payload: { operation: "emit", event },
          });
          if (!response.ok) throw moduleFailure(response);
        })
        // Native AgentEventEmitter has no error channel. Preserve terminal
        // semantics while still serializing later events after a failure.
        .catch(() => undefined);
    },
    flush: () => tail,
  };
}

function moduleFailure(response: ModuleResponse): Error & { code?: string } {
  const error = new Error(
    String(response.error?.message ?? response.code ?? "Agent event module failed."),
  ) as Error & { code?: string };
  error.code = response.code;
  return error;
}
