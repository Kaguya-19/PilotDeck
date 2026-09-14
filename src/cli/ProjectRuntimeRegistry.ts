import { join as joinPath, resolve } from "node:path";

import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import type {
  AgentRuntimeConfig,
  AgentLoopRuntimeFactory,
  CreateAgentSessionOptions,
} from "../agent/index.js";
import type { PilotDeckLoadedPlugin } from "../extension/index.js";
import {
  GatewaySessionPermissionRuleSetRegistry,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
  type ListSessionsInput,
  type ListSessionsResult,
  InProcessGateway,
  createGatewaySessionCatalogConsumer,
} from "../gateway/index.js";
import {
  GatewaySessionPermissionModeRegistry,
  type GatewaySessionPermissionModePort,
} from "../gateway/index.js";
import type { McpRuntimeFactory } from "../mcp/index.js";
import type {
  ModelInvocationProvider,
  ModelRuntime,
} from "../model/index.js";
import type { InteractionProfileName } from "../interaction/index.js";
import type { PilotProxyConfig } from "../pilot/index.js";
import type { PilotAgentModelSelection, PilotConfigSnapshot } from "../pilot/config/types.js";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_JUDGE_TIMEOUT_MS,
  DEFAULT_TRIGGER_TIERS,
  type RouterConfig,
} from "../router/config/schema.js";
import {
  createNativeRouterSessionStateProvider,
  type RouterSessionStatePort,
  type RouterSessionCustomRouterPort,
  type RouterProviderHealthPort,
  type RouterSessionStateProvider,
} from "../router/index.js";
import {
  type ProjectSessionPersistenceProvider,
  type SessionCatalogPort,
} from "../session/index.js";
import type {
  ExecutionWorldBundle,
  PilotDeckToolDefinition,
  PilotDeckUnavailableToolDiagnostic,
  SandboxMode,
} from "../tool/index.js";
import type { TelemetryClient } from "../telemetry/index.js";
import type { ProjectContextStorageBundleOptions } from "./ProjectContextStorageBundle.js";
import type { ProjectMemoryProviderFactory } from "./ProjectMemoryBundle.js";
import type { CompactionPort, PromptCacheCoordinatorPort } from "../context/index.js";
import type { SessionTitlePort } from "../session/index.js";
import type { LspServicePort } from "../lsp/index.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";
import {
  ProjectRuntimeResourcesBundle,
  type ProjectRuntimeResources,
} from "./ProjectRuntimeResourcesBundle.js";
import { ProjectSessionFactory } from "./ProjectSessionFactory.js";
import { ProjectRouterEventBusProvider } from "./ProjectRouterEventBusProvider.js";
import { BrowserUseSessionMcpSpecPreparer } from "./BrowserUseSessionMcpSpecPreparer.js";
import type { GatewaySubagentContinuations } from "./GatewaySubagentRuntimeBundle.js";

export type ProjectRuntime = ProjectRuntimeResources & {
  projectRoot: string;
  resourcesBundle: ProjectRuntimeResourcesBundle;
  runtimeState: "active" | "retired" | "disposed";
  sessionLeases: number;
  disposePromise?: Promise<void>;
  resolveSessionDrain?: () => void;
  unavailableTools?: PilotDeckUnavailableToolDiagnostic[];
  projectStorage: GatewayProjectStorageOptions;
};

export type ProjectRuntimeRegistryOptions = {
  fallbackProjectRoot: string;
  pilotHome: string;
  builtinSkillsRoot?: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  permissionTimeoutMs: number;
  elicitationTimeoutMs: number;
  now: () => Date;
  extraTools?: PilotDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  additionalWorkingDirectories?: string[];
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  modelInvocationProviderFactory?: (snapshot: PilotConfigSnapshot) => readonly ModelInvocationProvider[];
  executionWorldBundleFactory?: (input: {
    projectRoot: string;
    now: () => Date;
    sandboxMode: SandboxMode;
  }) => ExecutionWorldBundle;
  mcpRuntimeFactory?: McpRuntimeFactory;
  /** Application-selected context I/O providers for published project generations. */
  contextStorage?: ProjectContextStorageBundleOptions;
  /** Application-selected project memory provider for published generations. */
  memoryProviderFactory?: ProjectMemoryProviderFactory;
  /** Application-selected compaction provider for published generations. */
  compactionProviderFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    now: () => Date;
  }) => CompactionPort | undefined;
  /** Application-selected prompt-cache generation provider for published generations. */
  promptCacheCoordinatorFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    now: () => Date;
  }) => PromptCacheCoordinatorPort | undefined;
  /** Application-selected provider for session title generation. */
  sessionTitleProviderFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    modelRuntime: ModelRuntime;
    now: () => Date;
  }) => SessionTitlePort | undefined;
  /** Application-selected project-generation LSP capability provider. */
  lspServiceFactory?: (input: { projectRoot: string; now: () => Date }) => LspServicePort;
  /** Application-owned volatile routing state retained across generation reloads. */
  routerSessionState?: RouterSessionStateProvider;
  /** Application-selected per-generation session custom-router provider. */
  routerSessionCustomRouterFactory?: () => RouterSessionCustomRouterPort;
  /** Application-selected per-generation Router provider-health policy. */
  routerProviderHealthFactory?: (input: { now: () => number }) => RouterProviderHealthPort;
  builtinPlugins?: PilotDeckLoadedPlugin[];
  agentLoopFactory?: AgentLoopRuntimeFactory;
  testAgentLoopFactory?: CreateAgentSessionOptions["__agentLoopFactory"];
  interactionProfile?: InteractionProfileName;
  autoElicitation?: boolean;
  telemetry: TelemetryClient;
  sessionCatalog: SessionCatalogPort;
  storageProvider?: ProjectSessionPersistenceProvider;
  onProjectActivated?: (projectRoot: string) => void;
  continuations: GatewaySubagentContinuations;
  buildBrowserUseArgs(
    baseArgs: string[],
    outputDir: string,
    env: Record<string, string | undefined>,
    configProxy?: PilotProxyConfig,
  ): string[];
};

/**
 * Application-owned project generation registry. It is the sole owner of
 * generation publication, retirement and runtime/session leases; individual
 * resource providers remain owned by ProjectRuntimeResourcesBundle.
 */
export class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private reloadTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposePromise?: Promise<void>;
  private readonly runtimeDisposals = new Set<Promise<void>>();
  private gateway?: InProcessGateway;
  /** Exact session retains avoid leaking fallback permission state by key. */
  private readonly permissionRuleSets = new GatewaySessionPermissionRuleSetRegistry();
  private readonly permissionModes = new GatewaySessionPermissionModeRegistry();
  private readonly sessionFactory: ProjectSessionFactory<ProjectRuntime>;

  private _extraTools: PilotDeckToolDefinition[];
  private _sessionOverrides: SessionConfigOverrides | undefined;
  /** Shared only across Router generations; it is never durable Session state. */
  private readonly sharedSessionState: RouterSessionStatePort;
  private readonly ownsSharedSessionState: boolean;
  private readonly sessionCatalogConsumer: (input: ListSessionsInput) => Promise<ListSessionsResult>;
  private readonly routerEvents: ProjectRouterEventBusProvider;
  private readonly browserUseMcpSpecs: BrowserUseSessionMcpSpecPreparer;

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {
    this._extraTools = options.extraTools ? [...options.extraTools] : [];
    this._sessionOverrides = options.sessionOverrides;
    this.sharedSessionState = options.routerSessionState ?? createNativeRouterSessionStateProvider({
      now: () => options.now().getTime(),
    });
    this.ownsSharedSessionState = options.routerSessionState === undefined;
    this.sessionCatalogConsumer = createGatewaySessionCatalogConsumer({
      catalog: options.sessionCatalog,
      resolveStorage: (input) => this.resolve(input.projectKey).projectStorage,
    });
    this.routerEvents = new ProjectRouterEventBusProvider({
      pilotHome: options.pilotHome,
      onRetryProgress: (event) => this.gateway?.broadcastRetryProgress(event),
    });
    this.browserUseMcpSpecs = new BrowserUseSessionMcpSpecPreparer({
      env: options.env,
      buildArgs: options.buildBrowserUseArgs,
    });
    this.sessionFactory = new ProjectSessionFactory<ProjectRuntime>({
      resolveRuntime: (projectKey) => this.resolve(projectKey),
      acquireRuntimeLease: (runtime) => this.acquireRuntimeLease(runtime),
      acquirePermissionRuleSet: ({ sessionKey, permissionRules }) => this.permissionRuleSets.acquire(
        sessionKey,
        permissionRules,
      ),
      getSessionOverride: (sessionKey) => this._sessionOverrides?.get(sessionKey),
      getGateway: () => this.gateway,
      permissionMode: options.permissionMode,
      additionalWorkingDirectories: options.additionalWorkingDirectories,
      mcpRuntimeFactory: options.mcpRuntimeFactory,
      preparePerSessionSpecs: ({ runtime, context, specs }) => this.browserUseMcpSpecs.prepare({
        projectRoot: runtime.projectRoot,
        sessionKey: context.sessionKey,
        proxy: runtime.snapshot.config.proxy,
        specs,
      }),
      getAlwaysOnToolNames: () => this._extraTools
        .filter((tool) => tool.name.startsWith("always_on_"))
        .map((tool) => tool.name),
      permissionTimeoutMs: options.permissionTimeoutMs,
      elicitationTimeoutMs: options.elicitationTimeoutMs,
      pilotHome: options.pilotHome,
      env: options.env,
      now: options.now,
      continuations: options.continuations,
      agentLoopFactory: options.agentLoopFactory,
      testAgentLoopFactory: options.testAgentLoopFactory,
      shouldCollectFileArtifacts: (runtime) => resolve(runtime.projectRoot) !== resolve(options.pilotHome),
      onDiagnostic: (message, error) => {
        // eslint-disable-next-line no-console
        console.warn(`[pilotdeck] ${message}`, error instanceof Error ? error.message : error ?? "");
      },
    });
  }

  setGateway(gateway: InProcessGateway): void {
    this.gateway = gateway;
  }

  /** Gateway consumes this port; the registry keeps session rule ownership. */
  permissionGrantPort(): GatewaySessionPermissionRuleSetRegistry {
    return this.permissionRuleSets;
  }

  /** Gateway consumes this volatile host policy; it is never durable Session state. */
  permissionModePort(): GatewaySessionPermissionModePort {
    return this.permissionModes;
  }

  async disposeSessionMcpRuntimes(): Promise<void> {
    await this.sessionFactory.dispose();
  }

  disposeProjectRuntimes(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    this.disposed = true;
    this.disposePromise = this.reloadTail
      .catch(() => undefined)
      .then(async () => {
        const runtimes = [...this.runtimes.values()];
        this.runtimes.clear();
        try {
          await this.disposePublishedRuntimes(runtimes);
        } finally {
          this.permissionModes.dispose();
          if (this.ownsSharedSessionState) {
            (this.sharedSessionState as RouterSessionStateProvider).clear();
          }
        }
      });
    return this.disposePromise;
  }

  invalidate(projectRoot?: string): void {
    if (this.disposed) return;
    if (projectRoot) {
      const runtime = this.runtimes.get(projectRoot);
      if (runtime) this.retireRuntime(runtime);
      this.runtimes.delete(projectRoot);
      return;
    }
    for (const runtime of this.runtimes.values()) this.retireRuntime(runtime);
    this.runtimes.clear();
  }

  private acquireRuntimeLease(runtime: ProjectRuntime): () => Promise<void> {
    if (runtime.runtimeState !== "active") {
      throw new Error(`Project runtime is ${runtime.runtimeState}.`);
    }
    runtime.sessionLeases += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      runtime.sessionLeases -= 1;
      if (runtime.sessionLeases === 0) runtime.resolveSessionDrain?.();
      if (runtime.runtimeState === "retired" && runtime.sessionLeases === 0) {
        await this.trackRuntimeDispose(runtime);
      }
    };
  }

  private retireRuntime(runtime: ProjectRuntime): void {
    if (runtime.runtimeState !== "active") return;
    runtime.runtimeState = "retired";
    if (runtime.sessionLeases === 0) {
      void this.trackRuntimeDispose(runtime).catch((error) => {
        console.warn(`[pilotdeck] failed to dispose retired runtime for ${runtime.projectRoot}:`, error);
      });
    }
  }

  private trackRuntimeDispose(runtime: ProjectRuntime): Promise<void> {
    const disposal = this.disposeRuntime(runtime);
    this.runtimeDisposals.add(disposal);
    void disposal.then(
      () => this.runtimeDisposals.delete(disposal),
      () => this.runtimeDisposals.delete(disposal),
    );
    return disposal;
  }

  private disposeRuntime(runtime: ProjectRuntime): Promise<void> {
    if (runtime.disposePromise) return runtime.disposePromise;
    runtime.disposePromise = (async () => {
      try {
        await runtime.resourcesBundle.dispose();
      } finally {
        runtime.runtimeState = "disposed";
      }
    })();
    return runtime.disposePromise;
  }

  updateSubsystems(config: {
    extraTools: PilotDeckToolDefinition[];
    sessionOverrides?: SessionConfigOverrides;
  }): void {
    this._extraTools = config.extraTools;
    this._sessionOverrides = config.sessionOverrides;
    this.invalidate();
  }

  reload(): Promise<void> {
    this.assertActive();
    const queued = this.reloadTail
      .catch(() => undefined)
      .then(() => this.performReload());
    this.reloadTail = queued;
    return queued;
  }

  private async performReload(): Promise<void> {
    this.assertActive();
    const current = [...this.runtimes.entries()];
    const staged = new Map<string, ProjectRuntime>();
    let disposePartialBuild: (() => Promise<void>) | undefined;
    try {
      for (const [projectRoot] of current) {
        staged.set(projectRoot, this.buildRuntime(projectRoot, {
          onFailure: (dispose) => { disposePartialBuild = dispose; },
        }));
      }
    } catch (error) {
      const cleanupResults = await Promise.allSettled([
        ...(disposePartialBuild ? [disposePartialBuild()] : []),
        ...[...staged.values()].map(async (runtime) => {
          runtime.runtimeState = "retired";
          await this.disposeRuntime(runtime);
        }),
      ]);
      const cleanupFailures = cleanupResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Failed to stage and clean up project runtime reload.");
      }
      throw error;
    }
    for (const [projectRoot, runtime] of staged) this.runtimes.set(projectRoot, runtime);
    for (const [, runtime] of current) this.retireRuntime(runtime);
  }

  setSessionCwd(sessionKey: string, cwd: string): void {
    if (!this._sessionOverrides) return;
    const existing = this._sessionOverrides.get(sessionKey);
    this._sessionOverrides.set(sessionKey, { ...existing, cwd });
  }

  resolve(projectKey?: string): ProjectRuntime {
    this.assertActive();
    const projectRoot = resolve(projectKey ?? this.options.fallbackProjectRoot);
    this.options.onProjectActivated?.(projectRoot);
    const cached = this.runtimes.get(projectRoot);
    if (cached) return cached;

    const runtime = this.buildRuntime(projectRoot);
    this.runtimes.set(projectRoot, runtime);
    return runtime;
  }

  private async disposePublishedRuntimes(runtimes: readonly ProjectRuntime[]): Promise<void> {
    const failures: unknown[] = [];
    for (const runtime of runtimes) {
      if (runtime.runtimeState === "active") runtime.runtimeState = "retired";
      if (runtime.sessionLeases > 0 || runtime.runtimeState === "disposed") continue;
      try {
        await this.trackRuntimeDispose(runtime);
      } catch (error) {
        failures.push(error);
      }
    }
    while (this.runtimeDisposals.size > 0) {
      const results = await Promise.allSettled([...this.runtimeDisposals]);
      failures.push(...results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to dispose project runtime generations.");
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Project runtime registry is disposed.");
  }

  private buildRuntime(
    projectRoot: string,
    options: { onFailure?: (dispose: () => Promise<void>) => void } = {},
  ): ProjectRuntime {
    const bundle = new ProjectRuntimeResourcesBundle({
      projectRoot,
      pilotHome: this.options.pilotHome,
      builtinSkillsRoot: this.options.builtinSkillsRoot,
      env: this.options.env,
      now: this.options.now,
      telemetry: this.options.telemetry,
      extraTools: this._extraTools,
      builtinPlugins: this.options.builtinPlugins ?? loadBuiltinPlugins(),
      modelFactory: this.options.modelFactory,
      modelInvocationProviderFactory: this.options.modelInvocationProviderFactory,
      executionWorldBundleFactory: this.options.executionWorldBundleFactory,
      mcpRuntimeFactory: this.options.mcpRuntimeFactory,
      contextStorage: this.options.contextStorage,
      memoryProviderFactory: this.options.memoryProviderFactory,
      compactionProviderFactory: this.options.compactionProviderFactory,
      promptCacheCoordinatorFactory: this.options.promptCacheCoordinatorFactory,
      sessionTitleProviderFactory: this.options.sessionTitleProviderFactory,
      lspServiceFactory: this.options.lspServiceFactory,
      routerSessionCustomRouterFactory: this.options.routerSessionCustomRouterFactory,
      routerProviderHealthFactory: this.options.routerProviderHealthFactory,
      runtimeProfileOverrides: {
        interactionProfileOverride: this.options.interactionProfile,
        autoElicitation: this.options.autoElicitation,
      },
      createRouterConfig: (snapshot) =>
        ensureRouterConfig(snapshot.config.router, snapshot.config.agent.model),
      createRouterEventBus: () => this.routerEvents.create(),
      routerSessionState: this.sharedSessionState,
      onDiagnostic: (message, error) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[pilotdeck] ${message} for project ${projectRoot}:`,
          error instanceof Error ? error.message : error ?? "",
        );
      },
    });
    try {
      const resources = bundle.stage();
      return {
        projectRoot,
        runtimeState: "active",
        sessionLeases: 0,
        resourcesBundle: bundle,
        projectStorage: {
          projectRoot,
          pilotHome: this.options.pilotHome,
          storageProvider: this.options.storageProvider,
        },
        ...resources,
      };
    } catch (error) {
      const dispose = () => bundle.dispose();
      if (options.onFailure) {
        options.onFailure(dispose);
      } else {
        void dispose().catch((cleanupError) => {
          console.warn(`[pilotdeck] failed to clean up incomplete project runtime for ${projectRoot}:`, cleanupError);
        });
      }
      throw error;
    }
  }

  async createSession(context: GatewaySessionContext) {
    return this.sessionFactory.createSession(context);
  }

  async recreateSession(context: GatewaySessionContext, previousSession: import("../agent/index.js").AgentSession) {
    return this.sessionFactory.recreateSession(context, previousSession);
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return this.sessionCatalogConsumer(input);
  }
}

function ensureRouterConfig(
  router: RouterConfig | undefined,
  defaultSelection: PilotAgentModelSelection,
): RouterConfig {
  const defaultRef = { id: defaultSelection.id, provider: defaultSelection.provider, model: defaultSelection.model };
  if (router?.enabled === false) return { enabled: false };
  if (router) {
    return {
      enabled: true,
      ...router,
      scenarios: router.scenarios ?? { default: defaultRef },
      fallback: router.fallback ?? { default: [defaultRef] },
      tokenSaver: router.tokenSaver ?? buildDefaultTokenSaver(defaultRef),
      autoOrchestrate: router.autoOrchestrate ?? buildDefaultAutoOrchestrate(),
      stats: { enabled: true, baselineModel: defaultRef, ...(router.stats ?? {}) },
    };
  }
  return {
    enabled: true,
    scenarios: { default: defaultRef },
    fallback: { default: [defaultRef] },
    zeroUsageRetry: { enabled: true, maxAttempts: 2 },
    tokenSaver: buildDefaultTokenSaver(defaultRef),
    autoOrchestrate: buildDefaultAutoOrchestrate(),
    stats: { enabled: true, baselineModel: defaultRef },
  };
}

function buildDefaultTokenSaver(defaultRef: { id: string; provider: string; model: string }) {
  return {
    enabled: true,
    judge: defaultRef,
    defaultTier: "medium",
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
    tiers: {
      simple: { model: defaultRef },
      medium: { model: defaultRef },
      complex: { model: defaultRef },
      reasoning: { model: defaultRef },
    },
  };
}

function buildDefaultAutoOrchestrate() {
  return {
    enabled: true,
    triggerTiers: [...DEFAULT_TRIGGER_TIERS],
    slimSystemPrompt: true,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  };
}
