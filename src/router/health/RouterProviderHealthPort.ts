import { ProviderHealthTracker } from "./ProviderHealthTracker.js";

/** Identifies one provider circuit within the health provider's session scope. */
export type RouterProviderHealthInput = {
  sessionId: string;
  providerId: string;
  /** A replaced invocation provider starts with a fresh circuit. */
  providerGeneration?: string | number;
};

/**
 * Router-facing health Definition.
 *
 * The Router consumes this narrow port instead of owning provider circuit
 * maps. Health remains volatile routing policy: it is neither Session durable
 * state nor a transport concern.
 */
export type RouterProviderHealthPort = {
  shouldSkip(input: RouterProviderHealthInput): boolean;
  recordFailure(input: RouterProviderHealthInput): void;
  recordSuccess(input: RouterProviderHealthInput): void;
  dispose?(): void | Promise<void>;
};

export type NativeRouterProviderHealthPortOptions = {
  now?: () => number;
};

/**
 * Native provider for per-session, generation-aware provider circuits.
 *
 * A RouterRuntime owns this provider unless application composition injects
 * one. `dispose()` drops only volatile circuit observations; it never changes
 * model-provider, Router, Session, or transport state.
 */
export function createNativeRouterProviderHealthPort(
  options: NativeRouterProviderHealthPortOptions = {},
): RouterProviderHealthPort {
  const trackers = new Map<string, ProviderHealthTracker>();
  const now = options.now ?? Date.now;

  const trackerFor = (input: RouterProviderHealthInput): ProviderHealthTracker => {
    let tracker = trackers.get(input.sessionId);
    if (!tracker) {
      tracker = new ProviderHealthTracker({ now });
      trackers.set(input.sessionId, tracker);
    }
    return tracker;
  };

  const providerKey = (input: RouterProviderHealthInput): string =>
    `${input.providerId}\u0000${input.providerGeneration ?? "legacy"}`;

  return {
    shouldSkip(input) {
      return trackerFor(input).shouldSkip(providerKey(input));
    },
    recordFailure(input) {
      trackerFor(input).recordFailure(providerKey(input));
    },
    recordSuccess(input) {
      trackerFor(input).recordSuccess(providerKey(input));
    },
    dispose() {
      trackers.clear();
    },
  };
}
