import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type { SessionEventStoreState } from "./SessionEventStore.js";

export type SessionEventValidationErrorCode =
  | "invalid_sequence"
  | "sequence_not_increasing"
  | "invalid_entry_id"
  | "duplicate_entry_id"
  | "invalid_parent_entry_id"
  | "self_parent";

export class SessionEventValidationError extends Error {
  constructor(
    readonly code: SessionEventValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionEventValidationError";
  }
}

export type SessionEventLogValidationResult = SessionEventStoreState & {
  entryIds: Set<string>;
};

export function validateSessionEventLog(
  entries: readonly AgentTranscriptEntry[],
): SessionEventLogValidationResult {
  const entryIds = new Set<string>();
  let sequence = 0;
  let lastEntryId: string | null = null;

  for (const entry of entries) {
    validateSessionEventEnvelope(entry);
    if (entry.sequence <= sequence) {
      throw new SessionEventValidationError(
        "sequence_not_increasing",
        `Session event sequence must increase strictly: received ${entry.sequence} after ${sequence}.`,
      );
    }
    sequence = entry.sequence;

    if (entry.entryId !== undefined) {
      if (entryIds.has(entry.entryId)) {
        throw new SessionEventValidationError(
          "duplicate_entry_id",
          `Session event entryId must be unique: ${entry.entryId}.`,
        );
      }
      entryIds.add(entry.entryId);
      lastEntryId = entry.entryId;
    }
  }

  return { sequence, lastEntryId, entryIds };
}

export function validateSessionEventAppend(
  entry: AgentTranscriptEntry,
  currentSequence: number,
  entryIds: ReadonlySet<string>,
): void {
  validateSessionEventEnvelope(entry);
  if (entry.sequence <= currentSequence) {
    throw new SessionEventValidationError(
      "sequence_not_increasing",
      `Recorded session event sequence ${entry.sequence} must be greater than current sequence ${currentSequence}.`,
    );
  }
  if (entry.entryId !== undefined && entryIds.has(entry.entryId)) {
    throw new SessionEventValidationError(
      "duplicate_entry_id",
      `Session event entryId must be unique: ${entry.entryId}.`,
    );
  }
}

export function validateSessionEventStoreState(state: SessionEventStoreState): void {
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    throw new SessionEventValidationError(
      "invalid_sequence",
      `Session event store sequence must be a non-negative safe integer: ${String(state.sequence)}.`,
    );
  }
  if (state.lastEntryId !== null && !isNonEmptyString(state.lastEntryId)) {
    throw new SessionEventValidationError(
      "invalid_entry_id",
      "Session event store lastEntryId must be null or a non-empty string.",
    );
  }
}

function validateSessionEventEnvelope(entry: AgentTranscriptEntry): void {
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= 0) {
    throw new SessionEventValidationError(
      "invalid_sequence",
      `Session event sequence must be a positive safe integer: ${String(entry.sequence)}.`,
    );
  }
  if (entry.entryId !== undefined && !isNonEmptyString(entry.entryId)) {
    throw new SessionEventValidationError(
      "invalid_entry_id",
      "Session event entryId must be a non-empty string when present.",
    );
  }
  if (
    entry.parentEntryId !== undefined
    && entry.parentEntryId !== null
    && !isNonEmptyString(entry.parentEntryId)
  ) {
    throw new SessionEventValidationError(
      "invalid_parent_entry_id",
      "Session event parentEntryId must be null or a non-empty string when present.",
    );
  }
  if (entry.entryId !== undefined && entry.parentEntryId === entry.entryId) {
    throw new SessionEventValidationError(
      "self_parent",
      `Session event ${entry.entryId} cannot reference itself as parent.`,
    );
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
