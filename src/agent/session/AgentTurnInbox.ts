import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import type { AgentInput, AgentSubmitOptions } from "../protocol/input.js";
import type { AgentSessionEventRecorder } from "./AgentSessionEventRecorder.js";

export type AgentQueuedTurn = {
  itemId: string;
  turnId: string;
  input: AgentInput;
  submitOptions: Omit<AgentSubmitOptions, "turnId">;
};

export type AgentTurnDiscardReason = "cancelled" | "agent_disposed";

export type AgentTurnInboxOptions = {
  sessionId: string;
  recorder: AgentSessionEventRecorder;
  restoredEntries?: readonly AgentTranscriptEntry[];
};

/** Agent-owned durable FIFO for input that must start a later turn. */
export class AgentTurnInbox {
  private readonly pendingTurns: AgentQueuedTurn[] = [];
  private readonly knownItemIds = new Set<string>();
  private readonly knownTurnIds = new Set<string>();

  constructor(private readonly options: AgentTurnInboxOptions) {
    this.restore(options.restoredEntries ?? []);
  }

  get size(): number {
    return this.pendingTurns.length;
  }

  snapshot(): readonly AgentQueuedTurn[] {
    return this.pendingTurns.map(snapshotQueuedTurn);
  }

  peek(): AgentQueuedTurn | undefined {
    const next = this.pendingTurns[0];
    return next ? snapshotQueuedTurn(next) : undefined;
  }

  async enqueue(turn: AgentQueuedTurn): Promise<void> {
    const stable = snapshotQueuedTurn(turn);
    this.validateNew(stable);
    await this.options.recorder.recordTurnEnqueued(this.options.sessionId, stable.turnId, {
      itemId: stable.itemId,
      input: stable.input,
      submitOptions: stable.submitOptions,
    });
    this.pendingTurns.push(stable);
    this.knownItemIds.add(stable.itemId);
    this.knownTurnIds.add(stable.turnId);
  }

  /** Apply the claim already committed atomically by turn_started. */
  markStarted(itemId: string, turnId: string): void {
    const next = this.pendingTurns[0];
    if (!next || next.itemId !== itemId || next.turnId !== turnId) {
      throw new Error(`Queued turn ${itemId} is not the next FIFO admission.`);
    }
    this.pendingTurns.shift();
  }

  async discard(itemId: string, reason: AgentTurnDiscardReason): Promise<boolean> {
    const index = this.pendingTurns.findIndex((turn) => turn.itemId === itemId);
    if (index < 0) return false;
    const turn = this.pendingTurns[index]!;
    await this.options.recorder.recordTurnDiscarded(this.options.sessionId, turn.turnId, {
      itemId,
      reason,
    });
    this.pendingTurns.splice(index, 1);
    return true;
  }

  async discardAll(reason: AgentTurnDiscardReason): Promise<void> {
    for (const turn of [...this.pendingTurns]) {
      await this.discard(turn.itemId, reason);
    }
  }

  private validateNew(turn: AgentQueuedTurn): void {
    if (turn.itemId.trim().length === 0) throw new Error("Queued turn itemId must not be empty.");
    if (turn.turnId.trim().length === 0) throw new Error("Queued turn turnId must not be empty.");
    if (this.knownItemIds.has(turn.itemId)) {
      throw new Error(`Queued turn itemId has already been used: ${turn.itemId}`);
    }
    if (this.knownTurnIds.has(turn.turnId)) {
      throw new Error(`Queued turn turnId has already been used: ${turn.turnId}`);
    }
  }

  private restore(entries: readonly AgentTranscriptEntry[]): void {
    for (const entry of entries) {
      if (entry.type === "agent_turn_enqueued") {
        const turn = snapshotQueuedTurn({
          itemId: entry.itemId,
          turnId: entry.turnId,
          input: entry.input,
          submitOptions: entry.submitOptions,
        });
        this.validateNew(turn);
        this.pendingTurns.push(turn);
        this.knownItemIds.add(turn.itemId);
        this.knownTurnIds.add(turn.turnId);
        continue;
      }
      if (entry.type === "agent_turn_discarded") {
        const index = this.pendingTurns.findIndex((turn) =>
          turn.itemId === entry.itemId && turn.turnId === entry.turnId);
        if (index < 0) throw new Error(`Discarded queued turn ${entry.itemId} was not pending.`);
        this.pendingTurns.splice(index, 1);
        continue;
      }
      if (entry.type === "turn_started") {
        this.knownTurnIds.add(entry.turnId);
        if (entry.inboxItemId) this.markStarted(entry.inboxItemId, entry.turnId);
      }
    }
  }
}

function snapshotQueuedTurn(turn: AgentQueuedTurn): AgentQueuedTurn {
  assertLosslessJson(turn, "queued turn", new Set());
  return deepFreeze(JSON.parse(JSON.stringify(turn)) as AgentQueuedTurn);
}

function assertLosslessJson(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} contains a non-finite number.`);
  }
  if (typeof value !== "object") throw new TypeError(`${path} contains a non-JSON value.`);
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle.`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain JSON objects.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`${path} contains a sparse array.`);
      assertLosslessJson(value[index], `${path}[${index}]`, seen);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${path} contains a symbol key.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} is not a plain JSON field.`);
      }
      assertLosslessJson(descriptor.value, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
