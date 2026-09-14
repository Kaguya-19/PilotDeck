import type { SessionConfigOverride } from "../always-on/runtime/SessionConfigOverrides.js";
import {
  createAgentEventBuffer,
  type AgentLoopRuntimeFactory,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentInputAdmission,
  type CreateAgentSessionOptions,
  type SubagentProviderRegistry,
} from "../agent/index.js";
import { resolveRoutedModelMaxContextTokens } from "../agent/runtime/modelContextWindow.js";
import {
  InputProcessor,
  PluginRuntimeExtensionResolver,
  type CompactionPort,
  type InstructionStoragePort,
  type MemoryResolver,
  type PromptCacheCoordinatorPort,
  type TokenAccountingRuntime,
  type ToolResultSpillPort,
} from "../context/index.js";
import type { PluginRuntime } from "../extension/index.js";
import {
  GatewaySessionLiveProjectionBundle,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
} from "../gateway/index.js";
import type { McpRuntimeFactory, ProjectMcpRuntimeProvider } from "../mcp/index.js";
import type { ModelRuntime } from "../model/index.js";
import type { PermissionRuleSet } from "../permission/index.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import type { RouterRuntime } from "../router/index.js";
import type { RouterSessionCustomRouterPort } from "../router/index.js";
import { createAgentProjectSessionStorage } from "../session/index.js";
import { createSessionTitleGenerator } from "../session/title/SessionTitleGenerator.js";
import type {
  ExecutionWorldBundle,
  PilotDeckToolDefinition,
  PilotDeckUnavailableToolDiagnostic,
  ToolRegistry,
} from "../tool/index.js";
import { SessionMcpRuntimeRegistry } from "../mcp/runtime/SessionMcpRuntimeRegistry.js";
import {
  createNativeSessionTitleProvider,
  type SessionTitlePort,
} from "../session/index.js";
import { GatewaySessionResourceLeaseBundle } from "./GatewaySessionResourceLeaseBundle.js";
import {
  SessionInteractionBundle,
  type GatewaySessionInteractionFacade,
} from "./SessionInteractionBundle.js";
import {
  SessionMcpRuntimeBundle,
  type SessionMcpRuntimeBundleOptions,
} from "./SessionMcpRuntimeBundle.js";
import { SessionToolCompositionBundle } from "./SessionToolCompositionBundle.js";
import { SessionContextRuntimeBundle } from "./SessionContextRuntimeBundle.js";
import { SessionFileHistoryBundle } from "./SessionFileHistoryBundle.js";
import { SessionPlanTodoBundle } from "./SessionPlanTodoBundle.js";
import { SessionGoalBundle } from "./SessionGoalBundle.js";
import {
  SessionSubagentContinuationBundle,
  type SessionSubagentContinuationRuntime,
} from "./SessionSubagentContinuationBundle.js";
import { SessionSubagentTranscriptBundle } from "./SessionSubagentTranscriptBundle.js";
import { SessionAgentConfigBundle } from "./SessionAgentConfigBundle.js";
import type { PilotDeckRuntimeProfile } from "./PilotDeckRuntimeProfile.js";
import type { InteractionProfile } from "../interaction/index.js";

/**
 * The project-generation services consumed while composing one Agent session.
 * The ProjectRuntimeRegistry retains generation publication and lease state;
 * this bundle only consumes a published generation.
 */
export type ProjectSessionRuntime = {
  projectRoot: string;
  projectStorage: GatewayProjectStorageOptions;
  snapshot: PilotConfigSnapshot;
  profile: PilotDeckRuntimeProfile;
  model: ModelRuntime;
  router: RouterRuntime;
  routerSessionCustomRouters: RouterSessionCustomRouterPort;
  tools: ToolRegistry;
  mcpProvider: ProjectMcpRuntimeProvider;
  pluginRuntime: Pick<PluginRuntime, "refresh" | "acquireSessionContributions">;
  executionWorld: Pick<ExecutionWorldBundle, "shell" | "planStorage" | "backgroundTasks">;
  instructionStorage: InstructionStoragePort;
  toolResultSpill: ToolResultSpillPort;
  compaction?: CompactionPort;
  promptCacheCoordinator?: PromptCacheCoordinatorPort;
  sessionTitleProvider?: SessionTitlePort;
  tokenAccounting: TokenAccountingRuntime;
  memory?: MemoryResolver;
  unavailableTools?: PilotDeckUnavailableToolDiagnostic[];
};

export type ProjectSessionPermissionRuleSet = {
  rules: PermissionRuleSet;
  release(): void | Promise<void>;
};

export type ProjectSessionRuntimeBundleResult = {
  /** Retains the exact project, plugin, MCP and permission resources used here. */
  resources: GatewaySessionResourceLeaseBundle;
  permissionRules: PermissionRuleSet;
  agentConfig: AgentRuntimeConfig;
  baseDependencies: CreateAgentSessionOptions["dependencies"];
  sessionTitleGenerator: ReturnType<typeof createSessionTitleGenerator>;
  /** Selected provider consumed by TurnRunner; generator remains compatibility output. */
  sessionTitleProvider: SessionTitlePort;
  /** Session-owned input admission against the exact extension lease. */
  inputProcessor: AgentInputAdmission;
  extendDependencies: (
    storage: ReturnType<typeof createAgentProjectSessionStorage>,
  ) => Partial<AgentRuntimeDependencies>;
  configureContinuableSubagents: NonNullable<CreateAgentSessionOptions["__configure"]>;
};

export type ProjectSessionRuntimeBundleOptions = {
  context: GatewaySessionContext;
  runtime: ProjectSessionRuntime;
  /** Acquires the current generation lease only after composition begins. */
  acquireRuntimeLease: () => () => Promise<void>;
  acquirePermissionRuleSet: () => ProjectSessionPermissionRuleSet;
  sessionOverride?: SessionConfigOverride;
  interaction: {
    profile: InteractionProfile;
    canPrompt: boolean;
  };
  permissionMode: AgentRuntimeConfig["permissionMode"];
  additionalWorkingDirectories?: string[];
  gateway?: GatewaySessionInteractionFacade;
  sessionMcpRuntimes: SessionMcpRuntimeRegistry;
  mcpRuntimeFactory?: McpRuntimeFactory;
  preparePerSessionSpecs: NonNullable<SessionMcpRuntimeBundleOptions["preparePerSessionSpecs"]>;
  alwaysOnToolNames: readonly string[];
  permissionTimeoutMs?: number;
  elicitationTimeoutMs?: number;
  pilotHome: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  continuations: SessionSubagentContinuationRuntime & {
    readonly providers: SubagentProviderRegistry;
  };
  agentLoopFactory?: AgentLoopRuntimeFactory;
  testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
  collectFileArtifacts: boolean;
  onDiagnostic?: (message: string, error?: unknown) => void;
};

/**
 * Session-level application composition for one published project generation.
 *
 * It owns only the temporary resource-lease aggregate and releases it on a
 * failed build. Project generation publication, Gateway pending state,
 * storage, AgentLoop execution and final ToolRegistry ownership remain with
 * their established owners.
 */
export class ProjectSessionRuntimeBundle {
  constructor(private readonly options: ProjectSessionRuntimeBundleOptions) {}

  async compose(): Promise<ProjectSessionRuntimeBundleResult> {
    const { context, runtime } = this.options;
    const resources = new GatewaySessionResourceLeaseBundle();
    resources.add("project runtime lease", this.options.acquireRuntimeLease());
    try {
      const permissionRuleSet = this.options.acquirePermissionRuleSet();
      resources.add("permission rule-set lease", async () => permissionRuleSet.release());

      await runtime.pluginRuntime.refresh();
      const extensionLease = runtime.pluginRuntime.acquireSessionContributions();
      resources.add("plugin contribution lease", extensionLease.release);
      const contributions = extensionLease.contributions;
      const extension = new PluginRuntimeExtensionResolver(contributions);
      const inputProcessor = new InputProcessor({ extension });
      const routerRegistration = runtime.routerSessionCustomRouters.register(
        context.sessionKey,
        contributions.routers.map(({ contribution }) => contribution.createCustomRouter()),
      );
      resources.add("session custom-router registration", async () => routerRegistration.release());

      const sessionToolComposition = await new SessionToolCompositionBundle({
        composeMcpTools: () => new SessionMcpRuntimeBundle({
          sessionKey: context.sessionKey,
          baseTools: runtime.tools,
          mcpProvider: runtime.mcpProvider,
          mcpServers: contributions.mcpServers,
          resources,
          perSessionRuntimes: this.options.sessionMcpRuntimes,
          maxPerSessionInstances: runtime.snapshot.config.gateway?.maxPerSessionMcpInstances ?? 5,
          createRuntime: this.options.mcpRuntimeFactory,
          preparePerSessionSpecs: this.options.preparePerSessionSpecs,
          onDiagnostic: (message, error) => this.options.onDiagnostic?.(message, error),
        }).compose(),
        extension,
        availability: { cwd: runtime.projectRoot, env: this.options.env },
        excludeTools: this.options.sessionOverride?.excludeTools,
        isAlwaysOnSession: context.sessionKey.startsWith("always-on/"),
        alwaysOnToolNames: this.options.alwaysOnToolNames,
      }).compose();
      const sessionTools = sessionToolComposition.registry;
      runtime.unavailableTools = sessionToolComposition.unavailable;

      const eventBuf = createAgentEventBuffer();
      const sessionInteraction = new SessionInteractionBundle({
        sessionKey: context.sessionKey,
        profile: this.options.interaction.profile,
        canPrompt: this.options.interaction.canPrompt,
        permissionRules: permissionRuleSet.rules.allow,
        hookSettings: contributions.hooks,
        shell: runtime.executionWorld.shell,
        projectRoot: runtime.projectRoot,
        permissionTimeoutMs: this.options.permissionTimeoutMs,
        questionTimeoutMs: this.options.elicitationTimeoutMs,
        eventEmitter: eventBuf.emitter,
        gateway: this.options.gateway,
      });
      const lifecycle = sessionInteraction.lifecycle;
      const agentConfig = new SessionAgentConfigBundle({
        runtime,
        sessionOverride: this.options.sessionOverride,
        permissionRules: permissionRuleSet.rules,
        interaction: this.options.interaction,
        permissionMode: this.options.permissionMode,
        additionalWorkingDirectories: this.options.additionalWorkingDirectories,
        env: this.options.env,
      }).compose();
      const baseDependencies: CreateAgentSessionOptions["dependencies"] = {
        router: runtime.router,
        tools: { registry: sessionTools },
        permission: sessionInteraction.permission,
        interactionPolicy: sessionInteraction.policy,
        subagentProviders: this.options.continuations.providers,
        interactionDeadlinePolicy: sessionInteraction.deadlinePolicy,
        ...(sessionInteraction.interactionReconnect
          ? { interactionReconnect: sessionInteraction.interactionReconnect }
          : {}),
        lifecycle,
        ownedLifecycle: true,
        now: this.options.now,
        eventEmitter: eventBuf.emitter,
        drainEvents: eventBuf.drain,
        tokenAccounting: runtime.tokenAccounting,
        getModelMaxContextTokens: (provider, model) => resolveRoutedModelMaxContextTokens({
          modelRuntime: runtime.model,
          agentModel: runtime.snapshot.config.agent.model,
          agentMaxContextTokens: runtime.snapshot.config.agent.maxContextTokens,
          provider,
          model,
        }),
        getModelMaxOutputTokens: (provider, model) => {
          try {
            return runtime.model.getCapabilities(provider, model).maxOutputTokens;
          } catch {
            return undefined;
          }
        },
        getModelTokenLimits: (provider, model) => {
          try {
            const caps = runtime.model.getCapabilities(provider, model);
            return { maxContextTokens: caps.maxContextTokens, maxOutputTokens: caps.maxOutputTokens };
          } catch {
            return undefined;
          }
        },
        getModelProtocol: (provider) => runtime.model.getProviderProtocol(provider),
        getModelSupportsPromptCache: (provider, model) => {
          try {
            return runtime.model.getCapabilities(provider, model).supportsPromptCache;
          } catch {
            return undefined;
          }
        },
      };
      const sessionTitleProvider = runtime.sessionTitleProvider ?? createNativeSessionTitleProvider({
        modelRuntime: runtime.model,
        agentModel: runtime.snapshot.config.agent.model,
      });
      const sessionTitleGenerator = sessionTitleProvider.generate;
      let goalSequence = 0;
      const extendDependencies = (
        storage: ReturnType<typeof createAgentProjectSessionStorage>,
      ) => {
        const agentModel = runtime.snapshot.config.agent.model;
        const caps = runtime.model.getCapabilities(agentModel.provider, agentModel.model);
        const sessionContext = new SessionContextRuntimeBundle({
          sessionKey: context.sessionKey,
          projectKey: context.projectKey,
          projectRoot: runtime.projectRoot,
          pilotHome: this.options.pilotHome,
          toolResultsDir: storage.toolResultsDir,
          extension,
          instructionStorage: runtime.instructionStorage,
          toolResultSpill: runtime.toolResultSpill,
          compaction: runtime.compaction,
          promptCacheCoordinator: runtime.promptCacheCoordinator,
          model: runtime.router,
          tokenAccounting: runtime.tokenAccounting,
          lifecycle,
          modelProvider: agentModel.provider,
          modelName: agentModel.model,
          maxContextTokens: runtime.snapshot.config.agent.maxContextTokens ?? caps.maxContextTokens,
          runtimeContextSurface: runtime.profile.runtimeContextSurface,
          memoryResolver: runtime.memory,
          memoryRetrievalTimeoutMs: runtime.snapshot.config.memory?.retrievalTimeoutMs,
          now: this.options.now,
          eventEmitter: eventBuf.emitter,
        }).compose();
        const fileHistory = new SessionFileHistoryBundle({
          sessionKey: context.sessionKey,
          storage,
          now: this.options.now,
        }).compose();
        const subagentTranscript = new SessionSubagentTranscriptBundle({
          storage,
          now: this.options.now,
        }).compose();
        const planTodo = new SessionPlanTodoBundle({
          sessionKey: context.sessionKey,
          projectRoot: runtime.projectRoot,
          storage,
          planStorage: runtime.executionWorld.planStorage,
        }).compose();
        const goal = new SessionGoalBundle({
          sessionKey: context.sessionKey,
          storage,
          uuid: () => `${this.options.now().getTime()}-${++goalSequence}`,
        }).compose();
        return {
          context: sessionContext.context,
          ownedContext: true,
          promptContributions: sessionContext.promptContributions,
          fileHistory,
          subagentTranscript,
          elicitation: sessionInteraction.elicitation,
          ownedElicitation: sessionInteraction.ownedElicitation,
          planFileManager: planTodo.planFileManager,
          planTodoManager: planTodo.planTodoManager,
          goalManager: goal.goalManager,
        };
      };
      const configureContinuableSubagents: NonNullable<CreateAgentSessionOptions["__configure"]> = (input) => {
        if (this.options.gateway) {
          new GatewaySessionLiveProjectionBundle({
            scope: input.scope,
            sessionKey: context.sessionKey,
            hookExecutionEvents: lifecycle,
            backgroundTaskCompletionEvents: runtime.executionWorld.backgroundTasks,
            emit: this.options.gateway.emit,
          }).attach();
        }
        sessionInteraction.attach(input.scope);
        return new SessionSubagentContinuationBundle({
          runtime: this.options.continuations,
        }).attach({
          handle: input.handle,
          config: input.config,
          dependencies: input.dependencies,
          projectStorage: runtime.projectStorage,
          agentLoopFactory: this.options.agentLoopFactory,
          testAgentLoopFactory: this.options.testAgentLoopFactory,
          collectFileArtifacts: this.options.collectFileArtifacts,
        });
      };

      return {
        resources,
        permissionRules: permissionRuleSet.rules,
        agentConfig,
        baseDependencies,
        sessionTitleGenerator,
        sessionTitleProvider,
        inputProcessor,
        extendDependencies,
        configureContinuableSubagents,
      };
    } catch (error) {
      await resources.release().catch(() => undefined);
      throw error;
    }
  }
}
