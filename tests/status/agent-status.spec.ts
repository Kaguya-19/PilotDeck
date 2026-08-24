import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentStatusDetail,
  createAgentStatusHttpErrorBody,
  createVisibleErrorStatusDetail,
  isVisibleFailureStatusDetail,
  visibleStatusMessage,
} from "../../src/status/agentStatus.js";

test("agent status detail preserves contract fields and removes undefined values", () => {
  assert.deepEqual(createAgentStatusDetail({
    message: "failed",
    code: "model_error",
    scope: "turn",
    source: "agent",
    visible: false,
    detail: { retryable: true },
  }), {
    message: "failed",
    code: "model_error",
    visible: false,
    scope: "turn",
    source: "agent",
    retryable: true,
  });
});

test("HTTP status mapping chooses stable type and user hint", () => {
  assert.equal(createAgentStatusHttpErrorBody({
    event: "rate_limited",
    message: "Too many requests",
    status: 429,
    scope: "http",
    source: "web_http",
  }).error.type, "rate_limit_error");
  assert.equal(createAgentStatusHttpErrorBody({
    event: "server_error",
    message: "Unavailable",
    status: 503,
    scope: "http",
    source: "web_http",
  }).error.userHint, "The server is unavailable or returned an internal error. Retry later or check server logs.");
  assert.equal(createAgentStatusHttpErrorBody({
    event: "bad_request",
    message: "Invalid",
    status: 400,
    scope: "http",
    source: "web_http",
    userHint: "Fix it",
  }).error.userHint, "Fix it");
});

test("visible failure and fallback message helpers fail closed", () => {
  const detail = createVisibleErrorStatusDetail({
    message: "Broken",
    userHint: "Retry",
    scope: "session",
    source: "gateway",
  });
  assert.equal(isVisibleFailureStatusDetail(detail), true);
  assert.equal(isVisibleFailureStatusDetail({ ...detail, visible: false }), false);
  assert.equal(isVisibleFailureStatusDetail(null), false);
  assert.equal(visibleStatusMessage(detail, "fallback"), "Broken");
  assert.equal(visibleStatusMessage({ message: "  " }, "fallback"), "fallback");
  assert.equal(visibleStatusMessage(undefined, "fallback"), "fallback");
});
