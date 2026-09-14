import type { CanonicalModelRequest } from "../../model/index.js";
import type { RouterModelInvocationPort } from "../provider/RouterModelInvocationPort.js";
import type { RouterDecision } from "../protocol/decision.js";
import { stripSubagentTagFromMessages } from "../scenario/subagentDetector.js";

/** DSH-style Definition for applying a routing decision to a canonical request. */
export type RouterRequestMaterializer = {
  materialize(decision: RouterDecision, request: CanonicalModelRequest): CanonicalModelRequest;
  dispose?(): void | Promise<void>;
};

/** Native provider preserving cache-plan, subagent-tag, and model-cap behavior. */
export function createNativeRouterRequestMaterializer(
  modelRuntime: RouterModelInvocationPort,
): RouterRequestMaterializer {
  return {
    materialize(decision, request) {
      let messages = decision.requestPatch?.messages ?? request.messages;
      if (decision.mutations.subagentTagStripped) {
        messages = stripSubagentTagFromMessages(messages);
      }
      const routedCachePlan = request.cachePlan &&
        (request.cachePlan.provider === undefined || request.cachePlan.provider === decision.provider) &&
        (request.cachePlan.model === undefined || request.cachePlan.model === decision.model)
        ? request.cachePlan
        : undefined;
      return clampMaxOutputTokensToModelCap({
        ...request,
        ...decision.requestPatch,
        provider: decision.provider,
        model: decision.model,
        messages,
        cacheBreakpoints: request.cachePlan !== undefined
          ? routedCachePlan?.messages
          : request.cacheBreakpoints,
        cachePlan: routedCachePlan,
      }, modelRuntime);
    },
  };
}

export function clampMaxOutputTokensToModelCap(
  request: CanonicalModelRequest,
  modelRuntime: RouterModelInvocationPort,
): CanonicalModelRequest {
  const requested = request.maxOutputTokens;
  if (requested === undefined) {
    return request;
  }

  try {
    const cap = modelRuntime.getCapabilities(request.provider, request.model).maxOutputTokens;
    if (Number.isFinite(cap) && cap > 0 && requested > cap) {
      return { ...request, maxOutputTokens: cap };
    }
  } catch {
    // Unknown provider/model — let validateModelRequest surface the real error.
  }
  return request;
}
