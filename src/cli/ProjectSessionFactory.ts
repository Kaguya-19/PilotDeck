import type { SessionConfigOverride } from "../always-on/runtime/SessionConfigOverrides.js";
import {
  createAgentSessionWithStorageAsync,
  type AgentLoopRuntimeFactory,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "../agent/index.js";
import type {
  GatewayEvent,
  GatewaySessionContext,
  InProcessGateway,
} from "../gateway/index.js";
import type { McpRuntimeFactory } from "../mcp/index.js";
import type { AgentRuntimeScope } from "../agent/scope/AgentRuntimeScope.js";
import {
  createAgentProjectSessionStorage,
  resumeAgentSession,
} from "../session/index.js";
import type { PilotDeckMcpServerSpec } from "../mcp/protocol/types.js";
import { SessionMcpRuntimeRegistry } from "../mcp/runtime/SessionMcpRuntimeRegistry.js";
import type { GatewaySessionResourceLeaseBundle } from "./GatewaySessionResourceLeaseBundle.js";
import {
  ProjectSessionRuntimeBundle,
  type ProjectSessionPermissionRuleSet,
  type ProjectSessionRuntime,
  type ProjectSessionRuntimeBundleResult,
} from "./ProjectSessionRuntimeBundle.js";
import type { GatewaySubagentContinuations } from "./GatewaySubagentRuntimeBundle.js";

/**
 * The session-facing subset of a published project generation.
 *
 * Publication, retirement, and generation leases remain with the registry.
 * This factory only consumes a generation selected by that owner while it
 * builds an Agent session and transfers the completed release callback to the
 * returned AgentHandle.
 */
export type ProjectSessionFactoryRuntime = ProjectSessionRuntime;

export type ProjectSessionFactoryOptions<Runtime extends ProjectSessionFactoryRuntime> = {
  resolveRuntime(projectKey?: string): Runtime;
  acquireRuntimeLease(runtime: Runtime): () => Promise<void>;
  acquirePermissionRuleSet(input: {
    sessionKey: string;
    permissionRules?: SessionConfigOverride["permissionRules"];
  }): ProjectSessionPermissionRuleSet;
  getSessionOverride(sessionKey: string): SessionConfigOverride | undefined;
  getGateway(): InProcessGateway | undefined;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  additionalWorkingDirectories?: string[];
  mcpRuntimeFactory?: McpRuntimeFactory;
  preparePerSessionSpecs(input: {
    runtime: Runtime;
    context: GatewaySessionContext;
    specs: readonly PilotDeckMcpServerSpec[];
  }): PilotDeckMcpServerSpec[];
  getAlwaysOnToolNames(): readonly string[];
  permissionTimeoutMs?: number;
  elicitationTimeoutMs?: number;
  pilotHome: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  continuations: GatewaySubagentContinuations;
  agentLoopFactory?: AgentLoopRuntimeFactory;
  testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
  shouldCollectFileArtifacts(runtime: Runtime): boolean;
  onDiagnostic?: (message: string, error?: unknown) => void;
};

type PreparedProjectSessionRuntime<Runtime extends ProjectSessionFactoryRuntime> =
  ProjectSessionRuntimeBundleResult & { runtime: Runtime };

/**
 * Per-session application composition for a published project generation.
 *
 * It owns only temporary session resource assembly and rollback. After a
 * successful create/recreate, the AgentHandle owns the returned disposer;
 * the project registry remains the sole owner of generation state.
 */
export class ProjectSessionFactory<Runtime extends ProjectSessionFactoryRuntime> {
  private readonly sessionMcpRuntimes = new SessionMcpRuntimeRegistry();

  constructor(private readonly options: ProjectSessionFactoryOptions<Runtime>) {}

  async dispose(): Promise<void> {
    await this.sessionMcpRuntimes.dispose();
  }

  async createSession(context: GatewaySessionContext) {
    const prepared = await this.prepare(context);
    try {
      const resumed = await resumeAgentSession({
        sessionId: context.sessionKey,
        config: prepared.agentConfig,
        dependencies: prepared.baseDependencies,
        projectStorage: prepared.runtime.projectStorage,
        extendDependencies: prepared.extendDependencies,
        ownedToolRegistry: true,
        __configure: this.composeDisposer(prepared, prepared.configureContinuableSubagents),
        sessionTitleProvider: prepared.sessionTitleProvider,
        sessionTitleGenerator: prepared.sessionTitleGenerator,
        inputProcessor: prepared.inputProcessor,
        collectFileArtifacts: this.options.shouldCollectFileArtifacts(prepared.runtime),
        agentLoopFactory: this.options.agentLoopFactory,
        __agentLoopFactory: this.options.testAgentLoopFactory,
      });
      return resumed.handle;
    } catch (error) {
      await this.releasePreparedResources(prepared).catch(() => undefined);
      throw error;
    }
  }

  async recreateSession(context: GatewaySessionContext, previousSession: AgentSession) {
    const prepared = await this.prepare(context);
    const previous = previousSession.snapshotForRuntimeReload();
    const storage = createAgentProjectSessionStorage({
      ...prepared.runtime.projectStorage,
      sessionId: context.sessionKey,
      now: prepared.baseDependencies.now,
    });
    try {
      const readResult = await storage.restore();
      if (previous.transcriptWriterState) {
        storage.events.restoreState(previous.transcriptWriterState);
      }
      const extensionDependencies = prepared.extendDependencies(storage);
      const { handle } = await createAgentSessionWithStorageAsync({
        sessionId: context.sessionKey,
        config: prepared.agentConfig,
        dependencies: mergeSessionDependencies(prepared.baseDependencies, extensionDependencies),
        storage,
        transcript: storage.transcript,
        initialState: previous.state,
        seedState: previous.fileState,
        initialMetadata: previous.metadata,
        restoredEntries: readResult.entries,
        ownedToolRegistry: true,
        __configure: this.composeDisposer(prepared, prepared.configureContinuableSubagents),
        sessionTitleProvider: prepared.sessionTitleProvider,
        sessionTitleGenerator: prepared.sessionTitleGenerator,
        inputProcessor: prepared.inputProcessor,
        collectFileArtifacts: this.options.shouldCollectFileArtifacts(prepared.runtime),
        agentLoopFactory: this.options.agentLoopFactory,
        __agentLoopFactory: this.options.testAgentLoopFactory,
      });
      return handle;
    } catch (error) {
      await this.releasePreparedResources(prepared).catch(() => undefined);
      try {
        await storage.dispose();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Failed to recreate and roll back agent session ${context.sessionKey}.`,
        );
      }
      throw error;
    }
  }

  private async prepare(
    context: GatewaySessionContext,
  ): Promise<PreparedProjectSessionRuntime<Runtime>> {
    const runtime = this.options.resolveRuntime(context.projectKey);
    const override = this.options.getSessionOverride(context.sessionKey);
    const gateway = this.options.getGateway();
    const gatewayInteraction = gateway
      ? {
          permissionBus: gateway.getPermissionBus(),
          elicitationBus: gateway.getElicitationBus(),
          interactionReconnect: gateway.getInteractionReconnectPort(),
          emit: (event: GatewayEvent) => gateway.emitForSession(context.sessionKey, event),
        }
      : undefined;
    const prepared = await new ProjectSessionRuntimeBundle({
      context,
      runtime,
      acquireRuntimeLease: () => this.options.acquireRuntimeLease(runtime),
      acquirePermissionRuleSet: () => this.options.acquirePermissionRuleSet({
        sessionKey: context.sessionKey,
        permissionRules: override?.permissionRules,
      }),
      sessionOverride: override,
      interaction: {
        profile: runtime.profile.interaction,
        canPrompt: override?.canPrompt ?? runtime.profile.interaction.canPrompt,
      },
      permissionMode: this.options.permissionMode,
      additionalWorkingDirectories: this.options.additionalWorkingDirectories,
      gateway: gatewayInteraction,
      sessionMcpRuntimes: this.sessionMcpRuntimes,
      mcpRuntimeFactory: this.options.mcpRuntimeFactory,
      preparePerSessionSpecs: (specs) => this.options.preparePerSessionSpecs({ runtime, context, specs }),
      alwaysOnToolNames: this.options.getAlwaysOnToolNames(),
      permissionTimeoutMs: this.options.permissionTimeoutMs,
      elicitationTimeoutMs: this.options.elicitationTimeoutMs,
      pilotHome: this.options.pilotHome,
      env: this.options.env,
      now: this.options.now,
      continuations: this.options.continuations,
      agentLoopFactory: this.options.agentLoopFactory,
      testAgentLoopFactory: this.options.testAgentLoopFactory,
      collectFileArtifacts: this.options.shouldCollectFileArtifacts(runtime),
      onDiagnostic: this.options.onDiagnostic,
    }).compose();
    return { runtime, ...prepared };
  }

  private composeDisposer(
    prepared: PreparedProjectSessionRuntime<Runtime>,
    configure: NonNullable<CreateAgentSessionOptions["__configure"]>,
  ): NonNullable<CreateAgentSessionOptions["__configure"]> {
    return (input) => {
      const configured = configure(input);
      let released = false;
      return async () => {
        try {
          await configured?.();
        } finally {
          if (!released) {
            released = true;
            await this.releasePreparedResources(prepared);
          }
        }
      };
    };
  }

  private async releasePreparedResources(
    prepared: Pick<PreparedProjectSessionRuntime<Runtime>, "resources">,
  ): Promise<void> {
    await prepared.resources.release();
  }
}

function mergeSessionDependencies(
  base: CreateAgentSessionOptions["dependencies"],
  extension: Partial<
    Pick<
      AgentRuntimeDependencies,
      "context" | "promptContributions" | "fileHistory" | "subagentTranscript" | "elicitation" | "eventEmitter" | "drainEvents" | "planFileManager" | "planTodoManager" | "goalManager"
      | "ownedElicitation" | "interactionReconnect"
    >
  >,
): CreateAgentSessionOptions["dependencies"] {
  return {
    ...base,
    ...(extension.context ? { context: extension.context } : {}),
    ...(extension.promptContributions ? { promptContributions: extension.promptContributions } : {}),
    ...(extension.fileHistory ? { fileHistory: extension.fileHistory } : {}),
    ...(extension.subagentTranscript ? { subagentTranscript: extension.subagentTranscript } : {}),
    ...(extension.elicitation ? { elicitation: extension.elicitation } : {}),
    ...(extension.ownedElicitation !== undefined ? { ownedElicitation: extension.ownedElicitation } : {}),
    ...(extension.interactionReconnect ? { interactionReconnect: extension.interactionReconnect } : {}),
    ...(extension.eventEmitter ? { eventEmitter: extension.eventEmitter } : {}),
    ...(extension.drainEvents ? { drainEvents: extension.drainEvents } : {}),
    ...(extension.planFileManager ? { planFileManager: extension.planFileManager } : {}),
    ...(extension.planTodoManager ? { planTodoManager: extension.planTodoManager } : {}),
    ...(extension.goalManager ? { goalManager: extension.goalManager } : {}),
  };
}
