import type {
  AgentTranscriptDiagnostic,
  AgentTranscriptEntry,
} from "../transcript/TranscriptEntry.js";

/** Stable project/session identity for a read-only durable transcript lookup. */
export type SessionTranscriptReadInput = {
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
};

/** Durable transcript facts returned by a storage-selected reader. */
export type SessionTranscriptReadResult = {
  entries: readonly AgentTranscriptEntry[];
  diagnostics: readonly AgentTranscriptDiagnostic[];
};

/** Bounded user-prompt projection used by Always-On discovery. */
export type SessionUserPromptDigestInput = SessionTranscriptReadInput & {
  maxPrompts: number;
  maxPromptLength: number;
};

export type SessionUserPromptDigestResult = {
  prompts: readonly string[];
};

/**
 * Read-side session/storage capability for application consumers.
 *
 * The provider owns its backend access strategy. Consumers receive either
 * durable transcript entries or a bounded user-prompt projection; they never
 * derive a JSONL path, construct SessionRuntime, or own retention policy.
 */
export type SessionTranscriptReaderPort = {
  read(input: SessionTranscriptReadInput): Promise<SessionTranscriptReadResult>;
  readUserPromptDigest(input: SessionUserPromptDigestInput): Promise<SessionUserPromptDigestResult>;
};
