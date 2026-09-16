import { snapshotCanonicalModelRequest } from "../../../model/index.js";
import type { ModelBudgetPort } from "../../loop/AgentTurnCapabilities.js";
import type {
  HostBudgetModuleMethod,
  ModuleCallRequest,
  ModuleResponse,
} from "../protocol.js";

type BudgetModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
};

export type HostBudgetModuleClient = (request: BudgetModuleCall) => Promise<ModuleResponse>;

export type HostBudgetModuleBinding = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

export function createHostModelBudgetPort(
  callModule: HostBudgetModuleClient,
  binding: HostBudgetModuleBinding,
  methods: readonly HostBudgetModuleMethod[],
  uuid: () => string = () => Math.random().toString(36).slice(2),
): ModelBudgetPort | undefined {
  const supported = new Set(methods);
  if (supported.size === 0) return undefined;

  const invoke = async (
    operation: HostBudgetModuleMethod,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const response = await callModule({
      ...binding,
      requestId: `budget-${operation}-${uuid()}`,
      module: "budget",
      payload: { operation, ...payload },
    });
    if (!response.ok) throw moduleFailure(response, `Budget module ${operation} failed.`);
    return response.payload ?? {};
  };

  return Object.freeze({
    ...(supported.has("estimate_request_input") ? {
      estimateRequestInput: async (
        request: Parameters<NonNullable<ModelBudgetPort["estimateRequestInput"]>>[0],
      ) => {
        const payload = await invoke("estimate_request_input", {
          request: snapshotCanonicalModelRequest(request),
        });
        return nonNegativeFinite(payload.tokens, "Budget input estimate");
      },
    } : {}),
    ...(supported.has("evaluate_request_budget") ? {
      evaluateRequestBudget: async (
        request: Parameters<NonNullable<ModelBudgetPort["evaluateRequestBudget"]>>[0],
        options: Parameters<NonNullable<ModelBudgetPort["evaluateRequestBudget"]>>[1],
      ) => {
        const { signal: _signal, ...serializableOptions } = options;
        const payload = await invoke("evaluate_request_budget", {
          request: snapshotCanonicalModelRequest(request),
          options: serializableOptions,
        });
        return tokenBudgetSnapshot(payload.snapshot);
      },
    } : {}),
    ...(supported.has("estimate_usage_cost") ? {
      estimateUsageCost: async (
        usage: Parameters<NonNullable<ModelBudgetPort["estimateUsageCost"]>>[0],
        provider: string,
        model: string,
      ) => {
        const payload = await invoke("estimate_usage_cost", { usage, provider, model });
        if (payload.costUsd === null || payload.costUsd === undefined) return undefined;
        return nonNegativeFinite(payload.costUsd, "Budget usage cost");
      },
    } : {}),
  });
}

function tokenBudgetSnapshot(value: unknown): Awaited<ReturnType<NonNullable<ModelBudgetPort["evaluateRequestBudget"]>>> {
  if (!isRecord(value)) throw invalidResponse("Budget evaluation response must contain a snapshot.");
  for (const field of ["tokens", "maxContextTokens", "warningRatio", "blockingRatio", "ratio"] as const) {
    nonNegativeFinite(value[field], `Budget snapshot ${field}`);
  }
  if (value.state !== "ok" && value.state !== "warning" && value.state !== "blocking") {
    throw invalidResponse("Budget snapshot state is invalid.");
  }
  return value as Awaited<ReturnType<NonNullable<ModelBudgetPort["evaluateRequestBudget"]>>>;
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidResponse(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function moduleFailure(response: ModuleResponse, fallback: string): Error & { code?: string } {
  const failure = new Error(String(response.error?.message ?? response.code ?? fallback)) as Error & { code?: string };
  failure.code = response.code;
  return failure;
}

function invalidResponse(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "INVALID_BUDGET_RESPONSE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
