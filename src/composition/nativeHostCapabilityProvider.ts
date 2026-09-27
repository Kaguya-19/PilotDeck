/**
 * Native PilotDeck provider for the public host-capability gateway.
 *
 * This adapter is intentionally limited to capabilities with a real PD
 * runtime owner.  Unsupported management/file/task operations are omitted
 * from `operations` and return a typed 501 if called through a stale client;
 * Bash background tasks are never presented as SOP/Knowledge jobs.
 */
import type { ModelConfig, CanonicalModelRequest } from "../model/protocol/canonical.js";
import type { ModelRuntime } from "../model/ModelRuntime.js";
import { validateModelRequest } from "../model/request/validateModelRequest.js";
import { ModelProviderError, ModelRequestError } from "../model/protocol/errors.js";
import type { ToolRegistry } from "../tool/registry/ToolRegistry.js";
import type { ToolRuntime } from "../tool/execution/ToolRuntime.js";
import type { PilotDeckToolRuntimeContext } from "../tool/protocol/types.js";
import type { SkillManager } from "../extension/skills/SkillManager.js";
import type {
  PublicModelSelection,
  PublicHostPortError,
} from "./publicHostPorts.js";

export type PublicHostPrincipal = {
  pilotDeckUserId: string;
  tenantId: string;
  actorUserId: string;
  agentId?: string;
};

export type PublicCapabilityResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export type NativePublicHostRuntime = {
  modelConfig: ModelConfig;
  defaultSelection?: { provider: string; model: string };
  modelRuntime: ModelRuntime;
  tools: ToolRegistry;
  toolRuntime: ToolRuntime;
  /** Builds the existing per-session context; the provider never invents one. */
  toolContext: (principal: PublicHostPrincipal, signal?: AbortSignal) => PilotDeckToolRuntimeContext;
  skills: SkillManager;
  projectKey?: string | null;
};

export type PublicHostCapabilityProvider = {
  operations: readonly string[];
  call: (
    operation: string,
    input: unknown,
    options: { signal?: AbortSignal; principal: PublicHostPrincipal },
  ) => Promise<PublicCapabilityResponse>;
};

const SUPPORTED_OPERATIONS = Object.freeze([
  "list_tools",
  "test_tool",
  "list_general_skills",
  "import_general_skill",
  "list_model_catalog",
  "model_prepare",
  "model_stream",
]);

const unsupported = (operation: string): PublicCapabilityResponse => ({
  status: 501,
  body: {
    code: "PUBLIC_HOST_CAPABILITY_UNAVAILABLE",
    operation,
    message: "No equivalent configured PilotDeck runtime capability is available.",
  } satisfies PublicHostPortError & { operation: string },
});

const invalid = (message: string): PublicCapabilityResponse => ({
  status: 400,
  body: { code: "PUBLIC_HOST_INPUT_INVALID", message },
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function modelSelection(config: ModelConfig, requestedModelId: string): PublicModelSelection {
  const matches: PublicModelSelection[] = [];
  for (const provider of Object.values(config.providers)) {
    if (provider.models[requestedModelId]) {
      matches.push({ requestedModelId, selectedModelId: requestedModelId, providerId: provider.id });
    }
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "model_not_found" : "model_id_ambiguous");
  }
  return matches[0];
}

function validateBudget(input: Record<string, unknown>, selection: PublicModelSelection, runtime: NativePublicHostRuntime): void {
  const budget = asRecord(input.budget);
  if (!budget) return;
  for (const field of ["maxOutputTokens", "maxInputTokens", "timeoutMs"]) {
    if (budget[field] !== undefined && (!Number.isInteger(budget[field]) || Number(budget[field]) <= 0)) {
      throw new ModelRequestError("invalid_budget", `${field} must be a positive integer.`);
    }
  }
  const maxOutput = budget.maxOutputTokens;
  const cap = runtime.modelRuntime.getCapabilities(selection.providerId, selection.selectedModelId).maxOutputTokens;
  if (typeof maxOutput === "number" && cap !== undefined && maxOutput > cap) {
    throw new ModelRequestError("invalid_budget", `maxOutputTokens exceeds the selected model cap (${cap}).`);
  }
}

function descriptor(tool: ReturnType<ToolRegistry["list"]>[number]) {
  return {
    name: tool.name,
    aliases: tool.aliases,
    title: tool.title,
    description: tool.description,
    kind: tool.kind,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    maxResultBytes: tool.maxResultBytes,
    shouldDefer: tool.shouldDefer,
    alwaysLoad: tool.alwaysLoad,
    searchHint: tool.searchHint,
  };
}

function skillInput(input: Record<string, unknown>, projectKey: string | null | undefined) {
  return {
    scope: input.scope,
    slug: input.slug,
    projectKey: input.projectKey ?? projectKey,
    name: input.name,
    description: input.description,
    body: input.body,
    content: input.content,
  } as never;
}

/** Build the real native provider from the selected PD runtime objects. */
export function createNativeHostCapabilityProvider(runtime: NativePublicHostRuntime): PublicHostCapabilityProvider {
  const call = async (
    operation: string,
    rawInput: unknown,
    options: { signal?: AbortSignal; principal: PublicHostPrincipal },
  ): Promise<PublicCapabilityResponse> => {
    if (!SUPPORTED_OPERATIONS.includes(operation)) return unsupported(operation);
    const input = asRecord(rawInput);
    if (!input) return invalid("input must be an object.");
    if (options.signal?.aborted) return { status: 499, body: { code: "PUBLIC_HOST_CANCELLED" } };
    try {
      switch (operation) {
        case "list_tools":
          return { status: 200, body: { data: runtime.tools.list().map(descriptor) } };
        case "test_tool": {
          const name = requireString(input.toolId ?? input.name, "toolId");
          if (!Object.hasOwn(input, "input")) return invalid("test_tool requires input.");
          const result = await runtime.toolRuntime.execute(
            { id: `public-test-${name}`, name, input: input.input },
            runtime.toolContext(options.principal, options.signal),
          );
          return { status: 200, body: result };
        }
        case "list_general_skills": {
          const result = await runtime.skills.list({
            projectKey: runtime.projectKey,
            scope: input.scope as never,
            query: input.query as string | undefined,
            cursor: input.cursor as string | undefined,
            limit: input.limit as number | undefined,
          });
          return { status: 200, body: result };
        }
        case "import_general_skill":
          return { status: 200, body: await runtime.skills.create(skillInput(input, runtime.projectKey)) };
        case "list_model_catalog": {
          const data = Object.values(runtime.modelConfig.providers).flatMap((provider) =>
            Object.values(provider.models).map((model) => ({
              id: model.id,
              name: model.displayName ?? model.id,
              model: model.id,
              provider: provider.id,
              enabled: true,
              is_default: runtime.defaultSelection?.provider === provider.id && runtime.defaultSelection.model === model.id,
            })),
          );
          return { status: 200, body: { data } };
        }
        case "model_prepare": {
          const request = asRecord(input.request) as Partial<CanonicalModelRequest> | undefined;
          const requestedModelId = requireString(input.modelId ?? request?.model, "modelId");
          const selection = modelSelection(runtime.modelConfig, requestedModelId);
          validateBudget(input, selection, runtime);
          const preparedRequest = { ...request, model: selection.selectedModelId, provider: selection.providerId } as CanonicalModelRequest;
          validateModelRequest(preparedRequest, runtime.modelConfig);
          return {
            status: 200,
            body: {
              requestId: requireString(input.requestId, "requestId"),
              selection,
              request: preparedRequest,
            },
          };
        }
        case "model_stream": {
          const request = asRecord(input.request) as Partial<CanonicalModelRequest> | undefined;
          const requestedModelId = requireString(input.modelId ?? request?.model, "modelId");
          const selection = modelSelection(runtime.modelConfig, requestedModelId);
          const canonicalRequest = {
            ...request,
            model: selection.selectedModelId,
            provider: selection.providerId,
          } as CanonicalModelRequest;
          validateModelRequest(canonicalRequest, runtime.modelConfig);
          const events = runtime.modelRuntime.stream(canonicalRequest, { signal: options.signal });
          return {
            status: 200,
            headers: {
              "content-type": "application/x-ndjson",
              "x-pilotdeck-model-id": selection.selectedModelId,
              "x-pilotdeck-provider-id": selection.providerId,
            },
            body: events,
          };
        }
        default:
          return unsupported(operation);
      }
    } catch (error) {
      if (options.signal?.aborted) return { status: 499, body: { code: "PUBLIC_HOST_CANCELLED" } };
      if (error instanceof ModelProviderError) {
        return { status: error.error.status ?? 502, body: error.error };
      }
      if (error instanceof ModelRequestError) {
        return { status: 400, body: { code: error.code, message: error.message, details: error.details } };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { status: 502, body: { code: "PUBLIC_HOST_PROVIDER_ERROR", operation, message } };
    }
  };
  return { operations: SUPPORTED_OPERATIONS, call };
}
