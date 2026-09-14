import type { ProviderConfig } from "../protocol/canonical.js";

export type RetryPolicyKind = "request" | "stream";

export type RetryPolicyInput = {
  provider: ProviderConfig;
  kind: RetryPolicyKind;
  attempt: number;
  retryAfterMs?: number;
};

export type RetryPolicyDecision = {
  maxRetries: number;
  delayMs: number;
};

/** LLM policy Definition for retry count and backoff only. */
export type RetryPolicy = {
  decide(input: RetryPolicyInput): RetryPolicyDecision;
};

export type NativeRetryPolicyOptions = {
  defaultMaxRetries?: number;
  defaultBaseDelayMs?: number;
  defaultMaxDelayMs?: number;
  defaultJitter?: number;
  random?: () => number;
};

/** Provider adapter preserving PilotDeck's existing retry defaults and jitter. */
export function createNativeRetryPolicy(options: NativeRetryPolicyOptions = {}): RetryPolicy {
  const random = options.random ?? Math.random;
  const defaultMaxRetries = options.defaultMaxRetries ?? 2;
  const defaultBaseDelayMs = options.defaultBaseDelayMs ?? 500;
  const defaultMaxDelayMs = options.defaultMaxDelayMs ?? 8_000;
  const defaultJitter = options.defaultJitter ?? 0.75;
  return {
    decide(input): RetryPolicyDecision {
      const configuredMax = input.kind === "request"
        ? input.provider.retry?.requestMaxRetries
        : input.provider.retry?.streamMaxRetries;
      const maxRetries = configuredMax ?? defaultMaxRetries;
      if (input.retryAfterMs !== undefined) {
        return { maxRetries, delayMs: Math.min(input.retryAfterMs, input.provider.retry?.maxDelayMs ?? defaultMaxDelayMs) };
      }
      const baseDelayMs = input.provider.retry?.baseDelayMs ?? defaultBaseDelayMs;
      const maxDelayMs = input.provider.retry?.maxDelayMs ?? defaultMaxDelayMs;
      const jitter = input.provider.retry?.jitter ?? defaultJitter;
      const deterministicDelay = baseDelayMs * (input.attempt + 1);
      return { maxRetries, delayMs: Math.min(deterministicDelay + deterministicDelay * jitter * random(), maxDelayMs) };
    },
  };
}
