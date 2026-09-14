import { randomUUID } from "node:crypto";
import type { SessionCatalogPort } from "../../session/catalog/SessionCatalogPort.js";
import {
  createProjectSessionReadSideBundle,
  type ProjectSessionStorageProvider,
  type SessionTranscriptReaderPort,
} from "../../session/index.js";
import { DiscoveryFire, type DiscoveryFireDependencies } from "./DiscoveryFire.js";
import { SessionConfigOverrides } from "./SessionConfigOverrides.js";
import { WorkspaceProviderRegistry } from "../workspace/WorkspaceProviderRegistry.js";
import { AlwaysOnRunContextRegistry } from "./AlwaysOnRunContextRegistry.js";
import {
  createNativeAlwaysOnProjectStorageProvider,
  type AlwaysOnProjectStorageProvider,
} from "./AlwaysOnProjectStorageProvider.js";
import { defaultAlwaysOnConfig, type AlwaysOnConfig } from "../config/parseAlwaysOnConfig.js";
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
import type { AlwaysOnAgentGatewayPort, GatewayEvent } from "./AlwaysOnAgentGatewayPort.js";

export type CreateApplyHandlerDeps = {
  /** Narrow turn facade; a full Gateway structurally satisfies this type. */
  agentGateway: AlwaysOnAgentGatewayPort;
  pilotHome: string;
  sessionOverrides: SessionConfigOverrides;
  onTurnEvent?: DiscoveryFireDependencies["onTurnEvent"];
  alwaysOnConfig?: AlwaysOnConfig;
  telemetry?: TelemetryClient;
  /** Application-selected catalog used by the DiscoveryFire consumer. */
  sessionCatalog: SessionCatalogPort;
  /** Application-selected durable transcript reader used by DiscoveryFire. */
  sessionTranscriptReader: SessionTranscriptReaderPort;
  /** Application-selected provider for this project's Always-On durable records. */
  alwaysOnStorageProvider?: AlwaysOnProjectStorageProvider;
};

/** Native standalone factory options. The factory owns its compatibility default. */
export type CreateStandaloneAlwaysOnControlDeps = Omit<
  CreateApplyHandlerDeps,
  "sessionCatalog" | "sessionTranscriptReader"
> & {
  sessionCatalog?: SessionCatalogPort;
  sessionTranscriptReader?: SessionTranscriptReaderPort;
  /**
   * Durable backend used to derive standalone read-side defaults. Explicit
   * catalog/reader inputs remain higher-priority application overrides.
   */
  storageProvider?: ProjectSessionStorageProvider;
};

/**
 * Build a lightweight apply handler that does NOT depend on
 * `AlwaysOnManager` or `DiscoveryScheduler`. It reads the cycle from
 * disk and delegates to `DiscoveryFire.runApplyPhase`, which only
 * requires the turn facade, `sessionOverrides`, and the cycle record.
 */
export function createApplyHandler(
  deps: CreateApplyHandlerDeps,
): (input: AlwaysOnApplyInput) => Promise<AlwaysOnApplyResult> {
  return async (input) => {
    const storage = (deps.alwaysOnStorageProvider ?? createNativeAlwaysOnProjectStorageProvider()).create({
      pilotHome: deps.pilotHome,
      projectKey: input.projectKey,
    });
    const {
      paths,
      cycleStore,
      planStore,
      stateStore,
      reportStore,
      eventStore,
    } = storage;

    const cycle = await cycleStore.getRecord(input.workCycleId);
    if (!cycle) {
      return {
        sessionKey: "",
        error: { code: "cycle_not_found", message: `Work cycle ${input.workCycleId} not found` },
      };
    }

    if (!cycle.workspace?.cwd) {
      return {
        sessionKey: "",
        error: { code: "missing_workspace", message: "Cycle has no associated workspace to apply" },
      };
    }

    const planIndex = await planStore.readIndex();
    const cyclePlans = planIndex.plans
      .filter((p) => cycle.planIds.includes(p.id))
      .map((p) => ({ id: p.id, title: p.title }));

    const baseConfig = deps.alwaysOnConfig ?? defaultAlwaysOnConfig();
    const minimalDeps: DiscoveryFireDependencies = {
      config: baseConfig,
      paths,
      projectKey: input.projectKey,
      gateway: deps.agentGateway,
      runContexts: new AlwaysOnRunContextRegistry(),
      workspaceRegistry: new WorkspaceProviderRegistry(),
      sessionOverrides: deps.sessionOverrides,
      stateStore,
      planStore,
      cycleStore,
      reportStore,
      eventStore,
      sessionCatalog: deps.sessionCatalog,
      sessionTranscriptReader: deps.sessionTranscriptReader,
      uuid: () => randomUUID(),
      now: () => new Date(),
      onTurnEvent: deps.onTurnEvent,
      telemetry: deps.telemetry,
    };

    const fire = new DiscoveryFire(minimalDeps);
    const runId = randomUUID();
    const result = await fire.runApplyPhase({
      runId,
      cycle,
      plans: cyclePlans,
      projectName: input.projectName,
      projectRoot: input.projectKey,
    });

    return { sessionKey: result.sessionKey, error: result.error };
  };
}

/**
 * Native fallback provider when Always-On discovery is disabled. It can still
 * apply a persisted work cycle, but has no scheduler-owned plan rerun state.
 */
export function createStandaloneAlwaysOnControl(
  deps: CreateStandaloneAlwaysOnControlDeps,
): AlwaysOnControlPort {
  const readSide = createProjectSessionReadSideBundle(deps);
  const applyCycle = createApplyHandler({
    ...deps,
    sessionCatalog: readSide.catalog,
    sessionTranscriptReader: readSide.transcriptReader,
  });
  return {
    applyCycle,
    async abortRun(input: AlwaysOnAbortInput): Promise<AlwaysOnAbortResult> {
      return {
        aborted: false,
        sessionKey: input.sessionKey,
        error: {
          code: "not_configured",
          message: "Always-On abort requires an enabled Always-On runtime.",
        },
      };
    },
    async rerunPlan(_input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
      return {
        runId: "",
        error: {
          code: "not_configured",
          message: "Always-On plan rerun requires an enabled Always-On runtime.",
        },
      };
    },
  };
}
