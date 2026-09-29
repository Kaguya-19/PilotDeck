import assert from "node:assert/strict";
import test from "node:test";

import { createHostPermissionDecisionPort } from "../../../src/agent/modules/permission/index.js";
import type { PermissionDecisionPort } from "../../../src/permission/index.js";
import { ToolRuntime, ToolRegistry, type PilotDeckToolDefinition } from "../../../src/tool/index.js";

const tool: PilotDeckToolDefinition = {
  name: "write",
  description: "write",
  kind: "custom",
  inputSchema: { type: "object" },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  requiresUserInteraction: () => true,
  execute: async () => ({ content: [{ type: "text", text: "executed" }] }),
};

const runtimeContext = {
  sessionId: "session-1",
  turnId: "turn-1",
  cwd: "/workspace",
  permissionMode: "default" as const,
  permissionContext: {
    mode: "default" as const,
    rules: { allow: [], deny: [], ask: [] },
    cwd: "/workspace",
    additionalWorkingDirectories: [],
    canPrompt: true,
    bypassAvailable: false,
  },
};

test("ToolRuntime consumes an injected PermissionDecisionPort", async () => {
  const registry = new ToolRegistry();
  registry.register(tool);
  let decisions = 0;
  const permission: PermissionDecisionPort = {
    async decide() {
      decisions += 1;
      return {
        type: "deny",
        reason: { type: "runtime", message: "denied by injected port" },
        message: "denied by injected port",
      };
    },
  };

  const result = await new ToolRuntime(registry, permission).execute(
    { id: "call-1", name: "write", input: {} },
    runtimeContext,
  );

  assert.equal(decisions, 1);
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_denied");
});

test("host permission consumer maps descriptors and execution context", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const permission = createHostPermissionDecisionPort(async (request) => {
    calls.push(request as unknown as Record<string, unknown>);
    return {
      kind: "response",
      messageId: "response-1",
      inReplyTo: "call-1",
      ok: true,
      payload: {
        decision: {
          type: "allow",
          reason: { type: "runtime", message: "allowed by host" },
        },
      },
    };
  }, { runId: "run-1", operationId: "operation-1", idempotencyKey: "stable-1" }, { uuid: () => "fixed" });

  const decision = await permission.decide(tool, { path: "file.txt" }, runtimeContext, "call-1");

  assert.equal(decision.type, "allow");
  assert.equal(calls[0]?.module, "permission");
  assert.equal(calls[0]?.requestId, "permission-decide-fixed");
  assert.equal(calls[0]?.runId, "run-1");
  assert.equal(calls[0]?.operationId, "operation-1");
  const payload = calls[0]?.payload as Record<string, unknown>;
  assert.equal(payload.operation, "decide");
  assert.equal(payload.toolCallId, "call-1");
  assert.deepEqual(payload.tool, {
    name: "write",
    description: "write",
    kind: "custom",
    inputSchema: { type: "object" },
    readOnly: false,
    requiresUserInteraction: true,
  });
});

test("host permission consumer fails closed on malformed decisions", async () => {
  const permission = createHostPermissionDecisionPort(async () => ({
    kind: "response",
    messageId: "response-1",
    inReplyTo: "call-1",
    ok: true,
    payload: { decision: { type: "allow" } },
  }), { runId: "run-1", operationId: "operation-1" });

  await assert.rejects(
    () => permission.decide(tool, {}, runtimeContext, "call-1"),
    (error: Error & { code?: string }) => error.code === "INVALID_PERMISSION_RESPONSE",
  );
});

test("host permission consumer preserves module failure code", async () => {
  const permission = createHostPermissionDecisionPort(async () => ({
    kind: "response",
    messageId: "response-1",
    inReplyTo: "call-1",
    ok: false,
    code: "PERMISSION_UNAVAILABLE",
    error: { message: "permission service unavailable" },
  }), { runId: "run-1", operationId: "operation-1" });

  await assert.rejects(
    () => permission.decide(tool, {}, runtimeContext, "call-1"),
    (error: Error & { code?: string }) => error.message === "permission service unavailable" && error.code === "PERMISSION_UNAVAILABLE",
  );
});
