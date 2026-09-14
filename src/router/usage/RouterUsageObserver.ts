import type { CanonicalUsage } from "../../model/index.js";
import type { RouterStatsConfig } from "../config/schema.js";
import { SessionUsageCache } from "../session/sessionUsageCache.js";
import { TokenStatsCollector, type RouterStatsRecord } from "../stats/TokenStatsCollector.js";

/** One completed routed-model attempt, owned by the usage observer. */
export type RouterUsageObservation = RouterStatsRecord;

/** Compatibility-facing stats surface; provider internals remain replaceable. */
export type RouterStatsPort = Pick<TokenStatsCollector, "observe" | "snapshot" | "flush" | "dispose">;

/**
 * DSH-style Definition for route usage state and accounting side effects.
 * RouterRuntime owns attempt semantics; an observer owns cache, statistics,
 * persistence and teardown.
 */
export type RouterUsageObserver = {
  readonly stats: RouterStatsPort;
  getSessionUsage(sessionId: string): CanonicalUsage | undefined;
  observeSessionUsage(sessionId: string, usage: CanonicalUsage | undefined): void;
  observeRequest(observation: RouterUsageObservation): void;
  dispose(): Promise<void>;
};

export type NativeRouterUsageObserverOptions = {
  statsConfig?: RouterStatsConfig;
  stats?: TokenStatsCollector;
  sessionUsageCache?: SessionUsageCache;
};

/** Native provider preserving the existing in-memory cache and JSONL stats behavior. */
export function createNativeRouterUsageObserver(
  options: NativeRouterUsageObserverOptions = {},
): RouterUsageObserver {
  const stats = options.stats ?? new TokenStatsCollector(options.statsConfig);
  const sessionUsageCache = options.sessionUsageCache ?? new SessionUsageCache();
  return {
    stats,
    getSessionUsage(sessionId) {
      return sessionUsageCache.get(sessionId);
    },
    observeSessionUsage(sessionId, usage) {
      sessionUsageCache.observe(sessionId, usage);
    },
    observeRequest(observation) {
      stats.observe(observation);
    },
    async dispose() {
      await stats.flush();
      stats.dispose();
      sessionUsageCache.clear();
    },
  };
}
