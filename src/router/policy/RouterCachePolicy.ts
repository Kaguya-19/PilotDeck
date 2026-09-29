import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import type { RouterConfig, RouterModelRef } from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";
import { calculateCacheReadCost, calculateInputCost } from "../utils/modelPricing.js";
import { createNativeRouterTokenMeter, type RouterTokenMeter } from "../token/RouterTokenMeter.js";

export type RouterCachePolicyInput = {
  current: RouterModelRef | undefined;
  next: RouterModelRef;
  messages: CanonicalMessage[];
  lastUsage: CanonicalUsage | undefined;
};

export type RouterCachePolicyResult = {
  selection: RouterModelRef;
  mutation?: RouterMutationsLog["cacheAwareSwitch"];
};

/** DSH-style Definition for cache-aware sticky routing decisions. */
export type RouterCachePolicy = {
  select(input: RouterCachePolicyInput): RouterCachePolicyResult;
  dispose?(): void | Promise<void>;
};

/** Native provider preserving the current cache-aware switching semantics. */
export function createNativeRouterCachePolicy(
  config: RouterConfig,
  tokenMeter: Pick<RouterTokenMeter, "estimateInput"> = createNativeRouterTokenMeter(),
): RouterCachePolicy {
  return {
    select(input) {
      const { current, next, messages, lastUsage } = input;
      const cacheAware = config.tokenSaver?.cacheAwareSwitching;
      if (cacheAware?.enabled === false || !current) {
        return { selection: next };
      }
      if (current.provider === next.provider && current.model === next.model) {
        return { selection: next };
      }

      const estimatedInputTokens = tokenMeter.estimateInput(messages);
      const observedInputTokens = lastUsage?.inputTokens ?? 0;
      const observedCacheReadTokens = lastUsage?.cacheReadTokens ?? 0;
      const observedCacheHitRatio = observedInputTokens > 0
        ? Math.min(1, Math.max(0, observedCacheReadTokens / observedInputTokens))
        : 0;
      if (observedCacheHitRatio <= 0) {
        return { selection: next };
      }

      const estimatedCacheReadTokens = Math.floor(estimatedInputTokens * observedCacheHitRatio);
      const estimatedUncachedTokens = Math.max(0, estimatedInputTokens - estimatedCacheReadTokens);
      const cachedCost = calculateCacheReadCost(
        estimatedCacheReadTokens,
        current.provider,
        current.model,
        config.stats?.modelPricing,
      ) + calculateInputCost(
        estimatedUncachedTokens,
        current.provider,
        current.model,
        config.stats?.modelPricing,
      );
      const prefillCost = calculateInputCost(
        estimatedInputTokens,
        next.provider,
        next.model,
        config.stats?.modelPricing,
      );

      const minSavingsRatio = cacheAware?.minSavingsRatio ?? 0;
      const requiredSavings = cachedCost * minSavingsRatio;
      const shouldSwitch = prefillCost + Number.EPSILON < cachedCost - requiredSavings;
      const from = current.provider + "/" + current.model;
      const to = next.provider + "/" + next.model;

      if (shouldSwitch) {
        return {
          selection: next,
          mutation: { action: "switched", from, to, cachedCost, prefillCost, estimatedInputTokens },
        };
      }
      return {
        selection: current,
        mutation: { action: "kept_sticky", from, to, cachedCost, prefillCost, estimatedInputTokens },
      };
    },
  };
}
