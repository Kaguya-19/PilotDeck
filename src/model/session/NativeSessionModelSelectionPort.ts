import { DialogGatewayError } from "../../gateway/dialog/errors.js";
import {
  createAgentProjectSessionStorage,
  readAgentProjectSessionPersistence,
  replayTranscriptEntries,
  type AgentProjectSessionStorage,
  type ProjectSessionStorageProvider,
  ProjectSessionWriteCoordinator,
  type SessionPersistenceReadResult,
} from "../../session/index.js";
import type { SessionModelSelection } from "../../gateway/protocol/types.js";
import type {
  SessionModelSelectionPort,
  SessionModelSelectionScope,
} from "./SessionModelSelectionPort.js";

export type SessionModelSelectionStorage = Pick<
  AgentProjectSessionStorage,
  "restore" | "transcript" | "dispose"
>;

export type NativeSessionModelSelectionPortOptions = {
  pilotHome: string;
  now: () => Date;
  /** Application-selected backend shared with session creation, resume, and history reads. */
  storageProvider?: ProjectSessionStorageProvider;
  /** Test/embedding override for the read-only persistence boundary. */
  readPersistence?: (input: SessionModelSelectionScope) => Promise<SessionPersistenceReadResult>;
  /** Test/embedding override for the short-lived metadata writer runtime. */
  createStorage?: (input: SessionModelSelectionScope) => SessionModelSelectionStorage;
  /** Application-owned admission point shared with other transient session writers. */
  writeCoordinator?: ProjectSessionWriteCoordinator;
};

/**
 * Native provider backed by the existing session transcript. Reads use the
 * persistence definition directly; writes own only their short-lived runtime
 * so they can restore the durable sequence before appending metadata.
 */
export class NativeSessionModelSelectionPort implements SessionModelSelectionPort {
  private readonly createStorage: (input: SessionModelSelectionScope) => SessionModelSelectionStorage;
  private readonly readPersistence: (input: SessionModelSelectionScope) => Promise<SessionPersistenceReadResult>;
  private readonly writeCoordinator: ProjectSessionWriteCoordinator;

  constructor(private readonly options: NativeSessionModelSelectionPortOptions) {
    this.createStorage = options.createStorage ?? ((input) => createAgentProjectSessionStorage(this.storageOptions(input)));
    this.readPersistence = options.readPersistence ?? ((input) => readAgentProjectSessionPersistence(this.storageOptions(input)));
    this.writeCoordinator = options.writeCoordinator ?? new ProjectSessionWriteCoordinator();
  }

  async read(input: SessionModelSelectionScope): Promise<SessionModelSelection | undefined> {
    this.requireSessionKey(input.sessionKey);
    const replay = replayTranscriptEntries((await this.readPersistence(input)).entries);
    return replay.metadata.modelSelection ?? undefined;
  }

  async write(input: SessionModelSelectionScope & { selection: SessionModelSelection }): Promise<void> {
    this.requireSessionKey(input.sessionKey);
    await this.writeCoordinator.run(this.writeScope(input), () => this.recordMetadata(input, "model-selection", {
      modelSelection: input.selection,
      updatedAt: this.options.now().toISOString(),
    }));
  }

  async clear(input: SessionModelSelectionScope): Promise<void> {
    this.requireSessionKey(input.sessionKey);
    await this.writeCoordinator.run(this.writeScope(input), () => this.recordMetadata(input, "model-selection-clear", {
      modelSelection: null,
      updatedAt: this.options.now().toISOString(),
    }));
  }

  private storageOptions(input: SessionModelSelectionScope) {
    return {
      projectRoot: input.projectKey,
      pilotHome: this.options.pilotHome,
      sessionId: input.sessionKey,
      now: this.options.now,
      storageProvider: this.options.storageProvider,
    };
  }

  private writeScope(input: SessionModelSelectionScope) {
    return {
      projectRoot: input.projectKey,
      pilotHome: this.options.pilotHome,
      sessionId: input.sessionKey,
    };
  }

  private async recordMetadata(
    input: SessionModelSelectionScope,
    turnId: string,
    metadata: { modelSelection: SessionModelSelection | null; updatedAt: string },
  ): Promise<void> {
    const storage = this.createStorage(input);
    let recordError: unknown;
    try {
      await storage.restore();
      await storage.transcript.recordSessionMetadata(input.sessionKey, turnId, metadata);
    } catch (error) {
      recordError = error;
    }
    try {
      await storage.dispose();
    } catch (disposeError) {
      if (recordError) {
        throw new AggregateError(
          [recordError, disposeError],
          `Failed to record and dispose session model selection storage for ${input.sessionKey}.`,
        );
      }
      throw disposeError;
    }
    if (recordError) throw recordError;
  }

  private requireSessionKey(sessionKey: string): void {
    if (!sessionKey?.trim()) {
      throw new DialogGatewayError("INVALID_SESSION_KEY", "sessionKey is required.");
    }
  }
}
