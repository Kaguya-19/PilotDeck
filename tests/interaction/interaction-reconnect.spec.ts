import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeInteractionReconnectPort,
  type InteractionConnectionBinding,
} from "../../src/interaction/index.js";
import { GatewayElicitationBus } from "../../src/gateway/elicitation/GatewayElicitationBus.js";
import { GatewayPermissionBus } from "../../src/gateway/permission/GatewayPermissionBus.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

const first: InteractionConnectionBinding = { connectionId: "connection-a", generation: 1 };
const second: InteractionConnectionBinding = { connectionId: "connection-b", generation: 2 };

test("interaction reconnect restores pending requests only with the exact previous binding", () => {
  const port = createNativeInteractionReconnectPort();
  const registration = port.register({
    ownerId: "session-1",
    requestId: "question-1",
    kind: "question",
    toolCallId: "call-1",
    toolName: "ask_user_question",
    payload: { question: "Proceed?" },
  });

  assert.deepEqual(port.reconnect("session-1", first), {
    outcome: "initial",
    binding: first,
    requests: [{
      ownerId: "session-1",
      requestId: "question-1",
      kind: "question",
      toolCallId: "call-1",
      toolName: "ask_user_question",
      payload: { question: "Proceed?" },
      binding: first,
    }],
  });
  assert.equal(port.disconnect("session-1", first), true);
  assert.deepEqual(port.reconnect("session-1", second, { connectionId: "wrong", generation: 1 }), {
    outcome: "stale_binding",
    binding: first,
    requests: [],
  });
  assert.deepEqual(port.reconnect("session-1", second, first).requests[0]?.binding, second);
  assert.equal(port.isCurrent("session-1", "question", "question-1", first), false);
  assert.equal(port.isCurrent("session-1", "question", "question-1", second), true);
  registration.dispose();
  assert.deepEqual(port.snapshot("session-1"), []);
});

test("reconnect port rejects duplicate request identity across one interaction kind", () => {
  const port = createNativeInteractionReconnectPort();
  const firstRegistration = port.register({ ownerId: "session-1", requestId: "same", kind: "permission" });
  assert.throws(
    () => port.register({ ownerId: "session-1", requestId: "same", kind: "permission" }),
    /already pending/,
  );
  assert.doesNotThrow(() => port.register({ ownerId: "session-1", requestId: "same", kind: "question" }));
  firstRegistration.dispose();
});

test("gateway buses project reconnect state and reject stale-bound responses", () => {
  const elicitation = new GatewayElicitationBus();
  const permission = new GatewayPermissionBus();
  let answered = 0;
  let decided = 0;
  elicitation.register("session-1", {
    requestId: "question-1",
    toolCallId: "call-1",
    toolName: "ask_user_question",
    resolve: () => { answered += 1; },
    reject: () => undefined,
  });
  permission.register("session-1", {
    requestId: "permission-1",
    toolCallId: "call-2",
    toolName: "write_file",
    resolve: () => { decided += 1; },
    reject: () => undefined,
  });

  assert.equal(elicitation.reconnect("session-1", first).outcome, "initial");
  assert.equal(permission.reconnect("session-1", first).outcome, "initial");
  assert.equal(elicitation.disconnect("session-1", first), true);
  assert.equal(permission.disconnect("session-1", first), true);
  assert.equal(elicitation.reconnect("session-1", second, first).requests.length, 1);
  assert.equal(permission.reconnect("session-1", second, first).requests.length, 1);
  assert.equal(elicitation.consume("session-1", "question-1", first), undefined);
  assert.equal(permission.consume("session-1", "permission-1", first), undefined);
  const question = elicitation.consume("session-1", "question-1", second);
  const decision = permission.consume("session-1", "permission-1", second);
  question?.resolve({ type: "cancelled", reason: "reconnected" });
  decision?.resolve({ requestId: "permission-1", decision: "deny", outcome: "reconnect" });
  assert.equal(answered, 1);
  assert.equal(decided, 1);
});

test("gateway reconnect preserves pending interactions through disconnect and rejects old binding replies", async () => {
  const gateway = new InProcessGateway({} as SessionRouter);
  const questions = gateway.getElicitationBus();
  let resolved = 0;
  questions.register("session-1", {
    requestId: "question-1",
    toolCallId: "call-1",
    toolName: "ask_user_question",
    resolve: () => { resolved += 1; },
    reject: () => undefined,
  });
  assert.equal(gateway.reconnectInteraction({ sessionKey: "session-1", nextBinding: first }).outcome, "initial");
  assert.deepEqual(gateway.disconnectInteraction({ sessionKey: "session-1", binding: first }), {
    disconnected: true,
    preserveTurn: true,
  });
  const resumed = gateway.reconnectInteraction({
    sessionKey: "session-1",
    previousBinding: first,
    nextBinding: second,
  });
  assert.equal(resumed.outcome, "reconnected");
  assert.equal(resumed.requests.length, 1);
  assert.deepEqual(await gateway.respondElicitation({
    sessionKey: "session-1",
    requestId: "question-1",
    interactionBinding: first,
    answer: { type: "cancelled", reason: "old" },
  }), { delivered: false });
  assert.deepEqual(await gateway.respondElicitation({
    sessionKey: "session-1",
    requestId: "question-1",
    interactionBinding: second,
    answer: { type: "cancelled", reason: "reconnect" },
  }), { delivered: true });
  assert.equal(resolved, 1);
});

test("new turns cannot replace a disconnected interaction binding without reconnecting", async () => {
  const gateway = new InProcessGateway({} as SessionRouter);
  gateway.getElicitationBus().register("session-1", {
    requestId: "question-1",
    toolCallId: "call-1",
    toolName: "ask_user_question",
    resolve: () => undefined,
    reject: () => undefined,
  });
  gateway.reconnectInteraction({ sessionKey: "session-1", nextBinding: first });
  gateway.disconnectInteraction({ sessionKey: "session-1", binding: first });
  gateway.reconnectInteraction({ sessionKey: "session-1", previousBinding: first, nextBinding: second });

  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "session-1",
    channelKey: "web",
    projectKey: "/tmp/project",
    message: "must reconnect first",
    interactionBinding: first,
  })) {
    events.push(event);
  }
  assert.deepEqual(events, [{
    type: "error",
    code: "interaction_reconnect_required",
    message: "This session has reconnectable interaction requests. Reconnect with the previous binding before submitting a new turn.",
    recoverable: true,
  }]);
});

test("gateway disposal settles pending interactions before releasing reconnect state", async () => {
  const gateway = new InProcessGateway({} as SessionRouter);
  let questionFailure: Error | undefined;
  let permissionDecision: string | undefined;
  gateway.getElicitationBus().register("session-1", {
    requestId: "question-1",
    toolCallId: "call-1",
    toolName: "ask_user_question",
    resolve: () => undefined,
    reject: (error) => { questionFailure = error; },
  });
  gateway.getPermissionBus().register("session-1", {
    requestId: "permission-1",
    toolCallId: "call-2",
    toolName: "write_file",
    resolve: (decision) => { permissionDecision = decision.decision; },
    reject: () => undefined,
  });
  gateway.reconnectInteraction({ sessionKey: "session-1", nextBinding: first });

  gateway.dispose("shutdown");

  assert.equal(questionFailure?.message, "shutdown");
  assert.equal(permissionDecision, "deny");
  assert.deepEqual(gateway.getElicitationBus().snapshot("session-1"), []);
  assert.equal(gateway.getInteractionBinding("session-1"), undefined);
});
