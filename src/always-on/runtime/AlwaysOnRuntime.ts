import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { SessionCatalogPort } from "../../session/catalog/SessionCatalogPort.js";
import {
  createProjectSessionReadSideBundle,
  type ProjectSessionStorageProvider,
  type SessionTranscriptReaderPort,
} from "../../session/index.js";
import type { PilotDeckToolDefinition } from "../../tool/index.js";
import { DEFAULT_SNAPSHOT_MAX_BYTES, type AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
import type { AlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import {
  createAlwaysOnDiscoveryPlanTool,
  type CreateAlwaysOnDiscoveryPlanToolOptions,
} from "../tool/AlwaysOnDiscoveryPlanTool.js";
import {
  createAlwaysOnReportTool,
} from "../tool/AlwaysOnReportTool.js";
import {
  createAlwaysOnWorkspaceTool,
} from "../tool/AlwaysOnWorkspaceTool.js";
import {
  createAlwaysOnChatHistoryTool,
} from "../tool/AlwaysOnChatHistoryTool.js";
import { GitWorktreeProvider } from "../workspace/GitWorktreeProvider.js";
import { SnapshotCopyProvider } from "../workspace/SnapshotCopyProvider.js";
import { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import { AlwaysOnRunContextRegistry } from "./AlwaysOnRunContextRegistry.js";
import { ChannelLeaseRegistry } from "./ChannelLeaseRegistry.js";
import { DiscoveryFire, type DiscoveryFireDependencies } from "./DiscoveryFire.js";
import { DiscoveryScheduler } from "./DiscoveryScheduler.js";
import { SessionConfigOverrides } from "./SessionConfigOverrides.js";
import {
  createNativeAlwaysOnProjectStorageProvider,
  type AlwaysOnEventStorePort,
  type AlwaysOnProjectStorageProvider,
  type DiscoveryPlanStorePort,
  type DiscoveryReportStorePort,
  type DiscoveryStateStorePort,
  type WorkCycleStorePort,
} from "./AlwaysOnProjectStorageProvider.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type {
  AlwaysOnControlPort,
  AlwaysOnApplyInput,
  AlwaysOnApplyResult,
  AlwaysOnAbortInput,
  AlwaysOnAbortResult,
  AlwaysOnRerunPlanInput,
  AlwaysOnRerunPlanResult,
} from "../protocol/AlwaysOnControlPort.js";
import type { AlwaysOnAgentGatewayPort } from "./AlwaysOnAgentGatewayPort.js";

export type AlwaysOnRuntimeLogger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

export type CreateAlwaysOnRuntimeOptions = {
  config: AlwaysOnConfig;
  pilotHome: string;
  /** Absolute path of a project that this server hosts. */
  projectKey: string;
  now?: () => Date;
  uuid?: () => string;
  logger?: AlwaysOnRuntimeLogger;
  /** Override for tests. */
  workspaceRegistry?: WorkspaceProviderRegistry;
  toolContractOptions?: CreateAlwaysOnDiscoveryPlanToolOptions["contract"];
  onWorktreeCreated?: (runId: string, cwd: string) => void;
  onWorktreeRemoved?: (cwd: string) => void;
  onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
  /** Shared run-context registry (used by AlwaysOnManager for multi-project). */
  runContexts?: AlwaysOnRunContextRegistry;
  /** Shared session-config overrides (used by AlwaysOnManager for multi-project). */
  sessionOverrides?: SessionConfigOverrides;
  /** Read-only durable-session catalog selected by application composition. */
  sessionCatalog?: SessionCatalogPort;
  /** Read-only durable transcript reader selected by application composition. */
  sessionTranscriptReader?: SessionTranscriptReaderPort;
  /**
   * Durable backend used to derive the default catalog and transcript reader.
   * Explicit read-side ports remain higher-priority application overrides.
   */
  storageProvider?: ProjectSessionStorageProvider;
  /** Application-selected provider for this project's Always-On durable records. */
  alwaysOnStorageProvider?: AlwaysOnProjectStorageProvider;
  /**
   * Project-level callback: returns true when a user session is actively
   * running a turn for this project.  Passed through to the scheduler so
   * the `agent_busy` gate fires from real data instead of the former
   * hard-coded `false`.
   */
  isSessionInFlight?: () => boolean;
  /** When true, the runtime skips internal tool creation (manager owns tools). */
  skipToolCreation?: boolean;
  telemetry?: TelemetryClient;
};

type ResolvedAlwaysOnRuntimeOptions = CreateAlwaysOnRuntimeOptions & {
  sessionCatalog: SessionCatalogPort;
  sessionTranscriptReader: SessionTranscriptReaderPort;
};

const NOOP_LOGGER: AlwaysOnRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
};

type ActiveControlRun = {
  runId: string;
  sessionKeys: ReadonlySet<string>;
  promise: Promise<unknown>;
};

/**
 * AlwaysOnRuntime is the lifecycle owner for the entire Always-On module.
 *
 * Wiring sequence (see `02-pilotdeck-always-on-rewrite-plan.md` §1, §5):
 *   1. Construct via `createAlwaysOnRuntime(...)` before the Gateway is built.
 *   2. Pull tools via `runtime.getTools()` and feed them into the per-project
 *      ToolRegistry that the Gateway uses.
 *   3. Pull session overrides via `runtime.getSessionOverrides()` and let
 *      `ProjectRuntimeRegistry` consult them when constructing AgentSessions.
 *   4. Bind the narrow turn facade via `runtime.bindAgentGateway(port)`.
 *   5. Call `runtime.start()` to launch the discovery scheduler.
 *   6. Call `runtime.stop()` during server shutdown.
 *
 * The runtime never reaches into AgentSession internals; it only talks to the
 * Gateway via `submitTurn`/`closeSession` so behavior matches what a normal
 * channel adapter would observe.
 */
export class AlwaysOnRuntime implements AlwaysOnControlPort {
  readonly config: AlwaysOnConfig;
  readonly projectKey: string;
  readonly paths: AlwaysOnPaths;

  private readonly stateStore: DiscoveryStateStorePort;
  private readonly planStore: DiscoveryPlanStorePort;
  private readonly cycleStore: WorkCycleStorePort;
  private readonly reportStore: DiscoveryReportStorePort;
  private readonly eventStore: AlwaysOnEventStorePort;
  private readonly runContexts: AlwaysOnRunContextRegistry;
  private readonly leases: ChannelLeaseRegistry;
  private readonly sessionOverrides: SessionConfigOverrides;
  private readonly sessionCatalog: SessionCatalogPort;
  private readonly sessionTranscriptReader: SessionTranscriptReaderPort;
  private readonly workspaceRegistry: WorkspaceProviderRegistry;
  private readonly logger: AlwaysOnRuntimeLogger;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly tools: PilotDeckToolDefinition[];
  private readonly isSessionInFlight: () => boolean;
  private readonly onWorktreeCreated?: (runId: string, cwd: string) => void;
  private readonly onWorktreeRemoved?: (cwd: string) => void;
  private readonly onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
  private readonly telemetry?: TelemetryClient;

  private agentGateway?: AlwaysOnAgentGatewayPort;
  private fire?: DiscoveryFire;
  private scheduler?: DiscoveryScheduler;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private readonly activeControlRuns = new Map<string, ActiveControlRun>();

  constructor(options: ResolvedAlwaysOnRuntimeOptions) {
    this.config = options.config;
    this.projectKey = resolve(options.projectKey);
    const storage = (options.alwaysOnStorageProvider ?? createNativeAlwaysOnProjectStorageProvider()).create({
      pilotHome: options.pilotHome,
      projectKey: this.projectKey,
    });
    this.paths = storage.paths;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.isSessionInFlight = options.isSessionInFlight ?? (() => false);

    this.stateStore = storage.stateStore;
    this.planStore = storage.planStore;
    this.cycleStore = storage.cycleStore;
    this.reportStore = storage.reportStore;
    this.eventStore = storage.eventStore;
    this.runContexts = options.runContexts ?? new AlwaysOnRunContextRegistry();
    this.leases = new ChannelLeaseRegistry(this.now);
    this.sessionOverrides = options.sessionOverrides ?? new SessionConfigOverrides();
    this.sessionCatalog = options.sessionCatalog;
    this.sessionTranscriptReader = options.sessionTranscriptReader;
    this.onWorktreeCreated = options.onWorktreeCreated;
    this.onWorktreeRemoved = options.onWorktreeRemoved;
    this.onTurnEvent = options.onTurnEvent;
    this.telemetry = options.telemetry;
    this.workspaceRegistry = options.workspaceRegistry ?? this.buildDefaultWorkspaceRegistry();

    this.tools = options.skipToolCreation
      ? []
      : [
          createAlwaysOnDiscoveryPlanTool({
            runContexts: this.runContexts,
            contract: options.toolContractOptions,
            now: this.now,
            uuid: this.uuid,
          }),
          createAlwaysOnReportTool({
            runContexts: this.runContexts,
            now: this.now,
          }),
          createAlwaysOnWorkspaceTool({
            runContexts: this.runContexts,
          }),
          createAlwaysOnChatHistoryTool({
            runContexts: this.runContexts,
            sessionCatalog: this.sessionCatalog,
            sessionTranscriptReader: this.sessionTranscriptReader,
          }),
        ];
  }

  getTools(): PilotDeckToolDefinition[] {
    return [...this.tools];
  }

  getSessionOverrides(): SessionConfigOverrides {
    return this.sessionOverrides;
  }

  getChannelLeases(): ChannelLeaseRegistry {
    return this.leases;
  }

  getRunContexts(): AlwaysOnRunContextRegistry {
    return this.runContexts;
  }

  bindAgentGateway(
    agentGateway: AlwaysOnAgentGatewayPort,
    hooks?: { isSessionInFlight?: () => boolean },
  ): void {
    if (this.agentGateway) {
      throw new Error("AlwaysOnRuntime.bindAgentGateway already called.");
    }
    this.agentGateway = agentGateway;
    const isSessionInFlight = hooks?.isSessionInFlight ?? this.isSessionInFlight;
    this.fire = new DiscoveryFire({
      config: this.config,
      paths: this.paths,
      projectKey: this.projectKey,
      gateway: agentGateway,
      runContexts: this.runContexts,
      workspaceRegistry: this.workspaceRegistry,
      sessionOverrides: this.sessionOverrides,
      stateStore: this.stateStore,
      planStore: this.planStore,
      cycleStore: this.cycleStore,
      reportStore: this.reportStore,
      eventStore: this.eventStore,
      sessionCatalog: this.sessionCatalog,
      sessionTranscriptReader: this.sessionTranscriptReader,
      uuid: this.uuid,
      now: this.now,
      logger: this.logger,
      onTurnEvent: this.onTurnEvent,
      telemetry: this.telemetry,
    });
    this.scheduler = new DiscoveryScheduler({
      config: this.config,
      projectKey: this.projectKey,
      paths: this.paths,
      stateStore: this.stateStore,
      cycleStore: this.cycleStore,
      leases: this.leases,
      fire: this.fire,
      uuid: this.uuid,
      now: this.now,
      logger: this.logger,
      isSessionInFlight,
    });
  }

  /** @deprecated Use bindAgentGateway; the parameter is intentionally only the turn facade. */
  bindGateway(
    agentGateway: AlwaysOnAgentGatewayPort,
    hooks?: { isSessionInFlight?: () => boolean },
  ): void {
    this.bindAgentGateway(agentGateway, hooks);
  }

  async start(): Promise<void> {
    if (!this.scheduler) {
      throw new Error("AlwaysOnRuntime.start called before bindGateway.");
    }
    await this.scheduler.start();
    this.logger.info("always-on runtime started", { projectKey: this.projectKey });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      await this.scheduler?.stop();
      await Promise.allSettled([...this.activeControlRuns.values()].map((run) => run.promise));
      this.scheduler = undefined;
      this.fire = undefined;
      for (const context of this.runContexts.list()) {
        if (context.projectKey === this.projectKey) {
          this.runContexts.unregister(context.sessionKey);
        }
      }
      for (const phase of ["discovery", "workspace", "execute", "report", "apply"]) {
        this.sessionOverrides.deletePrefix(`always-on/${phase}:project=${this.projectKey}:`);
      }
      this.logger.info("always-on runtime stopped", { projectKey: this.projectKey });
    })();
    return this.stopPromise;
  }

  async rerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
    const fire = this.fire;
    if (!fire || this.stopping) {
      return { runId: "", error: { code: "not_ready", message: "AlwaysOnRuntime.bindGateway not called" } };
    }
    const runId = this.uuid();
    return this.trackControlRun({
      runId,
      sessionKeys: this.sessionKeysForRerun(runId),
    }, (async () => {
      const startedAt = this.now();
      const result = await fire.rerunPlan({ planId: input.planId, runId, startedAt });
      return { runId: result.runId, error: "error" in result ? result.error : undefined };
    })());
  }

  async applyCycle(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult> {
    const fire = this.fire;
    if (!fire || this.stopping) {
      return { sessionKey: "", error: { code: "not_ready", message: "AlwaysOnRuntime.bindGateway not called" } };
    }
    const runId = this.uuid();
    return this.trackControlRun({
      runId,
      sessionKeys: [DiscoveryFire.deriveApplySessionKey(this.projectKey, runId)],
    }, (async () => {
      const cycle = await this.cycleStore.getRecord(input.workCycleId);
      if (!cycle) {
        return { sessionKey: "", error: { code: "cycle_not_found", message: `Work cycle ${input.workCycleId} not found` } };
      }

      const planIndex = await this.planStore.readIndex();
      const cyclePlans = planIndex.plans
        .filter((p) => cycle.planIds.includes(p.id))
        .map((p) => ({ id: p.id, title: p.title }));

      const result = await fire.runApplyPhase({
        runId,
        cycle,
        plans: cyclePlans,
        projectName: input.projectName,
        projectRoot: input.projectKey,
      });

      return { sessionKey: result.sessionKey, error: result.error };
    })());
  }

  async abortRun(input: AlwaysOnAbortInput): Promise<AlwaysOnAbortResult> {
    const gateway = this.agentGateway;
    if (!gateway || !this.fire || this.stopping) {
      return {
        aborted: false,
        sessionKey: input.sessionKey,
        error: { code: "not_ready", message: "AlwaysOnRuntime.bindGateway not called" },
      };
    }

    const context = this.runContexts.get(input.sessionKey);
    const controlRun = [...this.activeControlRuns.values()].find((run) => run.sessionKeys.has(input.sessionKey));
    if (context?.projectKey !== this.projectKey && !controlRun) {
      return {
        aborted: false,
        sessionKey: input.sessionKey,
        error: { code: "session_not_active", message: "No active Always-On run owns this session." },
      };
    }

    const runId = context?.runId ?? controlRun?.runId;
    try {
      await gateway.abortTurn({
        sessionKey: input.sessionKey,
        ...(runId ? { runId } : {}),
        reason: input.reason ?? "always-on/abort_requested",
      });
      return { aborted: true, sessionKey: input.sessionKey, ...(runId ? { runId } : {}) };
    } catch (error) {
      return {
        aborted: false,
        sessionKey: input.sessionKey,
        ...(runId ? { runId } : {}),
        error: {
          code: "abort_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private trackControlRun<T>(
    input: { runId: string; sessionKeys: readonly string[] },
    run: Promise<T>,
  ): Promise<T> {
    const active: ActiveControlRun = {
      runId: input.runId,
      sessionKeys: new Set(input.sessionKeys),
      promise: run,
    };
    this.activeControlRuns.set(active.runId, active);
    void run.then(
      () => this.activeControlRuns.delete(active.runId),
      () => this.activeControlRuns.delete(active.runId),
    );
    return run;
  }

  private sessionKeysForRerun(runId: string): string[] {
    return [
      DiscoveryFire.deriveWorkspaceSessionKey(this.projectKey, runId),
      DiscoveryFire.deriveExecutionSessionKey(this.projectKey, runId),
      DiscoveryFire.deriveReportSessionKey(this.projectKey, runId),
    ];
  }

  private buildDefaultWorkspaceRegistry(): WorkspaceProviderRegistry {
    const registry = new WorkspaceProviderRegistry();
    registry.add(
      new GitWorktreeProvider({
        baseDir: this.paths.worktreesDir,
        onWorktreeCreated: this.onWorktreeCreated,
        onWorktreeRemoved: this.onWorktreeRemoved,
      }),
    );
    registry.add(
      new SnapshotCopyProvider({
        baseDir: this.paths.snapshotsDir,
        maxBytes: DEFAULT_SNAPSHOT_MAX_BYTES,
      }),
    );
    return registry;
  }
}

export function createAlwaysOnRuntime(options: CreateAlwaysOnRuntimeOptions): AlwaysOnRuntime {
  const readSide = createProjectSessionReadSideBundle(options);
  return new AlwaysOnRuntime({
    ...options,
    sessionCatalog: readSide.catalog,
    sessionTranscriptReader: readSide.transcriptReader,
  });
}
