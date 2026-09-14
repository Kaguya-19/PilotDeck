import type {
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayEvent,
} from "../protocol/types.js";

/** Volatile active-turn stream and replay coordinator. */
export type GatewayTurnEventCoordinatorPort = {
  start(sessionKey: string, runId: string, sink: (event: GatewayEvent) => void): void;
  record(sessionKey: string, event: GatewayEvent): void;
  emit(sessionKey: string, event: GatewayEvent): boolean;
  retainTerminal(sessionKey: string, runId: string): void;
  snapshot(input: GatewayActiveTurnSnapshotInput): GatewayActiveTurnSnapshot;
  dispose(): void;
};
