import type { TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";

/** Host attribution selected for one Gateway turn before it reaches an Agent. */
export type GatewayTurnTelemetryContext = {
  ownerModule: TelemetryModule;
  executionKind: TelemetryExecutionKind;
  phase?: string;
};

/** Serializable subset of a submit request that affects telemetry attribution. */
export type GatewayTurnTelemetryContextInput = {
  channelKey: string;
  telemetry?: {
    ownerModule?: TelemetryModule;
    executionKind?: TelemetryExecutionKind;
    phase?: string;
  };
};

/** Definition for host-owned Gateway turn telemetry attribution. */
export type GatewayTurnTelemetryContextResolverPort = {
  resolve(input: GatewayTurnTelemetryContextInput): GatewayTurnTelemetryContext;
};
