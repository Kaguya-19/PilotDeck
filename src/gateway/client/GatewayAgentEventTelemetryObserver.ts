import type { AgentEvent } from "../../agent/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type {
  GatewayAgentEventTelemetryContext,
  GatewayAgentEventTelemetryObserverPort,
} from "./GatewayAgentEventTelemetryObserverPort.js";

export type GatewayAgentEventTelemetryObserverOptions = {
  telemetry?: TelemetryClient;
};

/**
 * Native live-observation provider for Agent events consumed by Gateway.
 *
 * This provider only derives telemetry records. The Gateway still owns turn
 * admission/replay and GatewayTelemetryBundle still owns collector lifetime.
 */
export class GatewayAgentEventTelemetryObserver implements GatewayAgentEventTelemetryObserverPort {
  private readonly telemetry?: TelemetryClient;

  constructor(options: GatewayAgentEventTelemetryObserverOptions = {}) {
    this.telemetry = options.telemetry;
  }

  observe(event: AgentEvent, context: GatewayAgentEventTelemetryContext): void {
    const telemetry = this.telemetry;
    if (!telemetry) return;

    switch (event.type) {
      case "model_request_started":
        return;
      case "model_event":
        if (event.event.type === "request_started") {
          telemetry.trackFeatureLoopStage({
            module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
            phase: context.phase, loopStage: "model_request", outcome: "success", sessionId: context.sessionId,
            metadata: {
              runId: context.runId, provider: event.event.provider, model: event.event.model,
              ...(event.event.providerBaseUrl ? { providerBaseUrl: event.event.providerBaseUrl } : {}),
              permissionMode: context.permissionMode, channelKey: context.channelKey,
            },
          });
          return;
        }
        if (event.event.type === "message_end") {
          telemetry.trackFeatureLoopStage({
            module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
            phase: context.phase, loopStage: "model_response", outcome: "success", sessionId: context.sessionId,
            metadata: { runId: context.runId },
          });
        }
        if (event.event.type === "error") {
          telemetry.trackError(event.event.error, {
            module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
            phase: context.phase, loopStage: "model_request", errorCategory: "model_request_error",
            sessionId: context.sessionId, code: event.event.error.code,
            metadata: { runId: context.runId, provider: event.event.error.provider },
          });
        }
        return;
      case "tool_calls_detected":
        telemetry.trackFeatureLoopStage({
          module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
          phase: context.phase, loopStage: "tool_prepare", outcome: "success", sessionId: context.sessionId,
          metadata: { runId: context.runId, toolCount: event.calls.length, toolNames: event.calls.map((call) => call.name) },
        });
        return;
      case "pre_tool_execute":
        telemetry.trackFeatureLoopStage({
          module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
          phase: context.phase, loopStage: "tool_call", outcome: "success", sessionId: context.sessionId,
          metadata: { runId: context.runId, toolName: event.toolName, toolCallId: event.toolCallId },
        });
        return;
      case "post_tool_execute":
        telemetry.trackFeatureLoopStage({
          module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
          phase: context.phase, loopStage: "tool_call", outcome: event.success ? "success" : "failed",
          errorCategory: event.success ? undefined : "tool_runtime_error", sessionId: context.sessionId,
          metadata: { runId: context.runId, toolName: event.toolName, toolCallId: event.toolCallId, success: event.success },
        });
        return;
      case "tool_result":
        if (event.result.type === "error") {
          const code = event.result.error.code;
          telemetry.trackError(event.result.error.message, {
            module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
            phase: context.phase, loopStage: "tool_call", errorCategory: inferToolErrorCategory(code),
            sessionId: context.sessionId, code, toolName: event.result.toolName,
            metadata: { runId: context.runId, toolName: event.result.toolName, toolCallId: event.result.toolCallId },
          });
        }
        return;
      case "permission_requested":
        telemetry.trackFeatureLoopStage({
          module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
          phase: context.phase, loopStage: "permission_check", outcome: "success", sessionId: context.sessionId,
          metadata: { runId: context.runId, toolName: event.toolName, toolCallId: event.toolCallId },
        });
        return;
      case "permission_denied":
        telemetry.trackError(event.reason, {
          module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
          phase: context.phase, loopStage: "permission_check", errorCategory: "permission_error",
          sessionId: context.sessionId, code: "permission_denied", toolName: event.toolName,
          metadata: { runId: context.runId, toolName: event.toolName },
        });
        return;
      case "turn_completed":
        telemetry.trackFeatureLoopStage({
          module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
          phase: context.phase, loopStage: "loop_end", outcome: "success", sessionId: context.sessionId,
          metadata: { runId: context.runId, stopReason: event.result.stopReason, turns: event.result.turns },
        });
        return;
      case "turn_failed":
        telemetry.trackError(event.error, {
          module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
          phase: context.phase, loopStage: "loop_end", errorCategory: "loop_error", sessionId: context.sessionId,
          code: event.error.code, metadata: { runId: context.runId },
        });
        return;
      case "session_aborted":
        telemetry.trackFeatureLoopStage({
          module: "session", ownerModule: context.ownerModule, executionKind: context.executionKind,
          phase: context.phase, loopStage: "loop_end", outcome: "aborted", sessionId: context.sessionId,
          metadata: { runId: context.runId, reason: event.reason },
        });
        return;
      case "subagent_model_event":
        this.observeSubagentModelEvent(event, context);
        return;
      case "subagent_tool_calls_detected":
        telemetry.trackFeatureLoopStage({
          module: "session", ownerModule: context.ownerModule, executionKind: "subagent",
          phase: context.phase, loopStage: "tool_prepare", outcome: "success", sessionId: context.sessionId,
          metadata: {
            runId: context.runId, subagentId: event.subagentId, subagentType: event.subagentType,
            toolCount: event.calls.length, toolNames: event.calls.map((call) => call.name),
          },
        });
        return;
      case "subagent_tool_result":
        if (event.result.type === "error") {
          telemetry.trackError(event.result.error.message, {
            module: "session", ownerModule: context.ownerModule, executionKind: "subagent",
            phase: context.phase, loopStage: "tool_call", errorCategory: inferToolErrorCategory(event.result.error.code),
            sessionId: context.sessionId, code: event.result.error.code, toolName: event.result.toolName,
            metadata: {
              runId: context.runId, subagentId: event.subagentId, subagentType: event.subagentType,
              toolName: event.result.toolName, toolCallId: event.result.toolCallId,
            },
          });
          return;
        }
        telemetry.trackFeatureLoopStage({
          module: "session", ownerModule: context.ownerModule, executionKind: "subagent",
          phase: context.phase, loopStage: "tool_call", outcome: "success", sessionId: context.sessionId,
          metadata: {
            runId: context.runId, subagentId: event.subagentId, subagentType: event.subagentType,
            toolName: event.result.toolName, toolCallId: event.result.toolCallId,
          },
        });
        return;
      default:
        return;
    }
  }

  private observeSubagentModelEvent(
    event: Extract<AgentEvent, { type: "subagent_model_event" }>,
    context: GatewayAgentEventTelemetryContext,
  ): void {
    const telemetry = this.telemetry!;
    if (event.event.type === "request_started") {
      telemetry.trackFeatureLoopStage({
        module: "session", ownerModule: context.ownerModule, executionKind: "subagent",
        phase: context.phase, loopStage: "model_request", outcome: "success", sessionId: context.sessionId,
        metadata: {
          runId: context.runId, provider: event.event.provider, model: event.event.model,
          ...(event.event.providerBaseUrl ? { providerBaseUrl: event.event.providerBaseUrl } : {}),
          subagentId: event.subagentId, subagentType: event.subagentType,
        },
      });
    }
    if (event.event.type === "message_end") {
      telemetry.trackFeatureLoopStage({
        module: "session", ownerModule: context.ownerModule, executionKind: "subagent",
        phase: context.phase, loopStage: "model_response", outcome: "success", sessionId: context.sessionId,
        metadata: { runId: context.runId, subagentId: event.subagentId, subagentType: event.subagentType },
      });
    }
    if (event.event.type === "error") {
      telemetry.trackError(event.event.error, {
        module: "session", ownerModule: context.ownerModule, executionKind: "subagent",
        phase: context.phase, loopStage: "model_request", errorCategory: "model_request_error",
        sessionId: context.sessionId, code: event.event.error.code,
        metadata: {
          runId: context.runId, provider: event.event.error.provider,
          subagentId: event.subagentId, subagentType: event.subagentType,
        },
      });
    }
  }
}

function inferToolErrorCategory(code: string | undefined):
  | "tool_param_error"
  | "tool_runtime_error"
  | "tool_result_parse_error" {
  if (!code) return "tool_runtime_error";
  if (/(invalid|argument|param|schema)/i.test(code)) return "tool_param_error";
  if (/(parse|json|decode|format)/i.test(code)) return "tool_result_parse_error";
  return "tool_runtime_error";
}
