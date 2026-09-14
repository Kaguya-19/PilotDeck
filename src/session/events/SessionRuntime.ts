import { randomUUID } from "node:crypto";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type {
  SessionCommittedEventSubscriber,
  SessionCommittedEventSubscription,
  SessionCommittedEventSubscriptionOptions,
  SessionEventDraft,
  SessionEventReadResult,
  SessionEventStore,
  SessionEventStoreState,
  SessionRuntimeOptions,
} from "./SessionEventStore.js";
import {
  validateSessionEventAppend,
  validateSessionEventLog,
  validateSessionEventStoreState,
} from "./SessionEventLogValidation.js";
import {
  createSessionDomainValidationState,
  validateSessionDomainEvent,
  validateSessionDomainLog,
  type SessionDomainValidationState,
} from "./SessionDomainValidation.js";

export class SessionRuntime implements SessionEventStore {
  private sequence = 0;
  private lastEntryId: string | null = null;
  private commitTail: Promise<void> = Promise.resolve();
  private committedEntries: AgentTranscriptEntry[] = [];
  private entryIds = new Set<string>();
  private domainState: SessionDomainValidationState = createSessionDomainValidationState();
  private readonly subscribers = new Map<symbol, {
    subscriber: SessionCommittedEventSubscriber;
    options: SessionCommittedEventSubscriptionOptions;
  }>();
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly onSubscriberError?: SessionRuntimeOptions["onSubscriberError"];

  constructor(options: SessionRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.onSubscriberError = options.onSubscriberError;
  }

  append(
    sessionId: string,
    turnId: string,
    event: SessionEventDraft,
  ): Promise<AgentTranscriptEntry> {
    let stableEvent: SessionEventDraft;
    try {
      stableEvent = materializeJsonValue(event);
    } catch (error) {
      return Promise.reject(error);
    }
    const createdAt = this.now().toISOString();
    const entryId = this.uuid();
    return this.enqueue(async () => {
      const entry = materializeSessionEvent({
        ...stableEvent,
        sessionId,
        turnId,
        sequence: this.sequence + 1,
        createdAt,
        entryId,
        parentEntryId: this.lastEntryId,
      } as AgentTranscriptEntry);
      await this.commit(entry);
      return entry;
    });
  }

  appendRecorded(entry: AgentTranscriptEntry): Promise<void> {
    let stableEntry: AgentTranscriptEntry;
    try {
      stableEntry = materializeSessionEvent(entry);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(async () => {
      await this.commit(stableEntry);
    });
  }

  subscribe(
    subscriber: SessionCommittedEventSubscriber,
    options: SessionCommittedEventSubscriptionOptions = {},
  ): SessionCommittedEventSubscription {
    const token = Symbol("session-committed-event-subscriber");
    this.subscribers.set(token, { subscriber, options });
    let active = true;

    return {
      get active() {
        return active;
      },
      dispose: () => {
        if (!active) return;
        active = false;
        this.subscribers.delete(token);
      },
    };
  }

  restore(entries: readonly AgentTranscriptEntry[]): void {
    const committedEntries = entries.map(materializeSessionEvent);
    const validated = validateSessionEventLog(committedEntries);
    const domainState = validateSessionDomainLog(committedEntries);
    this.committedEntries = committedEntries;
    this.entryIds = validated.entryIds;
    this.sequence = validated.sequence;
    this.lastEntryId = validated.lastEntryId;
    this.domainState = domainState;
  }

  snapshotState(): SessionEventStoreState {
    return {
      sequence: this.sequence,
      lastEntryId: this.lastEntryId,
    };
  }

  restoreState(state: SessionEventStoreState): void {
    validateSessionEventStoreState(state);
    this.sequence = state.sequence;
    this.lastEntryId = state.lastEntryId;
    this.domainState = createSessionDomainValidationState();
  }

  async flush(): Promise<void> {
    await this.commitTail;
    for (const registration of this.subscribers.values()) {
      await registration.options.flush?.();
    }
  }

  async read(): Promise<SessionEventReadResult> {
    await this.flush();
    return { entries: [...this.committedEntries], diagnostics: [] };
  }

  private async commit(entry: AgentTranscriptEntry): Promise<void> {
    validateSessionEventAppend(entry, this.sequence, this.entryIds);
    const nextDomainState = validateSessionDomainEvent(this.domainState, entry);
    await this.publish(entry);
    this.sequence = entry.sequence;
    this.lastEntryId = entry.entryId ?? this.lastEntryId;
    if (entry.entryId !== undefined) this.entryIds.add(entry.entryId);
    this.committedEntries.push(entry);
    this.domainState = nextDomainState;
  }

  private async publish(entry: AgentTranscriptEntry): Promise<void> {
    for (const [token, registration] of [...this.subscribers]) {
      if (this.subscribers.get(token) !== registration) continue;
      try {
        await registration.subscriber(entry);
      } catch (error) {
        if (registration.options.failureMode === "propagate") {
          throw error;
        }
        try {
          this.onSubscriberError?.(error, entry);
        } catch {
          // A diagnostic sink must not change committed event semantics.
        }
      }
    }
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.commitTail.then(operation);
    this.commitTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Legacy compatibility name; new code composes SessionRuntime with SessionPersistence. */
export abstract class SequencedSessionEventStore extends SessionRuntime {}

function materializeSessionEvent(entry: AgentTranscriptEntry): AgentTranscriptEntry {
  return materializeJsonValue(entry);
}

function materializeJsonValue<Value>(value: Value): Value {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Session event must be JSON serializable.");
  }
  return deepFreeze(JSON.parse(serialized) as Value);
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
