import type { CanonicalMessage } from "../../../model/index.js";
import type { AgentLoopInput } from "../../loop/AgentLoop.js";
import type { AgentSteerMessage } from "../../session/SteerMailbox.js";
import type {
  HostTurnModuleMethod,
  ModuleCallRequest,
  ModuleResponse,
} from "../protocol.js";

type TurnModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
};

export type HostTurnModuleClient = (request: TurnModuleCall) => Promise<ModuleResponse>;

export type HostTurnModuleBinding = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

export function createHostTurnCallbacks(
  callModule: HostTurnModuleClient,
  binding: HostTurnModuleBinding,
  methods: readonly HostTurnModuleMethod[],
  uuid: () => string = () => Math.random().toString(36).slice(2),
): Pick<AgentLoopInput, "drainSteerMessages" | "drainOrCloseSteerMailbox" | "onCompactPersisted"> {
  const supported = new Set(methods);
  const invoke = async (
    operation: HostTurnModuleMethod,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const response = await callModule({
      ...binding,
      requestId: `turn-${operation}-${uuid()}`,
      module: "turn",
      payload: { operation, ...payload },
    });
    if (!response.ok) {
      const failure = new Error(
        String(response.error?.message ?? response.code ?? `Turn module ${operation} failed.`),
      ) as Error & { code?: string };
      failure.code = response.code;
      throw failure;
    }
    return response.payload ?? {};
  };

  return Object.freeze({
    ...(supported.has("drain_steer") ? {
      drainSteerMessages: async () => steerMessages((await invoke("drain_steer")).messages),
    } : {}),
    ...(supported.has("drain_or_close_steer") ? {
      drainOrCloseSteerMailbox: async () => {
        const payload = await invoke("drain_or_close_steer");
        if (typeof payload.closed !== "boolean") throw invalidResponse("Turn drain response must contain closed.");
        return { messages: steerMessages(payload.messages), closed: payload.closed };
      },
    } : {}),
    ...(supported.has("persist_compaction") ? {
      onCompactPersisted: async (input: Parameters<NonNullable<AgentLoopInput["onCompactPersisted"]>>[0]) => {
        await invoke("persist_compaction", { boundary: input.boundary, messages: input.messages });
      },
    } : {}),
  });
}

function steerMessages(value: unknown): AgentSteerMessage[] {
  if (!Array.isArray(value)) throw invalidResponse("Turn steer response must contain messages.");
  return value.map((item) => {
    if (!isRecord(item) || typeof item.itemId !== "string" || !isCanonicalMessage(item.message)) {
      throw invalidResponse("Turn steer response contains an invalid message.");
    }
    if (item.allowedReadFiles !== undefined && (
      !Array.isArray(item.allowedReadFiles) || item.allowedReadFiles.some((path) => typeof path !== "string")
    )) {
      throw invalidResponse("Turn steer response contains invalid allowedReadFiles.");
    }
    return item as unknown as AgentSteerMessage;
  });
}

function isCanonicalMessage(value: unknown): value is CanonicalMessage {
  return isRecord(value)
    && (value.role === "user" || value.role === "assistant")
    && Array.isArray(value.content);
}

function invalidResponse(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "INVALID_TURN_RESPONSE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
