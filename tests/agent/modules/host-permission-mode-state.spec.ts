import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { HostPermissionModeState } from "../../../src/agent/modules/permission/hostPermissionModeState.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";

test("host permission mode state mirrors native enter/exit semantics and ignores failed results", () => {
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test",
    cwd: "/workspace",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/workspace", canPrompt: false }),
  };
  const state = new HostPermissionModeState(config);

  state.applyTurnInput({ permissionMode: "plan", basePermissionMode: "bypassPermissions" });
  assert.equal(config.permissionMode, "plan");
  assert.equal(config.permissionContext.mode, "plan");
  assert.equal(config.permissionModeBeforePlan, "bypassPermissions");

  state.applyCapabilityResults([toolFailure({ requestedMode: "default" })]);
  assert.equal(config.permissionMode, "plan");

  state.applyCapabilityResults([toolSuccess({ requestedMode: "default" })]);
  assert.equal(config.permissionMode, "bypassPermissions");
  assert.equal(config.permissionContext.mode, "bypassPermissions");
  assert.equal(config.permissionModeBeforePlan, undefined);

  state.applyCapabilityResults([toolSuccess({ requestedMode: "not-a-mode" })]);
  assert.equal(config.permissionMode, "bypassPermissions");
});

function toolSuccess(data: unknown) {
  return {
    type: "success" as const,
    toolCallId: "call",
    toolName: "mode",
    content: [],
    data,
    startedAt: "2026-09-12T00:00:00.000Z",
    completedAt: "2026-09-12T00:00:00.001Z",
  };
}

function toolFailure(data: unknown) {
  return {
    type: "error" as const,
    toolCallId: "call",
    toolName: "mode",
    content: [],
    error: { code: "tool_execution_failed" as const, message: "failed" },
    metadata: { data },
    startedAt: "2026-09-12T00:00:00.000Z",
    completedAt: "2026-09-12T00:00:00.001Z",
  };
}
