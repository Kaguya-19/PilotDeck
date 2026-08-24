import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { mapAgentEvent, normalizeGatewayModeForLegacyInput, normalizeGatewayRunMode } from "../../src/gateway/client/InProcessGateway.js";

const base = { sessionId: "s", turnId: "t" };
const successResult = {
  type: "success",
  toolCallId: "call",
  toolName: "demo",
  content: [{ type: "text", text: "ok" }],
  startedAt: "",
  completedAt: "",
};

function mapped(event: unknown): Array<{ type: string; runId?: string; event?: string }> {
  return mapAgentEvent({ ...base, ...(event as object) } as AgentEvent, "run-1") as Array<{ type: string; runId?: string; event?: string }>;
}

test("mapAgentEvent covers lifecycle, model, tool and recovery contracts", () => {
  const cases: Array<[string, unknown, string | undefined]> = [
    ["turn_started", { type: "turn_started" }, "turn_started"],
    ["model_request_started", { type: "model_request_started", model: "m", provider: "p" }, "model_request_started"],
    ["model text", { type: "model_event", event: { type: "text_delta", text: "hello" } }, "assistant_text_delta"],
    ["model thinking", { type: "model_event", event: { type: "thinking_delta", text: "reason" } }, "assistant_thinking_delta"],
    ["model error is internal", { type: "model_event", event: { type: "error", error: { code: "server_error", message: "down" } } }, undefined],
    ["tool calls", { type: "tool_calls_detected", calls: [{ id: "call", name: "bash", input: { command: "pwd" } }] }, "tool_call_started"],
    ["tool result", { type: "tool_result", result: successResult }, "tool_call_finished"],
    ["file artifacts", { type: "file_artifacts", artifacts: [] }, "file_artifacts"],
    ["mode change", { type: "mode_change_requested", mode: "plan" }, "plan_mode_changed"],
    ["turn completed", { type: "turn_completed", result: { stopReason: "completed", usage: {} } }, "turn_completed"],
    ["turn failed", { type: "turn_failed", error: { code: "failed", message: "no" } }, "error"],
    ["token cap", { type: "token_cap_adjusted", provider: "p", model: "m", cap: "output", next: 10, reason: "retry" }, "agent_status"],
    ["empty output", { type: "empty_output_recovery", provider: "p", model: "m", finishReason: "stop", nextMaxOutputTokens: 10 }, "agent_status"],
    ["model recovery failed", { type: "model_recovery_failed", provider: "p", model: "m", error: { code: "server_error", message: "down" } }, "agent_status"],
    ["aborted", { type: "session_aborted", reason: "stop" }, "error"],
    ["compaction started", { type: "compact_started", compactionId: "c", trigger: "size", preTokens: 10 }, "agent_status"],
    ["compaction completed", { type: "compact_completed", compactionId: "c", trigger: "size", status: "success", preTokens: 10, postTokens: 4 }, "agent_status"],
    ["context budget", { type: "context_budget", snapshot: { tokens: 5, maxContextTokens: 10, warningRatio: .8, blockingRatio: .9, ratio: .5, state: "ok" } }, "context_budget"],
    ["warning", { type: "warning", code: "warn", message: "careful" }, "agent_status"],
    ["status", { type: "agent_status", event: "progress", detail: { value: 1 } }, "agent_status"],
    ["continued", { type: "turn_continued", reason: "tool_call" }, "agent_status"],
    ["subagent started", { type: "subagent_started", subagentId: "a", subagentType: "explore" }, "agent_status"],
    ["subagent completed", { type: "subagent_completed", subagentId: "a", subagentType: "explore", success: true, durationMs: 1 }, "agent_status"],
    ["subagent status", { type: "subagent_status", subagentId: "a", status: "running" }, "agent_status"],
    ["retry progress", { type: "retry_progress", detail: { attempt: 1, maxAttempts: 2, delayMs: 0, reason: "rate", provider: "p", model: "m" } }, "agent_status"],
  ];
  for (const [name, event, expected] of cases) {
    const output = mapped(event);
    assert.equal(output[0]?.type, expected, name);
    if (expected) assert.equal(output[0]?.runId, "run-1", name);
  }
  for (const type of ["session_ended", "user_prompt_submitted", "setup_completed", "instructions_loaded", "stop_requested", "stop_failure", "elicitation_resolved", "pre_tool_execute", "post_tool_execute", "permission_requested", "permission_denied", "elicitation_requested"]) {
    assert.deepEqual(mapped({ type }), [], type);
  }
});

test("mapAgentEvent preserves tool/media details and bounded data", () => {
  const image = { type: "image", mimeType: "image/png", data: "abc", bytes: 3 };
  const file = { type: "file", path: "/tmp/out.txt", mimeType: "text/plain", description: "output" };
  const result = mapped({ type: "tool_result", result: { ...successResult, toolName: "render", content: [image, file], data: { text: "ok" } } });
  assert.equal(result[0]?.type, "tool_call_finished");
  assert.equal(result[1]?.type, "assistant_attachment");
  assert.equal(result[2]?.type, "assistant_attachment");
  assert.equal((result[0] as { data?: unknown }).data !== undefined, true);

  const error = mapped({ type: "tool_result", result: { ...successResult, type: "error", error: { code: "invalid_arguments", message: "bad" } } });
  assert.equal((error[0] as { ok?: boolean; errorCode?: string }).ok, false);
  assert.equal((error[0] as { errorCode?: string }).errorCode, "invalid_arguments");

  const projected = mapped({ type: "tool_results_projected", message: { role: "user", content: [
    { type: "tool_result_reference", toolCallId: "call", path: "/tmp/result.txt" },
    { type: "media_reference", toolCallId: "image-call", path: "/tmp/image.png", mediaType: "image", mimeType: "image/png", originalBytes: 10, reason: "media_result" },
    { type: "media_reference", toolCallId: "too-large", path: "/tmp/large.png", mediaType: "image", mimeType: "image/png", originalBytes: 20, reason: "media_result_too_large" },
    { type: "tool_result", toolCallId: "text-call", content: [{ type: "text", text: "full" }] },
  ] } });
  assert.deepEqual(projected.map((event) => event.type), [
    "tool_result_detail_available",
    "tool_result_detail_available",
    "assistant_attachment",
    "tool_result_detail_available",
    "tool_result_detail_available",
  ]);
});

test("mapAgentEvent covers subagent model/tool variants and context details", () => {
  for (const event of [
    { type: "subagent_model_event", subagentId: "a", subagentType: "explore", event: { type: "text_delta", text: "x" } },
    { type: "subagent_model_event", subagentId: "a", subagentType: "explore", event: { type: "thinking_delta", text: "x" } },
    { type: "subagent_model_event", subagentId: "a", subagentType: "explore", event: { type: "error", error: { code: "failed", message: "x" } } },
  ]) {
    assert.equal(mapped(event)[0]?.type, "agent_status");
  }
  assert.equal(mapped({ type: "subagent_tool_calls_detected", subagentId: "a", subagentType: "explore", calls: [{ id: "call", name: "bash", input: {} }] })[0]?.event, "subagent_tool_call_started");
  assert.equal(mapped({ type: "subagent_tool_result", subagentId: "a", subagentType: "explore", result: successResult })[0]?.event, "subagent_tool_result");
  assert.equal(mapped({ type: "subagent_tool_result", subagentId: "a", subagentType: "explore", result: { ...successResult, type: "error", error: { code: "parse_error", message: "bad" } } })[0]?.event, "subagent_tool_result");
  const budget = mapped({ type: "context_budget", snapshot: { tokens: 5, totalContextTokens: 20, effectiveContextTokens: 15, reservedOutputTokens: 5, maxContextTokens: 15, warningRatio: .8, blockingRatio: .9, ratio: .33, state: "ok" } });
  assert.equal((budget[0] as { total?: number }).total, 20);
});

test("Gateway mode normalizers preserve legacy values and fail closed", () => {
  for (const value of [undefined, null, "", "default", "plan", "bypassPermissions", "other"]) {
    const normalized = normalizeGatewayModeForLegacyInput(value);
    assert.equal(normalized, value === "default" || value === "plan" || value === "bypassPermissions" ? value : undefined);
  }
  assert.equal(normalizeGatewayRunMode(undefined), undefined);
  assert.equal(normalizeGatewayRunMode("agent"), "agent");
  assert.equal(normalizeGatewayRunMode("plan"), "plan");
  assert.equal(normalizeGatewayRunMode("ask"), "ask");
  assert.equal(normalizeGatewayRunMode("unknown"), "agent");
});
