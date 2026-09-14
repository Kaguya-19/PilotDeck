import type {
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayEvent,
} from "../protocol/types.js";
import type { GatewayTurnReplayStorePort } from "./GatewayTurnReplayStorePort.js";

const DEFAULT_EVENT_LIMIT = 500;
const DEFAULT_BYTE_LIMIT = 256 * 1024;
const DEFAULT_TERMINAL_RETENTION_MS = 30_000;

type ActiveTurnReplay = {
  sessionKey: string;
  runId: string;
  active: boolean;
  events: GatewayEvent[];
  bytes: number;
  truncated: boolean;
};

export type GatewayTurnReplayStoreOptions = {
  eventLimit?: number;
  byteLimit?: number;
  terminalRetentionMs?: number;
  cloneEvent?: (event: GatewayEvent) => GatewayEvent;
};

/**
 * Native bounded in-memory provider for reconnect replay of Gateway frames.
 * Session history remains the durable source of truth; this provider exists
 * only while the Gateway process is alive.
 */
export class GatewayTurnReplayStore implements GatewayTurnReplayStorePort {
  private readonly eventLimit: number;
  private readonly byteLimit: number;
  private readonly terminalRetentionMs: number;
  private readonly cloneEvent: (event: GatewayEvent) => GatewayEvent;
  private readonly replays = new Map<string, ActiveTurnReplay>();
  private readonly terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: GatewayTurnReplayStoreOptions = {}) {
    this.eventLimit = Math.max(1, options.eventLimit ?? DEFAULT_EVENT_LIMIT);
    this.byteLimit = Math.max(1, options.byteLimit ?? DEFAULT_BYTE_LIMIT);
    this.terminalRetentionMs = Math.max(0, options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS);
    this.cloneEvent = options.cloneEvent ?? cloneGatewayEvent;
  }

  start(sessionKey: string, runId: string): void {
    this.clearTerminal(sessionKey);
    this.replays.set(sessionKey, {
      sessionKey,
      runId,
      active: true,
      events: [],
      bytes: 0,
      truncated: false,
    });
  }

  record(sessionKey: string, event: GatewayEvent): void {
    const replay = this.replays.get(sessionKey);
    if (!replay) return;
    const copy = this.cloneEvent(event);
    const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8");
    replay.events.push(copy);
    replay.bytes += bytes;
    while (replay.events.length > this.eventLimit || replay.bytes > this.byteLimit) {
      const dropped = replay.events.shift();
      if (!dropped) break;
      replay.bytes -= Buffer.byteLength(JSON.stringify(dropped), "utf8");
      replay.truncated = true;
    }
  }

  retainTerminal(sessionKey: string, runId: string): void {
    const replay = this.replays.get(sessionKey);
    if (!replay || replay.runId !== runId) return;
    replay.active = false;
    const previousTimer = this.terminalTimers.get(sessionKey);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      if (this.replays.get(sessionKey) === replay && replay.active === false) {
        this.replays.delete(sessionKey);
      }
      if (this.terminalTimers.get(sessionKey) === timer) {
        this.terminalTimers.delete(sessionKey);
      }
    }, this.terminalRetentionMs);
    timer.unref?.();
    this.terminalTimers.set(sessionKey, timer);
  }

  clearTerminal(sessionKey: string): void {
    const timer = this.terminalTimers.get(sessionKey);
    if (timer) clearTimeout(timer);
    this.terminalTimers.delete(sessionKey);
    const replay = this.replays.get(sessionKey);
    if (replay?.active === false) this.replays.delete(sessionKey);
  }

  withRunId(sessionKey: string, event: GatewayEvent): GatewayEvent {
    if (hasRunId(event)) return event;
    const replay = this.replays.get(sessionKey);
    return replay ? { ...event, runId: replay.runId } : event;
  }

  snapshot(input: GatewayActiveTurnSnapshotInput): GatewayActiveTurnSnapshot {
    const replay = this.replays.get(input.sessionKey);
    if (!replay) {
      return { active: false, sessionKey: input.sessionKey, events: [] };
    }
    const active = replay.active !== false;
    return {
      active,
      sessionKey: replay.sessionKey,
      runId: replay.runId,
      events: input.includeEvents === false ? [] : replay.events.map(this.cloneEvent),
      ...(replay.truncated ? { truncated: true } : {}),
      ...(!active ? { terminal: true } : {}),
    };
  }

  dispose(): void {
    for (const timer of this.terminalTimers.values()) clearTimeout(timer);
    this.terminalTimers.clear();
    this.replays.clear();
  }
}

function cloneGatewayEvent(event: GatewayEvent): GatewayEvent {
  return JSON.parse(JSON.stringify(event)) as GatewayEvent;
}

function hasRunId(event: GatewayEvent): boolean {
  return typeof event.runId === "string" && event.runId.trim().length > 0;
}
