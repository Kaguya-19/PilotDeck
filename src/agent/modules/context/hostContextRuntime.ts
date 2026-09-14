import { projectCompactionBudget } from "../../../context/index.js";
import type {
  AgentContextCaptureTurnInput,
  AgentContextPrepareInput,
  AgentContextRecoveryInput,
  AgentContextRuntime,
  AgentContextToolResultInput,
  AutoCompactResult,
  CompactionAutoCompactInput,
} from "../../../context/index.js";
import type {
  HostContextModuleMethod,
  ModuleCallRequest,
  ModuleResponse,
} from "../protocol.js";

type ContextModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
};

export type HostContextModuleClient = (request: ContextModuleCall) => Promise<ModuleResponse>;

export type HostContextModuleBinding = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

/** ContextRuntime consumer whose prompt and recovery policy remain host-owned. */
export function createHostContextRuntime(
  callModule: HostContextModuleClient,
  binding: HostContextModuleBinding,
  methods: readonly HostContextModuleMethod[],
  uuid: () => string = () => Math.random().toString(36).slice(2),
): AgentContextRuntime {
  const supported = new Set(methods);
  if (!supported.has("prepare_for_model")) {
    throw new Error("Host context module must support prepare_for_model.");
  }

  const invoke = async <T>(operation: HostContextModuleMethod, input: object): Promise<T> => {
    const response = await callModule({
      ...binding,
      requestId: `context-${operation}-${uuid()}`,
      module: "context",
      recordFailure: operation === "prepare_for_model",
      payload: { operation, input: serializeContextInput(operation, input) },
    });
    if (!response.ok) {
      const failure = new Error(
        String(response.error?.message ?? response.code ?? `Context module ${operation} failed.`),
      ) as Error & { code?: string };
      failure.code = response.code;
      throw failure;
    }
    if (!response.payload || !("result" in response.payload)) {
      throw new Error(`Context module ${operation} returned no result.`);
    }
    return response.payload.result as T;
  };

  const runtime: AgentContextRuntime = {
    prepareForModel: (input: AgentContextPrepareInput) => invoke("prepare_for_model", input),
  };
  if (supported.has("apply_tool_results")) {
    runtime.applyToolResults = (input: AgentContextToolResultInput) => invoke("apply_tool_results", input);
  }
  if (supported.has("recover_from_model_error")) {
    runtime.recoverFromModelError = (input: AgentContextRecoveryInput) => invoke("recover_from_model_error", input);
  }
  if (supported.has("capture_turn")) {
    runtime.captureTurn = async (input: AgentContextCaptureTurnInput) => {
      await invoke("capture_turn", input);
    };
  }
  if (supported.has("try_auto_compact")) {
    runtime.tryAutoCompact = (input: CompactionAutoCompactInput): Promise<AutoCompactResult> =>
      invoke("try_auto_compact", input);
  }
  return runtime;
}

function serializeContextInput(operation: HostContextModuleMethod, input: object): Record<string, unknown> {
  const source = input as Record<string, unknown>;
  const { abortSignal: _abortSignal, budgetEvaluator: _budgetEvaluator, ...serializable } = source;
  if (operation === "try_auto_compact") {
    return {
      ...serializable,
      budgetProjection: projectCompactionBudget(input as CompactionAutoCompactInput),
    };
  }
  return serializable;
}
