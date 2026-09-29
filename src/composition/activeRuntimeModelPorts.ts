/** Bind the public model callback to the already selected project generation. */
import type { ModelRuntime } from "../model/ModelRuntime.js";
import type { CanonicalMessage, CanonicalModelRequest, ModelConfig } from "../model/protocol/canonical.js";
import { ModelRequestError } from "../model/protocol/errors.js";
import { validateModelRequest } from "../model/request/validateModelRequest.js";
import type { ModelCatalogListResult } from "../gateway/protocol/types.js";

type Input = {
  requestId?: unknown;
  modelId?: unknown;
  request?: unknown;
  budget?: unknown;
  signal?: AbortSignal;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRequestError("invalid_request", "request must be an object");
  }
  return value as Record<string, unknown>;
}

function positive(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ModelRequestError("invalid_budget", `${field} must be a positive integer`);
  }
  return Number(value);
}

const CANONICAL_CONTENT_TYPES = new Set([
  "text",
  "thinking",
  "image",
  "pdf",
  "audio",
  "tool_call",
  "tool_result",
  "tool_result_reference",
  "media_reference",
]);

/**
 * Validate the public model boundary before the request reaches a provider.
 *
 * The internal request builders intentionally tolerate incomplete historical
 * messages, but a public model call must not silently turn a malformed user
 * message into an empty provider `messages` array.  Keep this check at the
 * public Port so internal replay/compatibility paths retain their behaviour.
 */
function validatePublicMessages(value: unknown): asserts value is CanonicalMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ModelRequestError("invalid_request", "messages must be a non-empty array");
  }
  for (const [messageIndex, rawMessage] of value.entries()) {
    if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
      throw new ModelRequestError("invalid_request", `messages[${messageIndex}] must be an object`);
    }
    const message = rawMessage as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") {
      throw new ModelRequestError("invalid_request", `messages[${messageIndex}].role must be user or assistant`);
    }
    const content = message.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw new ModelRequestError(
        "invalid_request",
        `messages[${messageIndex}].content must be a non-empty canonical block array`,
      );
    }
    for (const [blockIndex, rawBlock] of content.entries()) {
      if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)
        || typeof (rawBlock as Record<string, unknown>).type !== "string"
        || !CANONICAL_CONTENT_TYPES.has((rawBlock as Record<string, unknown>).type as string)) {
        throw new ModelRequestError(
          "invalid_request",
          `messages[${messageIndex}].content[${blockIndex}] must be a canonical content block`,
        );
      }
    }
  }
}

/** No alias or provider inference: selection must be a single available catalog entry. */
export function createActiveRuntimeModelPorts(runtime: {
  config: ModelConfig;
  model: ModelRuntime;
  catalog: () => Promise<ModelCatalogListResult>;
}) {
  async function prepare(input: Input) {
    const request = object(input.request);
    const budget = input.budget === undefined ? {} : object(input.budget);
    const requested = input.modelId ?? request.model;
    if (typeof requested !== "string" || !requested.trim()) {
      throw new ModelRequestError("invalid_request", "modelId is required");
    }
    if (typeof input.requestId !== "string" || !input.requestId.trim()) {
      throw new ModelRequestError("invalid_request", "requestId is required");
    }
    const catalog = await runtime.catalog();
    const matches = catalog.items.filter(item => item.id === requested && item.available);
    if (matches.length !== 1) {
      throw new ModelRequestError(matches.length ? "model_id_ambiguous" : "model_not_available",
        `Selected model ${requested} is not a single available catalog entry`);
    }
    const selected = matches[0]!;
    if (request.model !== undefined && request.model !== selected.model && request.model !== selected.id) {
      throw new ModelRequestError("model_selection_mismatch", "request model differs from selected model");
    }
    if (request.provider !== undefined && request.provider !== selected.provider) {
      throw new ModelRequestError("model_selection_mismatch", "provider differs from selected model");
    }
    const maxOutputTokens = positive(budget.maxOutputTokens, "maxOutputTokens");
    const timeoutMs = positive(budget.timeoutMs, "timeoutMs");
    const maxInputTokens = positive(budget.maxInputTokens, "maxInputTokens");
    if (maxInputTokens !== undefined) {
      throw new ModelRequestError("unsupported_budget", "maxInputTokens needs measured prompt tokens");
    }
    const cap = runtime.model.getCapabilities(selected.provider, selected.model);
    const output = maxOutputTokens ?? (typeof request.maxOutputTokens === "number" ? request.maxOutputTokens : undefined);
    if (output !== undefined && (!Number.isSafeInteger(output) || output <= 0 || output > cap.maxOutputTokens)) {
      throw new ModelRequestError("invalid_budget", "maxOutputTokens exceeds selected model limit");
    }
    if (typeof request.maxOutputTokens === "number" && maxOutputTokens !== undefined && request.maxOutputTokens > maxOutputTokens) {
      throw new ModelRequestError("invalid_budget", "request maxOutputTokens exceeds budget");
    }
    const canonical = {
      ...request,
      provider: selected.provider,
      model: selected.model,
      ...(output !== undefined ? { maxOutputTokens: output } : {}),
    } as CanonicalModelRequest;
    validatePublicMessages(canonical.messages);
    validateModelRequest(canonical, runtime.config);
    return {
      requestId: input.requestId,
      selection: { requestedModelId: requested, selectedModelId: selected.model, providerId: selected.provider },
      request: canonical,
      timeoutMs,
    };
  }
  return {
    prepare: async (input: Input) => {
      const prepared = await prepare(input);
      const { timeoutMs: _timeoutMs, ...body } = prepared;
      return body;
    },
    stream: async (input: Input) => {
      const prepared = await prepare(input);
      return {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "x-pilotdeck-model-id": prepared.selection.selectedModelId,
          "x-pilotdeck-provider-id": prepared.selection.providerId,
        },
        body: runtime.model.stream({ ...prepared.request, stream: true },
          { signal: input.signal, ...(prepared.timeoutMs ? { streamTimeoutMs: prepared.timeoutMs } : {}) }),
      };
    },
  };
}
