import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type {
  SessionPersistence,
  SessionPersistenceReadResult,
} from "./SessionPersistence.js";

export class InMemorySessionPersistence implements SessionPersistence {
  readonly entries: AgentTranscriptEntry[] = [];

  async append(entry: AgentTranscriptEntry): Promise<void> {
    this.entries.push(entry);
  }

  async load(): Promise<SessionPersistenceReadResult> {
    return { entries: [...this.entries], diagnostics: [] };
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}
