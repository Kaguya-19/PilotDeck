import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";

export type SessionProjectionReplayContext = {
  readonly entries: readonly AgentTranscriptEntry[];
};

export type SessionProjectionReduceContext = SessionProjectionReplayContext & {
  readonly index: number;
};

export type SessionProjectionDefinition<State, Result = State> = {
  readonly name: string;
  readonly version: number;
  create(context: SessionProjectionReplayContext): State;
  reduce(
    state: State,
    entry: AgentTranscriptEntry,
    context: SessionProjectionReduceContext,
  ): State | void;
  finalize?(state: State, context: SessionProjectionReplayContext): Result;
  checkpoint?: {
    encode(state: State): unknown;
    decode(value: unknown): State;
  };
};

export type SessionProjectionDescriptor = {
  name: string;
  version: number;
};

export type SessionProjectionRegistration = SessionProjectionDescriptor & {
  readonly active: boolean;
  dispose(): void;
};

export type SessionProjectionRegistryChange =
  | { type: "registered"; definition: SessionProjectionDefinition<unknown, unknown> }
  | { type: "removed"; name: string; version: number };

export type SessionProjectionRegistrySubscription = {
  readonly active: boolean;
  dispose(): void;
};

export type SessionProjectionSnapshot = {
  asOfSequence: number;
  values: Record<string, unknown>;
};

export function requireSessionProjectionValue<Result>(
  snapshot: SessionProjectionSnapshot,
  name: string,
): Result {
  if (!Object.prototype.hasOwnProperty.call(snapshot.values, name)) {
    throw new Error(`Session projection is not available: ${name}`);
  }
  return snapshot.values[name] as Result;
}

export type SessionProjectionChange = {
  name: string;
  version: number;
  asOfSequence: number;
  value: unknown;
};

export type SessionProjectionChangeSubscription = {
  readonly active: boolean;
  dispose(): void;
};

export type SessionProjectionCheckpointRow = {
  version: number;
  asOfSequence: number;
  state: unknown;
};

export type SessionProjectionCheckpoint = Record<string, SessionProjectionCheckpointRow>;
