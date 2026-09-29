import type { SessionRoutingState } from "../protocol/decision.js";
import {
  SessionRouterStore,
  type SessionRouterStoreOptions,
} from "./SessionRouterStore.js";

/**
 * Router-facing volatile session-state Definition.
 *
 * This is routing policy state, not durable Session state. A RouterRuntime
 * may read and update it, while application composition owns its lifetime.
 */
export type RouterSessionStatePort = {
  get(sessionId: string, isSubagent: boolean): SessionRoutingState | undefined;
  set(state: SessionRoutingState): void;
};

/**
 * Native provider cleanup boundary retained by application composition.
 * Router consumers intentionally cannot clear a shared provider on reload.
 */
export type RouterSessionStateProvider = RouterSessionStatePort & {
  clear(): void;
};

/**
 * Creates the native volatile routing-state provider. It is intentionally
 * backed by the existing bounded/TTL SessionRouterStore implementation.
 */
export function createNativeRouterSessionStateProvider(
  options: SessionRouterStoreOptions = {},
): RouterSessionStateProvider {
  return new SessionRouterStore(options);
}
