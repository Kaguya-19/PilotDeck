import { resolveAlwaysOnPaths, type AlwaysOnPaths } from "../storage/AlwaysOnPaths.js";
import { DiscoveryPlanStore } from "../storage/DiscoveryPlanStore.js";
import { WorkCycleStore } from "../storage/WorkCycleStore.js";
import { AlwaysOnEventStore } from "../storage/AlwaysOnEventStore.js";
import { DiscoveryReportStore } from "../storage/DiscoveryReportStore.js";
import { DiscoveryStateStore } from "../storage/DiscoveryStateStore.js";

/** The durable Always-On resources owned by one project provider instance. */
export type AlwaysOnProjectStorage = {
  paths: AlwaysOnPaths;
  stateStore: DiscoveryStateStorePort;
  planStore: DiscoveryPlanStorePort;
  cycleStore: WorkCycleStorePort;
  reportStore: DiscoveryReportStorePort;
  eventStore: AlwaysOnEventStorePort;
};

/**
 * The state operations owned by the Always-On runtime.
 *
 * Keep this as a structural Definition rather than exposing
 * `DiscoveryStateStore`: the native class has private path state, which
 * would otherwise prevent a non-filesystem provider from implementing it.
 */
export type DiscoveryStateStorePort = Pick<
  DiscoveryStateStore,
  | "read"
  | "markFireStarted"
  | "markFireCompleted"
  | "setActiveWorkCycleId"
  | "setDormant"
  | "clearDormant"
>;

/** Durable discovery-plan operations used by runtime and plan-tool consumers. */
export type DiscoveryPlanStorePort = Pick<
  DiscoveryPlanStore,
  | "readIndex"
  | "writePlanMarkdown"
  | "readPlanMarkdown"
  | "upsert"
  | "updateStatus"
  | "getRecord"
>;

/** Durable work-cycle operations used by scheduler, runtime, and workspace flow. */
export type WorkCycleStorePort = Pick<
  WorkCycleStore,
  "getRecord" | "create" | "addPlan"
>;

/** Durable report operations used by turn projection and report-tool consumers. */
export type DiscoveryReportStorePort = Pick<
  DiscoveryReportStore,
  "writeReport" | "appendRunEvent" | "appendHistory"
>;

/** Append-only phase-event operation used by the Always-On runtime. */
export type AlwaysOnEventStorePort = Pick<AlwaysOnEventStore, "appendEvent">;

export type AlwaysOnProjectStorageProviderInput = {
  pilotHome: string;
  projectKey: string;
};

/**
 * Durable Always-On storage Definition.
 *
 * Runtime scheduling, active run contexts, workspace handles, and Gateway
 * control remain consumers of these resources. The provider only chooses the
 * project record store family and its canonical path layout.
 */
export type AlwaysOnProjectStorageProvider = {
  create(input: AlwaysOnProjectStorageProviderInput): AlwaysOnProjectStorage;
};

/** Native filesystem composition for one project Always-On state family. */
export function createNativeAlwaysOnProjectStorageProvider(): AlwaysOnProjectStorageProvider {
  return {
    create(input) {
      const paths = resolveAlwaysOnPaths(input);
      return {
        paths,
        stateStore: new DiscoveryStateStore(paths),
        planStore: new DiscoveryPlanStore(paths),
        cycleStore: new WorkCycleStore(paths),
        reportStore: new DiscoveryReportStore(paths),
        eventStore: new AlwaysOnEventStore(paths),
      };
    },
  };
}
