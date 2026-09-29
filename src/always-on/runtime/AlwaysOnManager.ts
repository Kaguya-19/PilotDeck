import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { SessionCatalogPort } from "../../session/catalog/SessionCatalogPort.js";
import {
  createProjectSessionReadSideBundle,
  type ProjectSessionStorageProvider,
  type SessionTranscriptReaderPort,
} from "../../session/index.js";
import type { AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
import type { CreateAlwaysOnDiscoveryPlanToolOptions } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { createAlwaysOnDiscoveryPlanTool } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { createAlwaysOnReportTool } from "../tool/AlwaysOnReportTool.js";
import { createAlwaysOnWorkspaceTool } from "../tool/AlwaysOnWorkspaceTool.js";
import { createAlwaysOnChatHistoryTool } from "../tool/AlwaysOnChatHistoryTool.js";
import { AlwaysOnRunContextRegistry } from "./AlwaysOnRunContextRegistry.js";
import type { DiscoveryFireDependencies } from "./DiscoveryFire.js";
import {
  AlwaysOnRuntime,
  type AlwaysOnRuntimeLogger,
} from "./AlwaysOnRuntime.js";
import { SessionConfigOverrides } from "./SessionConfigOverrides.js";
import type { AlwaysOnProjectStorageProvider } from "./AlwaysOnProjectStorageProvider.js";
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

export type CreateAlwaysOnManagerOptions = {
  config: AlwaysOnConfig;
  pilotHome: string;
  sessionOverrides?: SessionConfigOverrides;
  now?: () => Date;
  uuid?: () => string;
  logger?: AlwaysOnRuntimeLogger;
  toolContractOptions?: CreateAlwaysOnDiscoveryPlanToolOptions["contract"];
  onWorktreeCreated?: (runId: string, cwd: string) => void;
  onWorktreeRemoved?: (cwd: string) => void;
  onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
  telemetry?: TelemetryClient;
  /** Read-only durable-session catalog selected by application composition. */
  sessionCatalog?: SessionCatalogPort;
  /** Read-only durable transcript reader selected by application composition. */
  sessionTranscriptReader?: SessionTranscriptReaderPort;
  /**
   * Durable backend used to derive the default catalog and transcript reader.
   * Explicit read-side ports remain higher-priority application overrides.
   */
  storageProvider?: ProjectSessionStorageProvider;
  /** Application-selected provider for each enabled project's Always-On records. */
  alwaysOnStorageProvider?: AlwaysOnProjectStorageProvider;
};

type ResolvedAlwaysOnManagerOptions = Omit<CreateAlwaysOnManagerOptions, "sessionCatalog"> & {
  sessionCatalog: SessionCatalogPort;
  sessionTranscriptReader: SessionTranscriptReaderPort;
};

/**
 * Multi-project coordinator for Always-On.
 *
 * Creates one `AlwaysOnRuntime` per enabled project in the config while
 * sharing a single `AlwaysOnRunContextRegistry`, `SessionConfigOverrides`,
 * and tool set.  This ensures tool lookups by session-key work across all
 * projects and the gateway only sees one set of tool definitions.
 */
export class AlwaysOnManager implements AlwaysOnControlPort {
  private readonly runtimes: AlwaysOnRuntime[] = [];
  private readonly runContexts = new AlwaysOnRunContextRegistry();
  private readonly sessionOverrides: SessionConfigOverrides;
  private readonly sessionCatalog: SessionCatalogPort;
  private readonly sessionTranscriptReader: SessionTranscriptReaderPort;
  private readonly tools: PilotDeckToolDefinition[];
  private readonly logger: AlwaysOnRuntimeLogger;

  constructor(private readonly options: ResolvedAlwaysOnManagerOptions) {
    const now = options.now ?? (() => new Date());
    const uuid = options.uuid;
    this.sessionOverrides = options.sessionOverrides ?? new SessionConfigOverrides();
    this.sessionCatalog = options.sessionCatalog;
    this.sessionTranscriptReader = options.sessionTranscriptReader;
    this.logger = options.logger ?? { info: () => undefined, warn: () => undefined };

    this.tools = [
      createAlwaysOnDiscoveryPlanTool({
        runContexts: this.runContexts,
        contract: options.toolContractOptions,
        now,
        uuid,
      }),
      createAlwaysOnReportTool({
        runContexts: this.runContexts,
        now,
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

    for (const [projectKey, project] of Object.entries(options.config.projects)) {
      if (!project.enabled) continue;
      this.runtimes.push(
        new AlwaysOnRuntime({
          config: options.config,
          pilotHome: options.pilotHome,
          projectKey,
          now: options.now,
          uuid: options.uuid,
          logger: options.logger,
          onWorktreeCreated: options.onWorktreeCreated,
          onWorktreeRemoved: options.onWorktreeRemoved,
          onTurnEvent: options.onTurnEvent,
          telemetry: options.telemetry,
          runContexts: this.runContexts,
          sessionOverrides: this.sessionOverrides,
          sessionCatalog: this.sessionCatalog,
          sessionTranscriptReader: this.sessionTranscriptReader,
          alwaysOnStorageProvider: options.alwaysOnStorageProvider,
          skipToolCreation: true,
        }),
      );
    }
  }

  getTools(): PilotDeckToolDefinition[] {
    return [...this.tools];
  }

  getSessionOverrides(): SessionConfigOverrides {
    return this.sessionOverrides;
  }

  /**
   * Bind the gateway and an optional `isProjectBusy` callback that the
   * scheduler uses to evaluate the `agent_busy` gate from real data.
   */
  bindAgentGateway(
    agentGateway: AlwaysOnAgentGatewayPort,
    hooks?: { isProjectBusy?: (projectKey: string) => boolean },
  ): void {
    const isProjectBusy = hooks?.isProjectBusy;
    for (const runtime of this.runtimes) {
      const projectKey = runtime.projectKey;
      runtime.bindAgentGateway(agentGateway, {
        isSessionInFlight: isProjectBusy
          ? () => isProjectBusy(projectKey)
          : undefined,
      });
    }
  }

  /** @deprecated Use bindAgentGateway; the parameter is intentionally only the turn facade. */
  bindGateway(
    agentGateway: AlwaysOnAgentGatewayPort,
    hooks?: { isProjectBusy?: (projectKey: string) => boolean },
  ): void {
    this.bindAgentGateway(agentGateway, hooks);
  }

  async start(): Promise<void> {
    for (const runtime of this.runtimes) {
      await runtime.start();
    }
    if (this.runtimes.length === 0) {
      this.logger.info("always-on manager: no enabled projects; nothing to start.");
    }
  }

  async stop(): Promise<void> {
    for (const runtime of this.runtimes) {
      await runtime.stop();
    }
  }

  async rerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
    const runtime = this.runtimes.find((r) => r.projectKey === input.projectKey);
    if (!runtime) {
      return { runId: "", error: { code: "project_not_found", message: `No Always-On runtime for project ${input.projectKey}` } };
    }
    return runtime.rerunPlan(input);
  }

  async applyCycle(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult> {
    const runtime = this.runtimes.find((r) => r.projectKey === input.projectKey);
    if (!runtime) {
      return { sessionKey: "", error: { code: "project_not_found", message: `No Always-On runtime for project ${input.projectKey}` } };
    }
    return runtime.applyCycle({
      projectKey: input.projectKey,
      workCycleId: input.workCycleId,
      projectName: input.projectName,
    });
  }

  async abortRun(input: AlwaysOnAbortInput): Promise<AlwaysOnAbortResult> {
    const runtime = this.runtimes.find((entry) => entry.projectKey === input.projectKey);
    if (!runtime) {
      return {
        aborted: false,
        sessionKey: input.sessionKey,
        error: { code: "project_not_found", message: `No Always-On runtime for project ${input.projectKey}` },
      };
    }
    return runtime.abortRun(input);
  }
}

export function createAlwaysOnManager(
  options: CreateAlwaysOnManagerOptions,
): AlwaysOnManager {
  const readSide = createProjectSessionReadSideBundle(options);
  return new AlwaysOnManager({
    ...options,
    sessionCatalog: readSide.catalog,
    sessionTranscriptReader: readSide.transcriptReader,
  });
}
