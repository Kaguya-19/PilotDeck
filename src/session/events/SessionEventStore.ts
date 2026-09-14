import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type { SessionPersistenceReadResult } from "../persistence/SessionPersistence.js";

type SessionEventIdentityKey =
  | "sessionId"
  | "turnId"
  | "sequence"
  | "createdAt"
  | "entryId"
  | "parentEntryId";

export type SessionEventDraft = AgentTranscriptEntry extends infer Entry
  ? Entry extends AgentTranscriptEntry
    ? Omit<Entry, SessionEventIdentityKey>
    : never
  : never;

export type SessionEventStoreState = {
  sequence: number;
  lastEntryId: string | null;
};

export type SessionEventReadResult = SessionPersistenceReadResult;

export type SessionCommittedEventSubscriber = (
  entry: AgentTranscriptEntry,
) => void | Promise<void>;

export type SessionCommittedEventSubscription = {
  readonly active: boolean;
  dispose(): void;
};

export type SessionCommittedEventSubscriptionOptions = {
  failureMode?: "isolate" | "propagate";
  flush?: () => Promise<void>;
};

export type SessionEventStore = {
  append(sessionId: string, turnId: string, event: SessionEventDraft): Promise<AgentTranscriptEntry>;
  appendRecorded(entry: AgentTranscriptEntry): Promise<void>;
  read(): Promise<SessionEventReadResult>;
  flush(): Promise<void>;
  subscribe(
    subscriber: SessionCommittedEventSubscriber,
    options?: SessionCommittedEventSubscriptionOptions,
  ): SessionCommittedEventSubscription;
  restore(entries: readonly AgentTranscriptEntry[]): void;
  snapshotState(): SessionEventStoreState;
  restoreState(state: SessionEventStoreState): void;
};

export type SessionRuntimeOptions = {
  now?: () => Date;
  uuid?: () => string;
  onSubscriberError?: (error: unknown, entry: AgentTranscriptEntry) => void;
};

export type SequencedSessionEventStoreOptions = SessionRuntimeOptions;

export { SessionRuntime, SequencedSessionEventStore } from "./SessionRuntime.js";
