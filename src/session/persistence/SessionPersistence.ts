import type {
  AgentTranscriptDiagnostic,
  AgentTranscriptEntry,
} from "../transcript/TranscriptEntry.js";

export type SessionPersistenceReadResult = {
  entries: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
};

export type SessionPersistence = {
  append(entry: AgentTranscriptEntry): Promise<void>;
  load(): Promise<SessionPersistenceReadResult>;
  flush(): Promise<void>;
};
