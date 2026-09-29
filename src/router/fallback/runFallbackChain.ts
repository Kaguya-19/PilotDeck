import type { CanonicalModelError } from "../../model/index.js";
import type { RouterConfig, RouterFallbackConfig, RouterModelRef } from "../config/schema.js";
import type { RouterScenarioType } from "../protocol/decision.js";
import { LITELLM_ROUTER_MAX_FALLBACKS } from "../config/schema.js";

export type FallbackPlan = {
  /** Provider/model pairs to try in order, after the initial decision. */
  attempts: RouterModelRef[];
};

/** DSH-style Definition for fallback planning and error admission. */
export type RouterFallbackPolicy = {
  plan(scenarioType: RouterScenarioType | "explicit"): FallbackPlan;
  candidates(scenarioType: RouterScenarioType): readonly RouterModelRef[];
  isEligible(error: CanonicalModelError): boolean;
  dispose?(): void | Promise<void>;
};

/** Native provider preserving the existing config-driven fallback semantics. */
export function createNativeRouterFallbackPolicy(config: RouterConfig): RouterFallbackPolicy {
  const fallback = config.fallback;
  return {
    plan: (scenarioType) => planFallback(fallback, scenarioType),
    candidates(scenarioType) {
      const candidates: RouterModelRef[] = [];
      const add = (refs: RouterModelRef[] | undefined): void => {
        for (const ref of refs ?? []) {
          const id = ref.id || `${ref.provider}/${ref.model}`;
          if (!candidates.some((candidate) => candidate.provider === ref.provider && candidate.model === ref.model)) {
            candidates.push({ ...ref, id });
          }
        }
      };
      add((fallback as Record<string, RouterModelRef[] | undefined> | undefined)?.[scenarioType]);
      add(fallback?.default);
      return candidates;
    },
    isEligible: isFallbackEligible,
  };
}

export function planFallback(
  fallback: RouterFallbackConfig | undefined,
  scenarioType: RouterScenarioType | "explicit",
): FallbackPlan {
  if (!fallback) {
    return { attempts: [] };
  }

  if (scenarioType === "explicit") {
    return { attempts: [] };
  }

  return {
    attempts: capFallbackAttempts(
      (fallback as Record<string, RouterModelRef[] | undefined>)[scenarioType] ?? fallback.default ?? [],
      fallback.maxFallbacks,
    ),
  };
}

function capFallbackAttempts(attempts: RouterModelRef[], maxFallbacks: number | undefined): RouterModelRef[] {
  const cap = maxFallbacks ?? LITELLM_ROUTER_MAX_FALLBACKS;
  if (cap <= 0) return [];
  return attempts.slice(0, cap);
}

/**
 * Error codes that indicate the *model output* was malformed (e.g. invalid
 * JSON in tool arguments).  These are not retryable at the HTTP level
 * (resending the identical request won't help), but a same-model retry with
 * a corrective hint can let the model self-correct.
 */
const SELF_CORRECTABLE_CODES = new Set(["invalid_tool_arguments"]);

/**
 * Non-retryable error codes that should still attempt provider fallback
 * because a different provider may succeed (e.g. billing exhaustion on
 * one provider, model not found on another).
 */
const FALLBACK_ELIGIBLE_NON_RETRYABLE = new Set([
  "billing",
  "model_not_found",
  "auth_error",
]);

export function isFallbackEligible(error: CanonicalModelError): boolean {
  if (SELF_CORRECTABLE_CODES.has(error.code)) {
    return true;
  }
  if (FALLBACK_ELIGIBLE_NON_RETRYABLE.has(error.code)) {
    return true;
  }
  if (!error.retryable) {
    return false;
  }
  if (error.recoverableViaCompact) {
    return false;
  }
  if (error.recoverableViaImageStrip) {
    return false;
  }
  if (error.code === "prompt_too_long" || error.code === "request_too_large" || error.code === "context_overflow") {
    return false;
  }
  return true;
}
