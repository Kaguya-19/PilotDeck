import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayInteractionCoordinator } from "../../src/gateway/client/GatewayInteractionCoordinator.js";
import type { GatewayInteractionCoordinatorPort } from "../../src/gateway/client/GatewayInteractionCoordinatorPort.js";
import { GatewayElicitationBus } from "../../src/gateway/elicitation/GatewayElicitationBus.js";
import { GatewayPermissionBus } from "../../src/gateway/permission/GatewayPermissionBus.js";
import type { GatewaySessionPermissionGrantPort } from "../../src/gateway/permission/GatewaySessionPermissionRuleSetRegistry.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import { createNativeInteractionReconnectPort } from "../../src/interaction/index.js";

test("GatewayInteractionCoordinator owns reconnectable pending interactions and session grants", () => {
  const calls: string[] = [];
  const grants: GatewaySessionPermissionGrantPort = {
    grant: (sessionKey, rule) => {
      calls.push(`grant:${sessionKey}:${rule.toolName}`);
      return true;
    },
    allowRules: () => [],
    closeSession: (sessionKey) => { calls.push(`close:${sessionKey}`); },
    dispose: () => { calls.push("dispose-grants"); },
  };
  const coordinator = new GatewayInteractionCoordinator({
    permissionGrants: grants,
    onElicitationDelivered: (sessionKey, requestId) => {
      calls.push(`elicitation:${sessionKey}:${requestId}`);
    },
  });
  const sessionKey = "web:interaction-owner";
  const firstBinding = { connectionId: "connection-1", generation: 1 };
  const secondBinding = { connectionId: "connection-2", generation: 2 };
  assert.equal(coordinator.reconnect({ sessionKey, nextBinding: firstBinding }).outcome, "no_pending");

  let answer: unknown;
  let decision: unknown;
  coordinator.getElicitationBus().register(sessionKey, {
    requestId: "question-1",
    toolCallId: "call-question",
    toolName: "ask_user_question",
    resolve: (value) => { answer = value; },
    reject: (error) => assert.fail(error.message),
  });
  coordinator.getPermissionBus().register(sessionKey, {
    requestId: "permission-1",
    toolCallId: "call-permission",
    toolName: "write_file",
    resolve: (value) => { decision = value; },
    reject: (error) => assert.fail(error.message),
  });

  assert.deepEqual(coordinator.disconnect({ sessionKey, binding: firstBinding }), {
    disconnected: true,
    preserveTurn: true,
  });
  assert.equal(
    coordinator.reconnect({
      sessionKey,
      previousBinding: firstBinding,
      nextBinding: secondBinding,
    }).outcome,
    "reconnected",
  );
  assert.deepEqual(coordinator.respondElicitation({
    sessionKey,
    requestId: "question-1",
    interactionBinding: firstBinding,
    answer: { type: "cancelled", reason: "old binding" },
  }), { delivered: false });
  assert.deepEqual(coordinator.respondElicitation({
    sessionKey,
    requestId: "question-1",
    interactionBinding: secondBinding,
    answer: { type: "cancelled", reason: "new binding" },
  }), { delivered: true });
  assert.deepEqual(coordinator.decidePermission({
    sessionKey,
    requestId: "permission-1",
    interactionBinding: secondBinding,
    decision: "allow",
    remember: true,
  }), { delivered: true });
  assert.deepEqual(answer, { type: "cancelled", reason: "new binding" });
  assert.deepEqual(decision, {
    requestId: "permission-1",
    decision: "allow",
    remember: true,
    reason: undefined,
  });
  assert.deepEqual(coordinator.grantSessionPermission({ sessionKey, entry: "Write" }), {
    granted: true,
    entry: "Write",
  });
  coordinator.closeSession(sessionKey, "session_closed");
  coordinator.dispose("gateway_disposed");
  assert.deepEqual(calls, [
    `elicitation:${sessionKey}:question-1`,
    `grant:${sessionKey}:write_file`,
    `close:${sessionKey}`,
    "dispose-grants",
  ]);
});

test("InProcessGateway delegates live interaction state to an injected coordinator", async () => {
  const calls: string[] = [];
  const reconnect = createNativeInteractionReconnectPort();
  const elicitationBus = new GatewayElicitationBus(reconnect);
  const permissionBus = new GatewayPermissionBus(reconnect);
  const coordinator: GatewayInteractionCoordinatorPort = {
    getElicitationBus: () => elicitationBus,
    getPermissionBus: () => permissionBus,
    getReconnectPort: () => reconnect,
    getBinding: () => undefined,
    reconnect: () => {
      calls.push("reconnect");
      return { outcome: "no_pending", requests: [] };
    },
    reconnectForTurn: () => ({ outcome: "no_pending", requests: [] }),
    disconnect: () => {
      calls.push("disconnect");
      return { disconnected: true, preserveTurn: false };
    },
    rejectPendingTurn: () => undefined,
    closeSession: (sessionKey, reason) => { calls.push(`close:${sessionKey}:${reason}`); },
    respondElicitation: () => {
      calls.push("respond");
      return { delivered: true };
    },
    decidePermission: () => {
      calls.push("decide");
      return { delivered: true };
    },
    grantSessionPermission: () => {
      calls.push("grant");
      return { granted: true, entry: "Write" };
    },
    sessionAllowRules: () => [],
    dispose: (reason) => { calls.push(`dispose:${reason}`); },
  };
  const router = { close: async () => { calls.push("router-close"); } } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, { interactionCoordinator: coordinator });

  assert.equal(gateway.getElicitationBus(), elicitationBus);
  assert.equal(gateway.getPermissionBus(), permissionBus);
  assert.deepEqual(gateway.reconnectInteraction({
    sessionKey: "web:injected-interaction",
    nextBinding: { connectionId: "connection-1", generation: 1 },
  }), { outcome: "no_pending", requests: [] });
  assert.deepEqual(gateway.disconnectInteraction({
    sessionKey: "web:injected-interaction",
    binding: { connectionId: "connection-1", generation: 1 },
  }), { disconnected: true, preserveTurn: false });
  assert.deepEqual(await gateway.respondElicitation({
    sessionKey: "web:injected-interaction",
    requestId: "question-1",
    answer: { type: "cancelled", reason: "test" },
  }), { delivered: true });
  assert.deepEqual(await gateway.permissionDecide({
    sessionKey: "web:injected-interaction",
    requestId: "permission-1",
    decision: "deny",
  }), { delivered: true });
  assert.deepEqual(await gateway.grantSessionPermission({
    sessionKey: "web:injected-interaction",
    entry: "Write",
  }), { granted: true, entry: "Write" });
  await gateway.closeSession({ sessionKey: "web:injected-interaction", reason: "test_close" });
  gateway.dispose("test_dispose");

  assert.deepEqual(calls, [
    "reconnect",
    "disconnect",
    "respond",
    "decide",
    "grant",
    "router-close",
    "close:web:injected-interaction:test_close",
    "dispose:test_dispose",
  ]);
});
