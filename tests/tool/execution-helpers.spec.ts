import assert from "node:assert/strict";
import test from "node:test";

import { buildToolErrorRecovery } from "../../src/tool/execution/errorRecovery.js";
import { formatValidationError } from "../../src/tool/execution/formatValidationError.js";
import { validateToolInput } from "../../src/tool/execution/validateToolInput.js";

function recovery(code: Parameters<typeof buildToolErrorRecovery>[0]["code"], toolName: string, message: string, details?: Record<string, unknown>) {
  return buildToolErrorRecovery({ code, toolName, message, cwd: "/workspace", permissionMode: "default", details });
}

test("validateToolInput covers nested objects, arrays, enums, null and unknown properties", () => {
  const schema = {
    type: "object" as const,
    required: ["name", "items"],
    properties: {
      name: { type: "string" },
      mode: { enum: ["fast", "safe"] },
      items: { type: "array", items: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } },
      nullable: { type: ["string", "null"] },
    },
    additionalProperties: false,
  };
  const result = validateToolInput({ name: 4, mode: "slow", items: [{ count: 1.2 }, {}], nullable: null, extra: true }, schema);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.issues.map((issue) => issue.code), ["unknown_property", "invalid_type", "invalid_enum", "invalid_type", "required"]);
  }
  assert.equal(validateToolInput({ name: "ok", items: [], nullable: null }, schema).ok, true);
  assert.equal(validateToolInput(null, { type: "object" }).ok, false);
});

test("formatValidationError explains each issue and output truncation", () => {
  const issues = [
    { path: "$.name", code: "required" as const, message: "name is required" },
    { path: "$.mode", code: "invalid_type" as const, message: "mode must be string" },
    { path: "$.extra", code: "unknown_property" as const, message: "extra is not allowed" },
    { path: "$.kind", code: "invalid_enum" as const, message: "kind must be fast" },
    { path: "$.other", code: "invalid_schema" as const, message: "bad schema" },
  ];
  const text = formatValidationError("write_file", issues, { maxOutputTokens: 256, outputTruncated: true });
  assert.match(text, /following issues/);
  assert.match(text, /required parameter `name`/);
  assert.match(text, /invalid type/);
  assert.match(text, /unexpected parameter `extra`/);
  assert.match(text, /invalid value/);
  assert.match(text, /output being truncated/);
  assert.match(formatValidationError("echo", []), /echo input is invalid/);
  assert.match(formatValidationError("write_file", [{ path: "$.content", code: "required", message: "missing" }]), /smaller but valid draft/);
});

test("recovery classifies common error codes and preserves retry guidance", () => {
  const cases = [
    ["tool_not_found", "switch_tool"],
    ["tool_unavailable", "tool_unavailable"],
    ["result_too_large", "reduce_scope"],
    ["permission_denied", "ask_user"],
    ["permission_required", "ask_user"],
    ["permission_cancelled", "ask_user"],
    ["path_not_allowed", "ask_user"],
    ["file_not_found", "fix_input"],
    ["file_conflict", "fix_input"],
    ["unsupported_tool", "switch_tool"],
    ["setup_required", "ask_user"],
    ["plan_mode_violation", "switch_tool"],
    ["ask_mode_violation", "switch_tool"],
    ["tool_timeout", "retry_later"],
    ["tool_aborted", "retry_later"],
  ] as const;
  for (const [code, failureClass] of cases) {
    const result = recovery(code, "demo", `${code} happened`);
    assert.equal(result.advice.failureClass, failureClass, code);
    assert.match(result.message, new RegExp(`TOOL_ERROR\\[${code}\\]`));
  }
});

test("recovery classifies bash failures from stderr and web fetch by stage/status", () => {
  assert.equal(recovery("tool_execution_failed", "bash", "command failed", { stderr: "Permission denied" }).advice.failureClass, "ask_user");
  assert.equal(recovery("tool_execution_failed", "bash", "command failed", { stderr: "ENOENT" }).advice.failureClass, "fix_input");
  assert.equal(recovery("tool_execution_failed", "bash", "command failed", { stderr: "timed out" }).advice.failureClass, "retry_later");
  assert.equal(recovery("tool_execution_failed", "bash", "command failed", { stderr: "EADDRINUSE" }).advice.failureClass, "environment_issue");
  assert.equal(recovery("tool_execution_failed", "bash", "command failed", { stderr: "command not found" }).advice.failureClass, "environment_issue");
  assert.equal(recovery("tool_execution_failed", "web_fetch", "HTTP failed", { stage: "http_fetch", status: 401 }).advice.failureClass, "ask_user");
  assert.equal(recovery("tool_execution_failed", "web_fetch", "HTTP failed", { stage: "http_fetch", status: 404 }).advice.failureClass, "fix_input");
  assert.equal(recovery("tool_execution_failed", "web_fetch", "HTTP failed", { stage: "http_fetch", status: 429 }).advice.failureClass, "retry_later");
  assert.equal(recovery("tool_execution_failed", "web_fetch", "HTTP failed", { stage: "http_fetch", status: 500 }).advice.failureClass, "retry_later");
  assert.equal(recovery("tool_execution_failed", "web_fetch", "HTTP failed", { stage: "http_fetch", status: 418 }).advice.failureClass, "environment_issue");
  assert.equal(recovery("tool_execution_failed", "web_fetch", "model failed", { stage: "secondary_model" }).advice.failureClass, "retry_later");
});

test("recovery exposes bounded provider evidence and invalid-input branches", () => {
  const result = recovery("invalid_tool_input", "edit_file", "old_string not found", {
    issues: [{ path: "$.old_string", code: "invalid_schema", message: "old_string does not appear in the target file" }, { code: "future", message: "unknown" }, null],
    status: 409,
    statusText: "Conflict",
    retryAfterMs: 10,
    bodyPreview: "preview",
    userHint: "hint",
    stderr: "diagnostic line",
  });
  assert.equal(result.advice.salientEvidence?.length, 2);
  assert.match(result.message, /Call read_file/);
  const empty = recovery("invalid_tool_input", "echo", "\nTOOL_ERROR[invalid_tool_input]\n");
  assert.ok(empty.advice.summary.length > 0);
});
