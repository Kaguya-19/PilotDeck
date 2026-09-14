import type { AgentTranscriptEntry } from "../../transcript/TranscriptEntry.js";
import type { SessionProjectionCheckpoint } from "../SessionProjection.js";

export const SESSION_PROJECTION_CHECKPOINT_FORMAT = "pilotdeck.session-projections";
export const SESSION_PROJECTION_CHECKPOINT_VERSION = 1;

export type SessionProjectionCheckpointAnchor = {
  sequence: number;
  entryId: string | null;
  parentEntryId: string | null;
  turnId: string;
  type: AgentTranscriptEntry["type"];
  createdAt: string;
};

export type SessionProjectionCheckpointEnvelope = {
  format: typeof SESSION_PROJECTION_CHECKPOINT_FORMAT;
  version: typeof SESSION_PROJECTION_CHECKPOINT_VERSION;
  sessionId: string;
  asOfSequence: number;
  anchor: SessionProjectionCheckpointAnchor | null;
  projections: SessionProjectionCheckpoint;
};

export type SessionProjectionCheckpointStore = {
  load(sessionId: string): Promise<SessionProjectionCheckpointEnvelope | undefined>;
  save(envelope: SessionProjectionCheckpointEnvelope): Promise<void>;
};

export function createSessionProjectionCheckpointEnvelope(
  sessionId: string,
  asOfSequence: number,
  projections: SessionProjectionCheckpoint,
  entries: readonly AgentTranscriptEntry[],
): SessionProjectionCheckpointEnvelope {
  const anchorEntry = entries.find((entry) => entry.sequence === asOfSequence);
  if (asOfSequence >= 0 && !anchorEntry) {
    throw new Error(`Cannot checkpoint session ${sessionId}: sequence ${asOfSequence} is absent from the log.`);
  }
  const envelope: SessionProjectionCheckpointEnvelope = {
    format: SESSION_PROJECTION_CHECKPOINT_FORMAT,
    version: SESSION_PROJECTION_CHECKPOINT_VERSION,
    sessionId,
    asOfSequence,
    anchor: anchorEntry ? checkpointAnchor(anchorEntry) : null,
    projections,
  };
  return parseSessionProjectionCheckpointEnvelope(envelope, sessionId);
}

export function parseSessionProjectionCheckpointEnvelope(
  value: unknown,
  expectedSessionId: string,
): SessionProjectionCheckpointEnvelope {
  if (!isRecord(value)) throw new TypeError("Projection checkpoint must be an object.");
  if (value.format !== SESSION_PROJECTION_CHECKPOINT_FORMAT) {
    throw new TypeError("Projection checkpoint format is not supported.");
  }
  if (value.version !== SESSION_PROJECTION_CHECKPOINT_VERSION) {
    throw new TypeError("Projection checkpoint version is not supported.");
  }
  if (value.sessionId !== expectedSessionId) {
    throw new TypeError("Projection checkpoint belongs to a different session.");
  }
  if (!isSequence(value.asOfSequence)) {
    throw new TypeError("Projection checkpoint watermark is invalid.");
  }
  const anchor = parseAnchor(value.anchor, value.asOfSequence);
  if (!isRecord(value.projections)) {
    throw new TypeError("Projection checkpoint rows must be an object.");
  }
  const projections: SessionProjectionCheckpoint = {};
  for (const [name, row] of Object.entries(value.projections)) {
    if (!name.trim() || !isRecord(row)) {
      throw new TypeError("Projection checkpoint row is invalid.");
    }
    if (!Number.isSafeInteger(row.version) || (row.version as number) < 1) {
      throw new TypeError(`Projection checkpoint version is invalid: ${name}`);
    }
    if (!isSequence(row.asOfSequence) || (row.asOfSequence as number) > value.asOfSequence) {
      throw new TypeError(`Projection checkpoint watermark is invalid: ${name}`);
    }
    if (!("state" in row) || !isJsonValue(row.state)) {
      throw new TypeError(`Projection checkpoint state is invalid: ${name}`);
    }
    projections[name] = {
      version: row.version as number,
      asOfSequence: row.asOfSequence as number,
      state: structuredClone(row.state),
    };
  }
  return {
    format: SESSION_PROJECTION_CHECKPOINT_FORMAT,
    version: SESSION_PROJECTION_CHECKPOINT_VERSION,
    sessionId: expectedSessionId,
    asOfSequence: value.asOfSequence,
    anchor,
    projections,
  };
}

export function checkpointMatchesLog(
  envelope: SessionProjectionCheckpointEnvelope,
  entries: readonly AgentTranscriptEntry[],
): boolean {
  if (envelope.asOfSequence === -1) {
    return envelope.anchor === null;
  }
  const entry = entries.find((candidate) => candidate.sequence === envelope.asOfSequence);
  if (!entry || !envelope.anchor) return false;
  const anchor = checkpointAnchor(entry);
  return anchor.sequence === envelope.anchor.sequence &&
    anchor.entryId === envelope.anchor.entryId &&
    anchor.parentEntryId === envelope.anchor.parentEntryId &&
    anchor.turnId === envelope.anchor.turnId &&
    anchor.type === envelope.anchor.type &&
    anchor.createdAt === envelope.anchor.createdAt;
}

function checkpointAnchor(entry: AgentTranscriptEntry): SessionProjectionCheckpointAnchor {
  return {
    sequence: entry.sequence,
    entryId: entry.entryId ?? null,
    parentEntryId: entry.parentEntryId ?? null,
    turnId: entry.turnId,
    type: entry.type,
    createdAt: entry.createdAt,
  };
}

function parseAnchor(value: unknown, asOfSequence: number): SessionProjectionCheckpointAnchor | null {
  if (asOfSequence === -1) {
    if (value !== null) throw new TypeError("Empty-log projection checkpoint must not have an anchor.");
    return null;
  }
  if (!isRecord(value) || value.sequence !== asOfSequence) {
    throw new TypeError("Projection checkpoint anchor is invalid.");
  }
  if (
    !isNullableString(value.entryId) ||
    !isNullableString(value.parentEntryId) ||
    typeof value.turnId !== "string" ||
    typeof value.type !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new TypeError("Projection checkpoint anchor fields are invalid.");
  }
  return {
    sequence: asOfSequence,
    entryId: value.entryId,
    parentEntryId: value.parentEntryId,
    turnId: value.turnId,
    type: value.type as AgentTranscriptEntry["type"],
    createdAt: value.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= -1;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}
