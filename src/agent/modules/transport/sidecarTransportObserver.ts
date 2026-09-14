import type { ModuleCallRequest, ModuleOutcome } from "../protocol.js";

/**
 * Passive, deployment-facing facts emitted by the sidecar transport client.
 * These are intentionally neither Session events nor a status-query API.
 */
export type AgentLoopSidecarTransportObservation =
  | Readonly<{ type: "stream_accepted"; resumeSupported: boolean }>
  | Readonly<{ type: "reconnect_started"; attempt: number; lastAppliedSequence: number }>
  | Readonly<{ type: "reconnect_succeeded"; attempt: number }>
  | Readonly<{ type: "reconnect_failed"; attempt: number }>
  | Readonly<{ type: "sidecar_instance_restarted" }>
  | Readonly<{ type: "pending_module_call_replayed"; module: ModuleCallRequest["module"] }>
  | Readonly<{ type: "cached_module_response_replayed"; module: ModuleCallRequest["module"] }>
  | Readonly<{
      type: "result_unknown_resolved";
      source: "sidecar_final" | "transport_interruption";
      outcome: Exclude<ModuleOutcome, "result_unknown">;
    }>
  | Readonly<{
      type: "result_unknown_fail_closed";
      source: "sidecar_final" | "transport_interruption";
    }>;

/**
 * Optional deployment observer. Implementations must treat observations as
 * live telemetry only; the transport never awaits or trusts their result.
 */
export type AgentLoopSidecarTransportObserver = {
  observe(observation: AgentLoopSidecarTransportObservation): void | Promise<void>;
};
