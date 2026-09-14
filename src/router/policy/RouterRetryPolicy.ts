import {
  LITELLM_DEFAULT_MAX_RETRIES,
  LITELLM_INITIAL_RETRY_DELAY_MS,
  LITELLM_MAX_RETRY_DELAY_MS,
  LITELLM_RETRY_JITTER,
} from "../../model/streaming/streamModel.js";
import type { RouterConfig } from "../config/schema.js";

export type RouterRetryDecisionInput = {
  kind: "transient" | "zero_usage";
  /** Zero-based retry counter used by the caller. */
  attempt: number;
  retryAfterMs?: number;
};

export type RouterRetryDecision = {
  retry: boolean;
  maxAttempts: number;
  delayMs: number;
};

/** DSH-style policy Definition for router retry admission and backoff. */
export type RouterRetryPolicy = {
  decide(input: RouterRetryDecisionInput): RouterRetryDecision;
};

export type NativeRouterRetryPolicyOptions = {
  random?: () => number;
};

/** Native provider preserving PilotDeck's current router retry defaults. */
export function createNativeRouterRetryPolicy(
  config: RouterConfig,
  options: NativeRouterRetryPolicyOptions = {},
): RouterRetryPolicy {
  const random = options.random ?? Math.random;
  const zeroUsage = {
    enabled: config.zeroUsageRetry?.enabled ?? true,
    maxAttempts: Math.max(1, config.zeroUsageRetry?.maxAttempts ?? 5),
  };
  const transient = {
    enabled: config.transientRetry?.enabled ?? true,
    maxAttempts: Math.max(1, config.transientRetry?.maxAttempts ?? LITELLM_DEFAULT_MAX_RETRIES),
    baseDelayMs: config.transientRetry?.baseDelayMs ?? LITELLM_INITIAL_RETRY_DELAY_MS,
    maxDelayMs: config.transientRetry?.maxDelayMs ?? LITELLM_MAX_RETRY_DELAY_MS,
  };

  return {
    decide(input) {
      if (input.kind === "zero_usage") {
        return {
          retry: zeroUsage.enabled && input.attempt < zeroUsage.maxAttempts,
          maxAttempts: zeroUsage.maxAttempts,
          delayMs: 500 * Math.max(0, input.attempt),
        };
      }
      if (!transient.enabled || input.attempt >= transient.maxAttempts) {
        return { retry: false, maxAttempts: transient.maxAttempts, delayMs: 0 };
      }
      const delayMs = input.retryAfterMs !== undefined
        ? Math.min(input.retryAfterMs, transient.maxDelayMs)
        : calculateRetryDelay(input.attempt, transient.baseDelayMs, transient.maxDelayMs, random());
      return { retry: true, maxAttempts: transient.maxAttempts, delayMs };
    },
  };
}

function calculateRetryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, randomValue: number): number {
  const deterministicDelay = baseDelayMs * (attempt + 1);
  const jitterDelay = deterministicDelay * LITELLM_RETRY_JITTER * Math.max(0, Math.min(1, randomValue));
  return Math.min(deterministicDelay + jitterDelay, maxDelayMs);
}
