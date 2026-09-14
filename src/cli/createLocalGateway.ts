import { randomUUID } from "node:crypto";
import { resolve, join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import type { AlwaysOnControlPort } from "../always-on/protocol/AlwaysOnControlPort.js";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentLoopRuntimeFactory,
  type AgentLoopSeedState,
  type AgentLoopRunner,
  type AgentLoopSidecarTransportObserver,
} from "../agent/index.js";
import {
  createNodeAttachmentPort,
  type CompactionPort,
  type PromptCacheCoordinatorPort,
  type AttachmentPort,
} from "../context/index.js";
import type { PilotDeckLoadedPlugin } from "../extension/index.js";
import {
  InProcessGateway,
  SessionRouter,
  GatewayAgentEventProjector,
  GatewayAgentEventTelemetryObserver,
  GatewayToolResultArtifactStore,
  GatewayManualCompactionCoordinator,
  GatewayTurnReplayStore,
  GatewayTurnTelemetryContextResolver,
  isGatewayMemoryDiagnosticsEnabled,
  logGatewayMemoryDiagnostic,
  summarizeCanonicalMessages,
  type Gateway,
  type GatewayCronController,
  type GatewayToolResultArtifactStorePort,
} from "../gateway/index.js";
import type { UploadLifecyclePort } from "../gateway/dialog/UploadLifecyclePort.js";
import {
  type McpRuntimeFactory,
} from "../mcp/index.js";
import {
  NativeSessionModelSelectionPolicy,
  NativeSessionModelSelectionPort,
  type ModelRuntime,
  type ModelInvocationProvider,
} from "../model/index.js";
import {
  type InteractionProfileName,
} from "../interaction/index.js";
import type { RouterSessionStateProvider } from "../router/index.js";
import type { RouterSessionCustomRouterPort } from "../router/index.js";
import type { RouterProviderHealthPort } from "../router/index.js";
import type { LspServicePort } from "../lsp/index.js";
import { type PilotProxyConfig } from "../pilot/index.js";
import { createPilotConfigStoreSync, type PilotConfigStore } from "../pilot/config/PilotConfigStore.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import {
  createProjectSessionDataPlane,
  ProjectSessionWriteCoordinator,
  type ProjectSessionDataPlane,
  type ProjectSessionForkPort,
  type ProjectSessionPersistenceProvider,
  type ProjectSessionReplacementPort,
  type ProjectSessionStorageProvider,
  type SessionCatalogPort,
  type SessionSearchPort,
  type SessionTitlePort,
} from "../session/index.js";
import {
  type ExecutionWorldBundle,
  type SandboxMode,
} from "../tool/index.js";
import type {
  PilotDeckToolDefinition,
} from "../tool/index.js";
import { SkillManager, migrateLegacyBundledSkillCopies } from "../extension/skills/index.js";
import { getPilotDeckInstallCommand } from "../mcp/runtime/projectMcpSpec.js";
import { ExtensionWatchManager, type ExtensionWatchEvent } from "./ExtensionWatchManager.js";
import {
  type TelemetryClient,
  type TelemetryObserverRegistry,
} from "../telemetry/index.js";
import { LocalGatewayBootResources } from "./LocalGatewayBootResources.js";
import { readPositiveIntegerEnv, resolveLocalGatewayBootConfig } from "./LocalGatewayBootConfig.js";
import {
  createAgentLoopDeploymentFactory,
  resolveAgentLoopDeploymentProfile,
} from "./AgentLoopDeploymentProfile.js";
import { GatewaySessionModelBundle } from "./GatewaySessionModelBundle.js";
import { GatewaySessionHistoryBundle } from "./GatewaySessionHistoryBundle.js";
import { GatewayDialogBundle } from "./GatewayDialogBundle.js";
import type { ProjectContextStorageBundleOptions } from "./ProjectContextStorageBundle.js";
import type { ProjectMemoryProviderFactory } from "./ProjectMemoryBundle.js";
import { GatewayCommandCatalogBundle } from "./GatewayCommandCatalogBundle.js";
import { GatewayRuntimeRefreshBundle } from "./GatewayRuntimeRefreshBundle.js";
import { GatewayTelemetryBundle } from "./GatewayTelemetryBundle.js";
import { ProjectMemoryMaintenanceController } from "./ProjectMemoryMaintenanceController.js";
import { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.js";
import {
  GatewaySubagentRuntimeBundle,
  type GatewaySubagentContinuations,
} from "./GatewaySubagentRuntimeBundle.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  pilotHome?: string;
  /** Read-only skills shipped with this PilotDeck build. Auto-discovered when omitted. */
  builtinSkillsRoot?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
  /** Maximum time an interactive permission request may wait for a host answer. */
  permissionTimeoutMs?: number;
  /** Maximum time an interactive question may wait for a host answer. */
  elicitationTimeoutMs?: number;
  /**
   * Explicit provider profile for approval and user-question interaction.
   * Takes precedence over the project config; `autoElicitation` remains a
   * compatibility alias for `headless` when this option is omitted.
   */
  interactionProfile?: InteractionProfileName;
  /** Tools merged into every per-project ToolRegistry. */
  extraTools?: PilotDeckToolDefinition[];
  /** Per-sessionKey config overrides (cwd / permissionMode). */
  sessionOverrides?: SessionConfigOverrides;
  /** Optional Cron runtime controller exposed through Gateway management methods. */
  cron?: GatewayCronController;
  /**
   * Additional directories the agent is allowed to read/write outside of `projectRoot`.
   * Passed to PermissionContext so `pathSafety` accepts paths within these roots.
   */
  additionalWorkingDirectories?: string[];
  /**
   * @internal Testing hook — replaces the production `createModelRuntime`
   * call when present. Tests can return a fake `ModelRuntime` (e.g. a scripted
   * stream) so the rest of the wiring (Router, Tools, Context, AgentLoop) runs
   * end-to-end against a deterministic transport. NOT part of the public API.
   */
  __testModelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  /** Application-selected model invocation providers for each project generation. */
  modelInvocationProviderFactory?: (snapshot: PilotConfigSnapshot) => readonly ModelInvocationProvider[];
  /** Application-selected project execution-world provider. */
  executionWorldBundleFactory?: (input: {
    projectRoot: string;
    now: () => Date;
    sandboxMode: SandboxMode;
  }) => ExecutionWorldBundle;
  /** Application-selected MCP runtime provider factory. */
  mcpRuntimeFactory?: McpRuntimeFactory;
  /** Application-selected context I/O providers for each project generation. */
  contextStorage?: ProjectContextStorageBundleOptions;
  /** Application-selected project memory provider for each project generation. */
  memoryProviderFactory?: ProjectMemoryProviderFactory;
  /** Application-selected compaction provider for each project generation. */
  compactionProviderFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    now: () => Date;
  }) => CompactionPort | undefined;
  /** Application-selected prompt-cache generation provider for each project generation. */
  promptCacheCoordinatorFactory?: (input: {
    projectRoot: string;
    snapshot: PilotConfigSnapshot;
    now: () => Date;
  }) => PromptCacheCoordinatorPort | undefined;
  /** Application-selected session-title provider for each project generation. */
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
  /** Application-selected frozen builtin plugin contribution set. */
  builtinPlugins?: PilotDeckLoadedPlugin[];
  /** @deprecated Use `modelInvocationProviderFactory`. */
  __testModelInvocationProviderFactory?: (snapshot: PilotConfigSnapshot) => readonly ModelInvocationProvider[];
  /** @deprecated Use `executionWorldBundleFactory`. */
  __testExecutionWorldBundleFactory?: (input: {
    projectRoot: string;
    now: () => Date;
    sandboxMode: SandboxMode;
  }) => ExecutionWorldBundle;
  /** @deprecated Use `mcpRuntimeFactory`. */
  __testMcpRuntimeFactory?: McpRuntimeFactory;
  /** @deprecated Use `contextStorage`. */
  __testContextStorage?: ProjectContextStorageBundleOptions;
  /** @deprecated Use `builtinPlugins`. */
  __testBuiltinPlugins?: PilotDeckLoadedPlugin[];
  /**
   * Application-selected external AgentLoop runtime. It receives the
   * capability-only contract required by a sidecar or other provider.
   */
  agentLoopFactory?: AgentLoopRuntimeFactory;
  /** Optional live observer for the selected stdio/TCP AgentLoop deployment. */
  agentLoopTransportObserver?: AgentLoopSidecarTransportObserver;
  /** @internal Test hook for exercising the complete Gateway with an external AgentLoop transport. */
  __testAgentLoopFactory?: (input: {
    config: AgentRuntimeConfig;
    dependencies: AgentRuntimeDependencies;
    seedState?: AgentLoopSeedState;
  }) => AgentLoopRunner;
  /** @internal Test hook for asserting rollback after both filesystem watchers are active. */
  __testFailAfterBootstrapWatchers?: () => void;
  /**
   * Fallback project root used as the agent cwd when no explicit
   * `projectKey` is provided (e.g. IM channels without a bound project).
   * Defaults to `projectRoot` when omitted; server mode should set this
   * to `pilotHome` so IM sessions land in the general workspace instead
   * of the gateway process's cwd.
   */
  fallbackProjectRoot?: string;
  /** @deprecated Use `interactionProfile: "headless"`. */
  autoElicitation?: boolean;
  telemetry?: TelemetryClient;
  /**
   * Read-only durable-session query provider. The local Gateway selects the
   * JSONL provider when omitted; callers may supply a compatible catalog.
   */
  sessionCatalog?: SessionCatalogPort;
  sessionForkPort?: ProjectSessionForkPort;
  sessionReplacementPort?: ProjectSessionReplacementPort;
  sessionSearch?: SessionSearchPort;
  /** Application-owned session data plane, resolved once before consumer composition. */
  sessionDataPlane?: ProjectSessionDataPlane;
  /** Application-selected backend for project-session events and projection caches. */
  persistenceProvider?: ProjectSessionPersistenceProvider;
  /** @deprecated Use persistenceProvider and independent session ports. */
  storageProvider?: ProjectSessionStorageProvider;
  /**
   * Application-selected attachment I/O provider for Gateway turn composition.
   * The provider only reads declared attachment paths; AttachmentResolver keeps
   * MIME, size, and model-visible projection policy.
   */
  attachmentPort?: AttachmentPort;
  /**
   * Application-selected upload lifecycle provider for browser artifacts.
   * The provider owns upload admission, retention, cleanup, and attachment
   * leases; Gateway only consumes the resolved lease projection.
   */
  uploadLifecycle?: UploadLifecyclePort;
  /**
   * Application-selected advisory store for large Gateway tool-result previews.
   * It participates only in live event projection and never replaces the
   * Session transcript or turn terminal owner.
   */
  toolResultArtifactStore?: GatewayToolResultArtifactStorePort;
};

export type SubsystemUpdate = {
  extraTools: PilotDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  cron?: GatewayCronController;
  alwaysOnControl?: AlwaysOnControlPort;
};

export type CreateLocalGatewayResult = {
  gateway: Gateway;
  configStore: PilotConfigStore;
  registry: ProjectRuntimeRegistry;
  /** Application-owned registration point for live, non-durable telemetry observers. */
  telemetryObservers: TelemetryObserverRegistry;
  sessionDataPlane: ProjectSessionDataPlane;
  dispose: () => void | Promise<void>;
  bindServer: (server: { broadcastNotification(name: string, payload?: unknown): void }) => void;
  /**
   * Returns true when at least one interactive (non-background) turn is
   * in flight for `projectKey`.  Used by AlwaysOnManager to feed the
   * `agent_busy` gate with real session data.
   */
  isProjectBusy: (projectKey: string) => boolean;
  /**
   * Replace subsystem-owned tools, session overrides, and cron controller.
   * Called by the server command after tearing down and rebuilding
   * AlwaysOnManager / CronManager in response to a config change.
   */
  updateSubsystems: (update: SubsystemUpdate) => void;
};

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): CreateLocalGatewayResult {
  const bootConfig = resolveLocalGatewayBootConfig(options);
  const {
    env,
    projectRoot,
    pilotHome,
    builtinSkillsRoot,
    fallbackProjectRoot,
    permissionMode,
    permissionTimeoutMs,
    elicitationTimeoutMs,
  } = bootConfig;
  const agentLoopFactory = options.agentLoopFactory ?? createAgentLoopDeploymentFactory(
    resolveAgentLoopDeploymentProfile({ env, cwd: projectRoot }),
    { transportObserver: options.agentLoopTransportObserver },
  );
  const sessionDataPlane = options.sessionDataPlane ?? createProjectSessionDataPlane({
    ...(options.persistenceProvider ? { persistenceProvider: options.persistenceProvider } : {}),
    ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
    ...(options.sessionCatalog ? { catalog: options.sessionCatalog } : {}),
    ...(options.sessionForkPort ? { fork: options.sessionForkPort } : {}),
    ...(options.sessionReplacementPort ? { replacement: options.sessionReplacementPort } : {}),
    ...(options.sessionSearch ? { search: options.sessionSearch } : {}),
  });
  const replacementTransactionOwner = { instanceId: randomUUID(), pid: process.pid };
  const replacementRecovery = sessionDataPlane.replacement.recover({ pilotHome });
  if (replacementRecovery.committed > 0 || replacementRecovery.rolledBack > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[pilotdeck] Recovered last-turn replacements: committed=${replacementRecovery.committed} ` +
      `rolledBack=${replacementRecovery.rolledBack}.`,
    );
  }
  for (const failure of replacementRecovery.failures) {
    // Keep the backup/journal in place so a later startup can retry safely.
    // eslint-disable-next-line no-console
    console.warn(
      `[pilotdeck] Could not recover replacement transaction for ${failure.scope}: ${failure.message}`,
    );
  }
  const legacySkillMigration = migrateLegacyBundledSkillCopies({ pilotHome, builtinSkillsRoot });
  if (legacySkillMigration.migrated.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[pilotdeck] Activated bundled skills directly; moved ${legacySkillMigration.migrated.length} ` +
      `unchanged legacy ${legacySkillMigration.migrated.length === 1 ? "copy" : "copies"} to ` +
      `${joinPath(pilotHome, "skill-backups", "legacy-bundled-v1")}.`,
    );
  }
  for (const failure of legacySkillMigration.failures) {
    // eslint-disable-next-line no-console
    console.warn(`[pilotdeck] Could not migrate legacy skill '${failure.slug}': ${failure.message}`);
  }
  const now = () => new Date();
  const sessionCatalog = sessionDataPlane.catalog;
  const telemetryBundle = new GatewayTelemetryBundle({
    env,
    pilotHome,
    telemetry: options.telemetry,
  });
  const telemetryObservers = telemetryBundle.observers;
  const telemetry = telemetryBundle.client;
  const bootResources = new LocalGatewayBootResources({
    warn: (message, error) => console.warn(message, error),
  });
  bootResources.ownTelemetry(telemetryBundle);
  try {
  const attachmentPort = options.attachmentPort ?? createNodeAttachmentPort();
  const subagentRuntime = new GatewaySubagentRuntimeBundle({
    onCleanupError: (error) => {
      console.warn("[pilotdeck] failed to clean up continuable subagent resources:", error);
    },
  });
  bootResources.ownSubagentRuntime(subagentRuntime);
  const liveAgents = subagentRuntime.agents;
  const continuations: GatewaySubagentContinuations = subagentRuntime.continuations;
  let registry!: ProjectRuntimeRegistry;
  let router: SessionRouter | undefined;
  const extensionWatchManager = new ExtensionWatchManager({
    pilotHome,
    builtinSkillsRoot,
    onChange: (event) => {
      handleExtensionWatchEvent(event, registry, router);
    },
    onError: (scope, error) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[pilotdeck] Extension watcher failed for ${describeExtensionScope(scope)}:`,
        error.message,
      );
    },
  });
  registry = new ProjectRuntimeRegistry({
    fallbackProjectRoot,
    pilotHome,
    builtinSkillsRoot,
    env,
    permissionMode,
    permissionTimeoutMs,
    elicitationTimeoutMs,
    now,
    extraTools: options.extraTools,
    sessionOverrides: options.sessionOverrides,
    additionalWorkingDirectories: options.additionalWorkingDirectories,
    modelFactory: options.__testModelFactory,
    modelInvocationProviderFactory:
      options.modelInvocationProviderFactory ?? options.__testModelInvocationProviderFactory,
    executionWorldBundleFactory: options.executionWorldBundleFactory ?? options.__testExecutionWorldBundleFactory,
    mcpRuntimeFactory: options.mcpRuntimeFactory ?? options.__testMcpRuntimeFactory,
    contextStorage: options.contextStorage ?? options.__testContextStorage,
    memoryProviderFactory: options.memoryProviderFactory,
    compactionProviderFactory: options.compactionProviderFactory,
    promptCacheCoordinatorFactory: options.promptCacheCoordinatorFactory,
    sessionTitleProviderFactory: options.sessionTitleProviderFactory,
    lspServiceFactory: options.lspServiceFactory,
    routerSessionState: options.routerSessionState,
    routerSessionCustomRouterFactory: options.routerSessionCustomRouterFactory,
    routerProviderHealthFactory: options.routerProviderHealthFactory,
    builtinPlugins: options.builtinPlugins ?? options.__testBuiltinPlugins,
    agentLoopFactory,
    testAgentLoopFactory: options.__testAgentLoopFactory,
    interactionProfile: options.interactionProfile,
    autoElicitation: options.autoElicitation,
    telemetry,
    sessionCatalog,
    storageProvider: sessionDataPlane.persistence,
    continuations,
    buildBrowserUseArgs,
    onProjectActivated: (activeProjectRoot) => extensionWatchManager.watchProject(activeProjectRoot),
  });
  bootResources.ownRegistry(registry);
  const defaultRuntime = registry.resolve();
  const memoryDiagnosticsEnabled = isGatewayMemoryDiagnosticsEnabled(
    env,
    defaultRuntime.snapshot.config.gateway?.memoryDiagnostics,
  );

  const configStore = createPilotConfigStoreSync({ projectRoot, env });
  const stopConfigWatching = configStore.startWatching();
  bootResources.ownConfigWatcher(stopConfigWatching);
  const stopExtensionWatching = extensionWatchManager.start();
  bootResources.ownExtensionWatcher(stopExtensionWatching);
  const runtimeRefresh = new GatewayRuntimeRefreshBundle({
    configStore,
    registry,
    memoryMaintenance: new ProjectMemoryMaintenanceController({
      resolveRuntime: (projectKey) => registry.resolve(projectKey),
      telemetry,
    }),
    getRouter: () => router,
    projectRoot,
    memoryDiagnosticsEnabled,
    logMemoryDiagnostic: (input) => logGatewayMemoryDiagnostic(input as Parameters<typeof logGatewayMemoryDiagnostic>[0]),
    summarizeMessages: (messages) => summarizeCanonicalMessages(messages as import("../model/index.js").CanonicalMessage[]),
  });
  runtimeRefresh.attach();
  bootResources.ownRuntimeRefresh(runtimeRefresh);
  options.__testFailAfterBootstrapWatchers?.();

  router = new SessionRouter({
    agents: liveAgents,
    createSession: (ctx) => registry.createSession(ctx),
    recreateSession: (ctx, session) => registry.recreateSession(ctx, session),
    listSessions: (input) => registry.listSessions(input),
    idleSessionTimeoutMs:
      (defaultRuntime.snapshot.config.gateway?.idleSessionTimeoutMinutes ?? 30) * 60_000,
    idleSweepIntervalMs:
      Math.max(0, defaultRuntime.snapshot.config.gateway?.idleSweepIntervalSeconds ?? 60) * 1_000,
    now,
    onSessionIdleEvict: memoryDiagnosticsEnabled
      ? (_sessionKey, snapshot) => {
          logGatewayMemoryDiagnostic({
            event: "session_idle_evicted",
            sessionCount: router?.cachedSessionCount(),
            session: {
              sessionKey: snapshot.sessionKey,
              projectKey: snapshot.context.projectKey,
              messageCount: snapshot.messageCount,
            },
          });
        }
      : undefined,
    onSessionEvict: (sessionKey) => registry.permissionModePort().clear(sessionKey),
  });
  bootResources.ownRouter(router);
  const skillManager = new SkillManager({ pilotHome, builtinSkillsRoot });
  const dialog = new GatewayDialogBundle({
    pilotHome,
    sessionCatalog,
    attachmentPort,
    uploadLifecycle: options.uploadLifecycle,
  });
  const sessionWriteCoordinator = new ProjectSessionWriteCoordinator();
  const sessionModels = new GatewaySessionModelBundle({
    fallbackProjectKey: fallbackProjectRoot,
    resolveProjectKey: dialog.projects.resolveProjectKey,
    router: router!,
    selectionPort: new NativeSessionModelSelectionPort({
      pilotHome,
      now,
      storageProvider: sessionDataPlane.persistence,
      writeCoordinator: sessionWriteCoordinator,
    }),
    policy: new NativeSessionModelSelectionPolicy(env),
  });
  const sessionHistory = new GatewaySessionHistoryBundle({
    fallbackProjectRoot,
    pilotHome,
    sessionCatalog,
    now,
    maxContextTokens: defaultRuntime.snapshot.config.agent.maxContextTokens,
    maxOutputTokens: defaultRuntime.snapshot.config.agent.maxOutputTokens,
    transactionOwner: replacementTransactionOwner,
    storageProvider: sessionDataPlane.persistence,
    sessionForkPort: sessionDataPlane.fork,
    sessionReplacementPort: sessionDataPlane.replacement,
    writeCoordinator: sessionWriteCoordinator,
  });
  const commandCatalog = new GatewayCommandCatalogBundle({
    pilotHome,
    resolveProjectKey: dialog.projects.resolveProjectKey,
    resolveRuntime: (projectKey) => registry.resolve(projectKey),
  });
  const toolResultArtifacts = options.toolResultArtifactStore ?? new GatewayToolResultArtifactStore({
    rootDir: resolve(tmpdir(), "pilotdeck-tool-output", process.pid.toString()),
  });
  const agentEventProjector = new GatewayAgentEventProjector({ toolResultArtifacts });
  const agentEventTelemetryObserver = new GatewayAgentEventTelemetryObserver({ telemetry });
  const turnReplayStore = new GatewayTurnReplayStore();
  const turnTelemetryContextResolver = new GatewayTurnTelemetryContextResolver();
  const manualCompactionCoordinator = new GatewayManualCompactionCoordinator({ router });
  const gateway = new InProcessGateway(router, {
    funasrInstallCommand: getPilotDeckInstallCommand(),
    attachmentTurnComposer: dialog.attachmentTurnComposer,
    now,
    serverInfo: { mode: "in_process", projectKey: projectRoot },
    telemetry,
    permissionGrants: registry.permissionGrantPort(),
    permissionModes: registry.permissionModePort(),
    toolResultArtifacts,
    agentEventProjector,
    agentEventTelemetryObserver,
    turnReplayStore,
    turnTelemetryContextResolver,
    manualCompactionCoordinator,
    cron: options.cron,
    skillManager,
    commandsList: (input) => commandCatalog.commandsList(input),
    modelCatalogList: (input) => sessionModels.modelCatalogList(input),
    sessionModelGet: (input) => sessionModels.sessionModelGet(input),
    sessionModelSet: (input) => sessionModels.sessionModelSet(input),
    sessionModelClear: (input) => sessionModels.sessionModelClear(input),
    resolveTurnModelSelection: (input) => sessionModels.resolveTurnModelSelection(input),
    resolveUploadedAttachments: (input) => dialog.uploadedAttachments.resolve(input),
    setSessionCwd: (sessionKey, cwd) => registry.setSessionCwd(sessionKey, cwd),
    readSessionMessages: (input) => sessionHistory.readSessionMessages(input),
    readSubagentMessages: (input) => sessionHistory.readSubagentMessages(input),
    forkSession: (input) => sessionHistory.forkSession(input),
    replaceLastTurn: (input) => sessionHistory.replaceLastTurn(input),
    finalizeLastTurnReplacement: (input) => sessionHistory.finalizeLastTurnReplacement(input),
    recordAgentStatusMessage: (input) => sessionHistory.recordAgentStatusMessage(input),
    listProjects: dialog.listProjects,
    describeProject: dialog.describeProject,
    reloadConfig: () => runtimeRefresh.reloadConfig(),
    reloadExtensions: (input) => runtimeRefresh.reloadExtensions(input),
    // Defensive: re-check the on-disk config at the start of every
    // turn so an apiKey/url edit applied between two messages takes
    // effect on the next one, even if the fs watcher missed it.
    // Singleton-deduped inside PilotConfigStore.reload — concurrent
    // turns share a single in-flight read, and unchanged config is a
    // no-op (no invalidation, no session recreation).
    refreshConfigBeforeTurn: () => runtimeRefresh.refreshConfigBeforeTurn(),
    afterTurnCompleted: (input) => runtimeRefresh.afterTurnCompleted(input),
  });
  // Hand the gateway back to the registry so per-session creation can
  // build a `GatewayElicitationChannel` against this gateway's bus +
  // emit-sink (B1).
  registry.setGateway(gateway);
  const lifecycle = bootResources.commit({ gateway });
  return {
    gateway,
    configStore,
    registry,
    sessionDataPlane,
    telemetryObservers,
    dispose: () => lifecycle.dispose(),
    bindServer: (server) => runtimeRefresh.bindServer(server),
    isProjectBusy: (projectKey: string) => router!.hasActiveUserTurn(projectKey),
    updateSubsystems: (update: SubsystemUpdate) => {
      registry.updateSubsystems({
        extraTools: update.extraTools,
        sessionOverrides: update.sessionOverrides,
      });
      gateway.setCronController(update.cron);
      gateway.setAlwaysOnControl(update.alwaysOnControl);
    },
  };
  } catch (error) {
    void bootResources.rollback().catch((rollbackError) => {
      console.warn("[pilotdeck] failed to roll back local Gateway bootstrap:", rollbackError);
    });
    throw error;
  }
}

const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = 90_000;

function handleExtensionWatchEvent(
  event: ExtensionWatchEvent,
  registry: ProjectRuntimeRegistry,
  router: SessionRouter | undefined,
): void {
  const changed = event.changedPaths.join(", ");
  if (event.scope.kind === "global") {
    // eslint-disable-next-line no-console
    console.log("[pilotdeck] Extensions changed, invalidating all runtimes:", changed);
    registry.invalidate();
    router?.markAllDirty("extension_changed");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[pilotdeck] Extensions changed for project ${event.scope.projectRoot}, invalidating runtime:`,
    changed,
  );
  registry.invalidate(event.scope.projectRoot);
  router?.markProjectDirty(event.scope.projectRoot, "extension_changed");
}

function describeExtensionScope(scope: ExtensionWatchEvent["scope"]): string {
  return scope.kind === "global" ? "global extensions" : `project extensions (${scope.projectRoot})`;
}

export function buildBrowserUseArgs(
  baseArgs: string[],
  outputDir: string,
  env: Record<string, string | undefined>,
  configProxy?: PilotProxyConfig,
): string[] {
  let args = [...baseArgs];
  args = appendCliArg(args, "--output-dir", outputDir);
  args = appendCliArg(
    args,
    "--timeout-action",
    String(
      readPositiveIntegerEnv(env.PILOTDECK_BROWSER_TIMEOUT_ACTION_MS)
        ?? readPositiveIntegerEnv(env.PILOTDECK_BROWSER_ACTION_TIMEOUT_MS)
        ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    ),
  );
  args = appendCliArg(
    args,
    "--timeout-navigation",
    String(
      readPositiveIntegerEnv(env.PILOTDECK_BROWSER_TIMEOUT_NAVIGATION_MS)
        ?? readPositiveIntegerEnv(env.PILOTDECK_BROWSER_NAVIGATION_TIMEOUT_MS)
        ?? DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS,
    ),
  );

  const proxy = resolveBrowserProxyServer(env, configProxy);
  if (proxy) {
    args = appendCliArg(args, "--proxy-server", proxy.server);
    const proxyBypass = resolveBrowserProxyBypass(env, configProxy, proxy.source);
    if (proxyBypass) {
      args = appendCliArg(args, "--proxy-bypass", proxyBypass);
    }
  }
  return args;
}

function appendCliArg(args: string[], flag: string, value: string): string[] {
  if (args.includes(flag) || args.some((arg) => arg.startsWith(`${flag}=`))) {
    return args;
  }
  return [...args, flag, value];
}

type BrowserProxySource = "browser-env" | "env" | "config";

function resolveBrowserProxyServer(
  env: Record<string, string | undefined>,
  configProxy?: PilotProxyConfig,
): { server: string; source: BrowserProxySource } | undefined {
  const explicit = cleanEnvValue(env.PILOTDECK_BROWSER_PROXY_SERVER);
  if (explicit) {
    if (/^(0|false|off|none|direct)$/i.test(explicit)) return undefined;
    return { server: explicit, source: "browser-env" };
  }
  if (/^(1|true|on|yes)$/i.test(cleanEnvValue(env.PILOTDECK_BROWSER_PROXY_FROM_ENV) ?? "")) {
    const envProxy = (
      cleanEnvValue(env.PILOTDECK_PROXY)
      ?? cleanEnvValue(env.https_proxy)
      ?? cleanEnvValue(env.HTTPS_PROXY)
      ?? cleanEnvValue(env.http_proxy)
      ?? cleanEnvValue(env.HTTP_PROXY)
    );
    if (envProxy) return { server: envProxy, source: "env" };
  }
  const configUrl = cleanEnvValue(configProxy?.url);
  return configUrl ? { server: configUrl, source: "config" } : undefined;
}

function resolveBrowserProxyBypass(
  env: Record<string, string | undefined>,
  configProxy: PilotProxyConfig | undefined,
  proxySource: BrowserProxySource,
): string {
  const explicit = cleanEnvValue(env.PILOTDECK_BROWSER_PROXY_BYPASS);
  if (explicit) return explicit;
  const noProxy = cleanEnvValue(env.no_proxy) ?? cleanEnvValue(env.NO_PROXY);
  const configNoProxy = proxySource === "config" ? cleanEnvValue(configProxy?.noProxy) : undefined;
  return [noProxy, configNoProxy, "localhost", "127.0.0.1", "host.docker.internal"].filter(Boolean).join(",");
}

function cleanEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
