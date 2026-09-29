import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/index.js";
import { GatewayAgentEventTelemetryObserver } from "../../src/gateway/client/GatewayAgentEventTelemetryObserver.js";
import type { TelemetryClient } from "../../src/telemetry/index.js";

test("GatewayAgentEventTelemetryObserver maps model and tool events without owning telemetry lifecycle", () => {
  const stages: unknown[] = [];
  const errors: Array<{ error: unknown; input: unknown }> = [];
  const telemetry = {
    trackFeatureLoopStage(input: unknown) { stages.push(input); },
    trackError(error: unknown, input: unknown) { errors.push({ error, input }); },
  } as unknown as TelemetryClient;
  const observer = new GatewayAgentEventTelemetryObserver({ telemetry });
  const context = {
    sessionId: "session-1",
    runId: "run-1",
    channelKey: "web",
    permissionMode: "default",
    ownerModule: "session" as const,
    executionKind: "user_session" as const,
  };

  observer.observe({
    type: "model_event",
    sessionId: "session-1",
    turnId: "turn-1",
    event: {
      type: "request_started",
      provider: "test-provider",
      model: "test-model",
      providerBaseUrl: "https://models.test",
    },
  } as unknown as AgentEvent, context);
  observer.observe({
    type: "tool_result",
    sessionId: "session-1",
    turnId: "turn-1",
    result: {
      type: "error",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [],
      error: { code: "invalid_argument", message: "bad input" },
      startedAt: "2026-09-10T00:00:00.000Z",
      completedAt: "2026-09-10T00:00:01.000Z",
    },
  } as unknown as AgentEvent, context);

  assert.deepEqual(stages, [{
    module: "session",
    ownerModule: "session",
    executionKind: "user_session",
    phase: undefined,
    loopStage: "model_request",
    outcome: "success",
    sessionId: "session-1",
    metadata: {
      runId: "run-1",
      provider: "test-provider",
      model: "test-model",
      providerBaseUrl: "https://models.test",
      permissionMode: "default",
      channelKey: "web",
    },
  }]);
  assert.deepEqual(errors, [{
    error: "bad input",
    input: {
      module: "session",
      ownerModule: "session",
      executionKind: "user_session",
      phase: undefined,
      loopStage: "tool_call",
      errorCategory: "tool_param_error",
      sessionId: "session-1",
      code: "invalid_argument",
      toolName: "bash",
      metadata: { runId: "run-1", toolName: "bash", toolCallId: "tool-1" },
    },
  }]);
});
