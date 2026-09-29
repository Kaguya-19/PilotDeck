import type {
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayEvent,
} from "../protocol/types.js";

/**
 * Volatile replay buffer for one Gateway process.
 *
 * The store never admits turns, writes Session state, or controls Router
 * lifecycle. Gateway remains the only caller that decides when a turn starts,
 * reaches a terminal state, or is discarded.
 */
export type GatewayTurnReplayStorePort = {
  start(sessionKey: string, runId: string): void;
  record(sessionKey: string, event: GatewayEvent): void;
  retainTerminal(sessionKey: string, runId: string): void;
  clearTerminal(sessionKey: string): void;
  withRunId(sessionKey: string, event: GatewayEvent): GatewayEvent;
  snapshot(input: GatewayActiveTurnSnapshotInput): GatewayActiveTurnSnapshot;
  dispose(): void;
};
