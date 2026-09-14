import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readTranscript } from "../transcript/TranscriptReader.js";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type {
  SessionPersistence,
  SessionPersistenceReadResult,
} from "./SessionPersistence.js";

export type JsonlSessionPersistenceOptions = {
  path: string;
};

export class JsonlSessionPersistence implements SessionPersistence {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: JsonlSessionPersistenceOptions) {}

  append(entry: AgentTranscriptEntry): Promise<void> {
    const write = this.writeTail.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      await appendFile(this.options.path, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  async load(): Promise<SessionPersistenceReadResult> {
    await this.flush();
    return readTranscript(this.options.path);
  }

  flush(): Promise<void> {
    return this.writeTail;
  }
}
