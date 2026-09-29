import type { ModuleBinding, ModuleEvent } from "../protocol.js";

const DEFAULT_MAX_EVENTS_PER_STREAM = 1_024;
const DEFAULT_MAX_BYTES_PER_STREAM = 1_048_576;
const DEFAULT_TTL_MS = 30_000;

export type SidecarStreamReplayStoreOptions = {
  /** Maximum event count retained for one live stream. */
  maxEventsPerStream?: number;
  /** Maximum serialized event bytes retained for one live stream. */
  maxBytesPerStream?: number;
  /** Bounded retention after an execution reaches its terminal event. */
  ttlMs?: number;
  now?: () => number;
};

export type SidecarStreamReplayResume =
  | { ok: true; events: ModuleEvent[]; replayedThroughSequence: number }
  | { ok: false; code: "BINDING_MISMATCH" | "CURSOR_EXPIRED" };

export type SidecarStreamReplayAck =
  | { ok: true }
  | { ok: false; code: "CURSOR_EXPIRED" | "INVALID_ACK_CURSOR" };

type StreamRecord = {
  binding: ModuleBinding;
  events: Array<{ event: ModuleEvent; bytes: number }>;
  bytes: number;
  lastSequence: number;
  /** Events at or before this sequence cannot be replayed any more. */
  truncatedThrough: number;
  terminal: boolean;
  /** Active executions never expire from the replay cache. */
  expiresAt?: number;
};

/**
 * Bounded, transport-local event retention for one resumable streaming module.
 *
 * This is deliberately not a Session/operation store. It retains only wire
 * events while the sidecar process is alive; a missing or expired record is a
 * fail-closed cursor error and must be reconciled by the host's durable owner.
 */
export class SidecarStreamReplayStore {
  private readonly streams = new Map<string, StreamRecord>();
  private readonly maxEventsPerStream: number;
  private readonly maxBytesPerStream: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SidecarStreamReplayStoreOptions = {}) {
    this.maxEventsPerStream = positiveInteger(
      options.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM,
      "maxEventsPerStream",
    );
    this.maxBytesPerStream = positiveInteger(
      options.maxBytesPerStream ?? DEFAULT_MAX_BYTES_PER_STREAM,
      "maxBytesPerStream",
    );
    this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
    this.now = options.now ?? Date.now;
  }

  start(streamId: string, binding: ModuleBinding): void {
    this.pruneExpired();
    if (this.streams.has(streamId)) throw new Error(`Sidecar stream ${streamId} already exists.`);
    this.streams.set(streamId, {
      binding: cloneBinding(binding),
      events: [],
      bytes: 0,
      lastSequence: -1,
      truncatedThrough: -1,
      terminal: false,
    });
  }

  append(event: ModuleEvent): void {
    this.pruneExpired();
    const stream = this.require(event.streamId);
    if (event.sequence !== stream.lastSequence + 1) {
      throw new Error(`Sidecar stream ${event.streamId} sequence is not contiguous.`);
    }
    if (stream.terminal) {
      throw new Error(`Sidecar stream ${event.streamId} already reached a terminal event.`);
    }
    const clone = cloneEvent(event);
    const bytes = Buffer.byteLength(JSON.stringify(clone), "utf8");
    stream.events.push({ event: clone, bytes });
    stream.bytes += bytes;
    stream.lastSequence = event.sequence;
    if (event.final) {
      stream.terminal = true;
      stream.expiresAt = this.expiry();
    }
    this.trim(stream);
  }

  resume(input: {
    streamId: string;
    previousBinding: ModuleBinding;
    lastAppliedSequence: number;
  }): SidecarStreamReplayResume {
    this.pruneExpired();
    const stream = this.streams.get(input.streamId);
    if (!stream) return { ok: false, code: "CURSOR_EXPIRED" };
    if (!sameBinding(stream.binding, input.previousBinding)) {
      return { ok: false, code: "BINDING_MISMATCH" };
    }
    if (!isAppliedSequence(input.lastAppliedSequence) || input.lastAppliedSequence > stream.lastSequence) {
      return { ok: false, code: "CURSOR_EXPIRED" };
    }
    if (input.lastAppliedSequence < stream.truncatedThrough) {
      return { ok: false, code: "CURSOR_EXPIRED" };
    }
    this.refreshTerminalExpiry(stream);
    const events = stream.events
      .filter(({ event }) => event.sequence > input.lastAppliedSequence)
      .map(({ event }) => cloneEvent(event));
    return {
      ok: true,
      events,
      replayedThroughSequence: stream.lastSequence,
    };
  }

  acknowledge(input: { streamId: string; lastAppliedSequence: number }): SidecarStreamReplayAck {
    this.pruneExpired();
    const stream = this.streams.get(input.streamId);
    if (!stream) return { ok: false, code: "CURSOR_EXPIRED" };
    if (!Number.isInteger(input.lastAppliedSequence) || input.lastAppliedSequence < 0 || input.lastAppliedSequence > stream.lastSequence) {
      return { ok: false, code: "INVALID_ACK_CURSOR" };
    }
    if (input.lastAppliedSequence < stream.truncatedThrough) {
      return { ok: false, code: "CURSOR_EXPIRED" };
    }
    while (stream.events[0]?.event.sequence <= input.lastAppliedSequence) {
      const dropped = stream.events.shift()!;
      stream.bytes -= dropped.bytes;
      stream.truncatedThrough = dropped.event.sequence;
    }
    this.refreshTerminalExpiry(stream);
    return { ok: true };
  }

  rebind(streamId: string, binding: ModuleBinding): boolean {
    this.pruneExpired();
    const stream = this.streams.get(streamId);
    if (!stream) return false;
    stream.binding = cloneBinding(binding);
    this.refreshTerminalExpiry(stream);
    return true;
  }

  remove(streamId: string): void {
    this.streams.delete(streamId);
  }

  private trim(stream: StreamRecord): void {
    while (stream.events.length > this.maxEventsPerStream || stream.bytes > this.maxBytesPerStream) {
      const dropped = stream.events.shift();
      if (!dropped) break;
      stream.bytes -= dropped.bytes;
      stream.truncatedThrough = dropped.event.sequence;
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [streamId, stream] of this.streams) {
      if (stream.expiresAt !== undefined && stream.expiresAt <= now) this.streams.delete(streamId);
    }
  }

  private require(streamId: string): StreamRecord {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Sidecar stream ${streamId} has expired.`);
    return stream;
  }

  private expiry(): number {
    return this.now() + this.ttlMs;
  }

  private refreshTerminalExpiry(stream: StreamRecord): void {
    if (stream.terminal) stream.expiresAt = this.expiry();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function isAppliedSequence(value: number): boolean {
  return Number.isInteger(value) && value >= -1;
}

function sameBinding(left: ModuleBinding, right: ModuleBinding): boolean {
  return left.moduleInstanceId === right.moduleInstanceId
    && left.connectionGeneration === right.connectionGeneration;
}

function cloneBinding(binding: ModuleBinding): ModuleBinding {
  return {
    moduleInstanceId: binding.moduleInstanceId,
    connectionGeneration: binding.connectionGeneration,
  };
}

function cloneEvent(event: ModuleEvent): ModuleEvent {
  return structuredClone(event);
}
