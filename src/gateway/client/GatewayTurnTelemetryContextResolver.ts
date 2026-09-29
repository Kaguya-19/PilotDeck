import type {
  GatewayTurnTelemetryContext,
  GatewayTurnTelemetryContextInput,
  GatewayTurnTelemetryContextResolverPort,
} from "./GatewayTurnTelemetryContextResolverPort.js";

/**
 * Native host policy for classifying Gateway turn telemetry.
 *
 * It derives immutable attribution only. Collector lifecycle, event emission,
 * Gateway admission, and Session state remain with their existing owners.
 */
export class GatewayTurnTelemetryContextResolver implements GatewayTurnTelemetryContextResolverPort {
  resolve(input: GatewayTurnTelemetryContextInput): GatewayTurnTelemetryContext {
    if (input.telemetry?.ownerModule && input.telemetry.executionKind) {
      return {
        ownerModule: input.telemetry.ownerModule,
        executionKind: input.telemetry.executionKind,
        phase: input.telemetry.phase,
      };
    }
    if (input.channelKey.startsWith("always-on/")) {
      return {
        ownerModule: "always_on",
        executionKind: "always_on",
        phase: input.channelKey.slice("always-on/".length) || input.telemetry?.phase,
      };
    }
    return {
      ownerModule: input.telemetry?.ownerModule ?? "session",
      executionKind: input.telemetry?.executionKind ?? "user_session",
      phase: input.telemetry?.phase,
    };
  }
}
