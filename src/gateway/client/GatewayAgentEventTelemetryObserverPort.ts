import type { AgentEvent } from "../../agent/index.js";
import type { TelemetryExecutionKind, TelemetryModule } from "../../telemetry/index.js";

/** Immutable Gateway context attached to one already-produced Agent event. */
export type GatewayAgentEventTelemetryContext = {
  sessionId: string;
  runId: string;
  channelKey: string;
  permissionMode: string;
  ownerModule: TelemetryModule;
  executionKind: TelemetryExecutionKind;
  phase?: string;
};

/** Definition for observing a Gateway-consumed Agent event. */
export type GatewayAgentEventTelemetryObserverPort = {
  observe(event: AgentEvent, context: GatewayAgentEventTelemetryContext): void;
};
