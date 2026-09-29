import type {
  GatewayRecordAgentStatusMessageInput,
  WebFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult,
  WebForkSessionInput,
  WebForkSessionResult,
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
  WebReadSubagentMessagesInput,
  WebReadSubagentMessagesResult,
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
} from "../gateway/protocol/types.js";
import {
  createAgentProjectSessionStorage,
  type AgentProjectSessionStorage,
  type ProjectSessionForkPort,
  type ProjectSessionReplacementPort,
  type ProjectSessionStorageProvider,
  ProjectSessionWriteCoordinator,
} from "../session/index.js";
import type { SessionCatalogPort } from "../session/catalog/SessionCatalogPort.js";
import {
  forkWebSession,
  type ForkWebSessionOptions,
} from "../web/server/forkSession.js";
import {
  readSubagentWebMessages,
  readWebSessionMessages,
  type ReadWebSessionMessagesOptions,
} from "../web/server/readSessionMessages.js";
import {
  finalizeLastWebSessionTurnReplacement,
  replaceLastWebSessionTurn,
  type ReplacementTransactionOwner,
  type ReplaceLastWebSessionTurnOptions,
} from "../web/server/replaceLastTurn.js";

type GatewaySessionHistoryStatusStorage = {
  transcript: Pick<AgentProjectSessionStorage["transcript"], "recordAgentStatusMessage">;
  restore: AgentProjectSessionStorage["restore"];
  dispose: AgentProjectSessionStorage["dispose"];
};

export type GatewaySessionHistoryProviders = {
  readSessionMessages: (
    input: WebReadSessionMessagesInput,
    options: ReadWebSessionMessagesOptions,
  ) => Promise<WebReadSessionMessagesResult>;
  readSubagentMessages: (
    input: WebReadSubagentMessagesInput,
    options: ReadWebSessionMessagesOptions,
  ) => Promise<WebReadSubagentMessagesResult>;
  forkSession: (
    input: WebForkSessionInput,
    options: ForkWebSessionOptions,
  ) => Promise<WebForkSessionResult>;
  replaceLastTurn: (
    input: WebReplaceLastTurnInput,
    options: ReplaceLastWebSessionTurnOptions,
  ) => Promise<WebReplaceLastTurnResult>;
  finalizeLastTurnReplacement: (
    input: WebFinalizeLastTurnReplacementInput,
    options: Omit<ReplaceLastWebSessionTurnOptions, "transactionOwner">,
  ) => Promise<WebFinalizeLastTurnReplacementResult>;
  createStorage: (input: {
    projectRoot: string;
    pilotHome: string;
    sessionId: string;
    now: () => Date;
    storageProvider?: ProjectSessionStorageProvider;
  }) => GatewaySessionHistoryStatusStorage;
};

export type GatewaySessionHistoryBundleOptions = {
  fallbackProjectRoot: string;
  pilotHome: string;
  sessionCatalog: SessionCatalogPort;
  now: () => Date;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  transactionOwner: ReplacementTransactionOwner;
  /** Application-selected backend shared with session creation and resume. */
  storageProvider?: ProjectSessionStorageProvider;
  /** Resolves the same host-owned storage used by session creation/resume. */
  resolveStorage?: (input: {
    projectRoot: string;
    sessionId: string;
    now: () => Date;
  }) => AgentProjectSessionStorage;
  sessionForkPort?: ProjectSessionForkPort;
  sessionReplacementPort?: ProjectSessionReplacementPort;
  /** Application-owned admission point shared with other short-lived session writers. */
  writeCoordinator?: ProjectSessionWriteCoordinator;
  providers?: Partial<GatewaySessionHistoryProviders>;
};

/**
 * Gateway consumer for session-history and transcript-edit operations.
 * Session storage, replay projections, and replacement transaction state stay
 * with their existing providers; this bundle only maps Gateway inputs to them.
 */
export class GatewaySessionHistoryBundle {
  private readonly providers: GatewaySessionHistoryProviders;
  private readonly writeCoordinator: ProjectSessionWriteCoordinator;

  constructor(private readonly options: GatewaySessionHistoryBundleOptions) {
    this.providers = {
      readSessionMessages: readWebSessionMessages,
      readSubagentMessages: readSubagentWebMessages,
      forkSession: forkWebSession,
      replaceLastTurn: replaceLastWebSessionTurn,
      finalizeLastTurnReplacement: finalizeLastWebSessionTurnReplacement,
      createStorage: createAgentProjectSessionStorage,
      ...options.providers,
    };
    this.writeCoordinator = options.writeCoordinator ?? new ProjectSessionWriteCoordinator();
  }

  async readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult> {
    const projectRoot = this.projectRoot(input.projectKey);
    const storage = this.resolveStorage(projectRoot, input.sessionKey);
    await storage?.recoverTranscriptReplacements?.();
    return this.providers.readSessionMessages(input, {
      projectRoot,
      pilotHome: this.options.pilotHome,
      sessionCatalog: this.options.sessionCatalog,
      ...(storage ? { storage } : { storageProvider: this.options.storageProvider }),
      maxContextTokens: this.options.maxContextTokens,
      maxOutputTokens: this.options.maxOutputTokens,
      now: this.options.now,
    });
  }

  async readSubagentMessages(input: WebReadSubagentMessagesInput): Promise<WebReadSubagentMessagesResult> {
    const projectRoot = this.projectRoot(input.projectKey);
    const storage = this.resolveStorage(projectRoot, input.parentSessionId ?? input.sessionKey);
    await storage?.recoverTranscriptReplacements?.();
    return this.providers.readSubagentMessages(input, {
      projectRoot,
      pilotHome: this.options.pilotHome,
      sessionCatalog: this.options.sessionCatalog,
      ...(storage ? { storage } : { storageProvider: this.options.storageProvider }),
      now: this.options.now,
    });
  }

  async forkSession(input: WebForkSessionInput): Promise<WebForkSessionResult> {
    const projectRoot = this.projectRoot(input.projectKey);
    const sourceStorage = this.resolveStorage(projectRoot, input.sessionKey);
    await sourceStorage?.recoverTranscriptReplacements?.();
    return this.providers.forkSession(input, {
      projectRoot,
      pilotHome: this.options.pilotHome,
      ...(this.options.resolveStorage
        ? { storageForSession: (sessionId: string) => this.options.resolveStorage!({ projectRoot, sessionId, now: this.options.now }) }
        : {
            storageProvider: this.options.storageProvider,
            sessionForkPort: this.options.sessionForkPort,
          }),
      now: this.options.now,
    });
  }

  async replaceLastTurn(input: WebReplaceLastTurnInput): Promise<WebReplaceLastTurnResult> {
    const projectRoot = this.projectRoot(input.projectKey);
    const storage = this.resolveStorage(projectRoot, input.sessionKey);
    await storage?.recoverTranscriptReplacements?.();
    return this.providers.replaceLastTurn(input, {
      projectRoot,
      pilotHome: this.options.pilotHome,
      ...(storage
        ? { storage }
        : {
            storageProvider: this.options.storageProvider,
            sessionReplacementPort: this.options.sessionReplacementPort,
          }),
      now: this.options.now,
      transactionOwner: this.options.transactionOwner,
    });
  }

  async finalizeLastTurnReplacement(
    input: WebFinalizeLastTurnReplacementInput,
  ): Promise<WebFinalizeLastTurnReplacementResult> {
    const projectRoot = this.projectRoot(input.projectKey);
    const storage = this.resolveStorage(projectRoot, input.sessionKey);
    return this.providers.finalizeLastTurnReplacement(input, {
      projectRoot,
      pilotHome: this.options.pilotHome,
      ...(storage
        ? { storage }
        : {
            storageProvider: this.options.storageProvider,
            sessionReplacementPort: this.options.sessionReplacementPort,
          }),
      now: this.options.now,
    });
  }

  async recordAgentStatusMessage(
    input: GatewayRecordAgentStatusMessageInput,
  ): Promise<{ recorded: boolean }> {
    const projectRoot = this.projectRoot(input.projectKey);
    return this.writeCoordinator.run({
      projectRoot,
      pilotHome: this.options.pilotHome,
      sessionId: input.sessionKey,
    }, () => this.recordStatusMessage(projectRoot, input));
  }

  private async recordStatusMessage(
    projectRoot: string,
    input: GatewayRecordAgentStatusMessageInput,
  ): Promise<{ recorded: boolean }> {
    const storage = this.resolveStorage(projectRoot, input.sessionKey) ?? this.providers.createStorage({
        projectRoot,
        pilotHome: this.options.pilotHome,
        sessionId: input.sessionKey,
        now: this.options.now,
        storageProvider: this.options.storageProvider,
      });
    let recordError: unknown;
    try {
      await storage.restore();
      await storage.transcript.recordAgentStatusMessage(input.sessionKey, input.turnId, input.status);
    } catch (error) {
      recordError = error;
    }
    try {
      await storage.dispose();
    } catch (disposeError) {
      if (recordError) {
        throw new AggregateError(
          [recordError, disposeError],
          `Failed to record and dispose Gateway status storage for ${input.sessionKey}.`,
        );
      }
      throw disposeError;
    }
    if (recordError) throw recordError;
    return { recorded: true };
  }

  private projectRoot(projectKey: string | undefined): string {
    return projectKey ? projectKey : this.options.fallbackProjectRoot;
  }

  private resolveStorage(projectRoot: string, sessionId: string): AgentProjectSessionStorage | undefined {
    return this.options.resolveStorage?.({ projectRoot, sessionId, now: this.options.now });
  }
}
