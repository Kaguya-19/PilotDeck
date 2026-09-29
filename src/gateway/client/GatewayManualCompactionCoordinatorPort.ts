import type { GatewayEvent } from "../protocol/types.js";

/** One validated `/compact` command accepted by the Gateway command surface. */
export type GatewayManualCompactionInput = {
  sessionKey: string;
  runId: string;
  timeoutMs?: number;
};

/**
 * Projects the session-owned manual compaction operation into the Gateway
 * stream. It does not admit normal turns or own Router/Session state.
 */
export type GatewayManualCompactionCoordinatorPort = {
  execute(input: GatewayManualCompactionInput): AsyncIterable<GatewayEvent>;
};
