import type { EdgeClawMemoryService } from "edgeclaw-memory-core";

import type { TelemetryClient } from "../telemetry/index.js";

type ProjectMemoryMaintenanceService = Pick<EdgeClawMemoryService, "runDueScheduledMaintenance">;

/** The generation-scoped resources that maintenance is allowed to consume. */
export type ProjectMemoryMaintenanceRuntime = {
  projectRoot: string;
  memoryService?: ProjectMemoryMaintenanceService;
};

/**
 * Best-effort request surface for maintenance that runs after a Gateway turn.
 * Scheduling never creates durable state and never blocks the completed turn.
 */
export type ProjectMemoryMaintenancePort = {
  schedule(projectKey?: string): void;
};

export type ProjectMemoryMaintenanceControllerOptions = {
  resolveRuntime(projectKey?: string): ProjectMemoryMaintenanceRuntime;
  telemetry: Pick<TelemetryClient, "trackFeatureLoopStage" | "trackError">;
  onDiagnostic?: (message: string, error?: unknown) => void;
};

type MaintenanceState = {
  requested: boolean;
  inFlight?: Promise<void>;
};

/**
 * Application-owned, generation-scoped memory maintenance coordinator.
 *
 * The WeakMap intentionally keys by the exact published runtime object: a
 * reload may replace a project while old sessions drain, and maintenance
 * requests must never transfer between those two provider generations.
 */
export class ProjectMemoryMaintenanceController implements ProjectMemoryMaintenancePort {
  private readonly states = new WeakMap<ProjectMemoryMaintenanceRuntime, MaintenanceState>();
  private readonly onDiagnostic: (message: string, error?: unknown) => void;

  constructor(private readonly options: ProjectMemoryMaintenanceControllerOptions) {
    this.onDiagnostic = options.onDiagnostic ?? ((message, error) => {
      // eslint-disable-next-line no-console
      console.warn(message, error instanceof Error ? error.message : error ?? "");
    });
  }

  schedule(projectKey?: string): void {
    this.scheduleRuntime(this.options.resolveRuntime(projectKey));
  }

  private scheduleRuntime(runtime: ProjectMemoryMaintenanceRuntime): void {
    const service = runtime.memoryService;
    if (!service) return;

    const state = this.states.get(runtime) ?? { requested: false };
    this.states.set(runtime, state);
    state.requested = true;
    if (state.inFlight) return;
    this.run(runtime, service, state);
  }

  private run(
    runtime: ProjectMemoryMaintenanceRuntime,
    service: ProjectMemoryMaintenanceService,
    state: MaintenanceState,
  ): void {
    state.inFlight = (async () => {
      while (state.requested) {
        state.requested = false;
        try {
          await service.runDueScheduledMaintenance("scheduled");
          this.options.telemetry.trackFeatureLoopStage({
            module: "memory",
            ownerModule: "memory",
            executionKind: "memory",
            phase: "maintenance",
            loopStage: "module_event",
            outcome: "success",
            metadata: {
              phase: "maintenance_completed",
            },
          });
        } catch (error) {
          this.options.telemetry.trackError(error, {
            module: "memory",
            ownerModule: "memory",
            executionKind: "memory",
            phase: "maintenance",
            loopStage: "loop_end",
            errorCategory: "loop_error",
            code: error instanceof Error ? error.name : "UnknownError",
          });
          this.onDiagnostic(
            `[pilotdeck] memory maintenance failed for project ${runtime.projectRoot}:`,
            error,
          );
        }
      }
    })().finally(() => {
      state.inFlight = undefined;
      // A request can arrive after the loop observes an empty queue but before
      // this settlement callback. Resume the same runtime generation directly.
      if (state.requested) this.run(runtime, service, state);
    });
  }
}
