import type {
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayEvent,
} from "../protocol/types.js";
import { GatewayTurnReplayStore } from "./GatewayTurnReplayStore.js";
import type { GatewayTurnReplayStorePort } from "./GatewayTurnReplayStorePort.js";
import type { GatewayTurnEventCoordinatorPort } from "./GatewayTurnEventCoordinatorPort.js";

export type GatewayTurnEventCoordinatorOptions = {
  replayStore?: GatewayTurnReplayStorePort;
};

/**
 * Native owner for the live Gateway sink and bounded replay buffer.
 *
 * It does not decide which events exist, when a turn is admitted, or when a
 * Session/Router closes. The Gateway host supplies those decisions and only
 * uses this coordinator to publish, retain, and replay already-derived events.
 */
export class GatewayTurnEventCoordinator implements GatewayTurnEventCoordinatorPort {
  private readonly replayStore: GatewayTurnReplayStorePort;
  private readonly sinks = new Map<string, (event: GatewayEvent) => void>();

  constructor(options: GatewayTurnEventCoordinatorOptions = {}) {
    this.replayStore = options.replayStore ?? new GatewayTurnReplayStore();
  }

  start(sessionKey: string, runId: string, sink: (event: GatewayEvent) => void): void {
    this.replayStore.start(sessionKey, runId);
    this.sinks.set(sessionKey, sink);
  }

  record(sessionKey: string, event: GatewayEvent): void {
    this.replayStore.record(sessionKey, event);
  }

  emit(sessionKey: string, event: GatewayEvent): boolean {
    const sink = this.sinks.get(sessionKey);
    if (!sink) return false;
    const eventWithRunId = this.replayStore.withRunId(sessionKey, event);
    this.replayStore.record(sessionKey, eventWithRunId);
    sink(eventWithRunId);
    return true;
  }

  retainTerminal(sessionKey: string, runId: string): void {
    this.sinks.delete(sessionKey);
    this.replayStore.retainTerminal(sessionKey, runId);
  }

  snapshot(input: GatewayActiveTurnSnapshotInput): GatewayActiveTurnSnapshot {
    return this.replayStore.snapshot(input);
  }

  dispose(): void {
    this.sinks.clear();
    this.replayStore.dispose();
  }
}
