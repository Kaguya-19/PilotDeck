import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayTurnReplacementCoordinator } from "../../src/gateway/client/GatewayTurnReplacementCoordinator.js";
import type { GatewayTurnReplacementCoordinatorPort } from "../../src/gateway/client/GatewayTurnReplacementCoordinatorPort.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("GatewayTurnReplacementCoordinator preserves the durable-finalizer configuration error", async () => {
  let replaced = false;
  const coordinator = new GatewayTurnReplacementCoordinator({
    storage: {
      replaceLastTurn: async (input) => {
        replaced = true;
        return {
          sessionKey: input.sessionKey,
          replacedTurnId: input.expectedTurnId,
          removedEntryCount: 1,
          transactionId: "99999999-9999-4999-8999-999999999999",
        };
      },
    },
    session: {
      activeTurnRunId: () => undefined,
      hasActiveTurn: () => false,
      abortExpectedTurn: async () => undefined,
      closeSession: async () => undefined,
    },
    timeoutMs: 10,
  });

  await assert.rejects(
    coordinator.replaceLastTurn({
      sessionKey: "web:s_missing_finalizer",
      expectedTurnId: "turn-old",
      replacementTurnId: "turn-new",
    }),
    /finalize_last_turn_replacement is required when replace_last_turn is configured/,
  );
  assert.equal(replaced, false);
});

test("GatewayTurnReplacementCoordinator keeps live coordination separate from durable storage", async () => {
  const calls: string[] = [];
  const coordinator = new GatewayTurnReplacementCoordinator({
    storage: {
      replaceLastTurn: async (input) => {
        calls.push("replace");
        return {
          sessionKey: input.sessionKey,
          replacedTurnId: input.expectedTurnId,
          removedEntryCount: 1,
          transactionId: "88888888-8888-4888-8888-888888888888",
        };
      },
      finalizeLastTurnReplacement: async (input) => {
        calls.push(`finalize:${input.action}`);
        return input;
      },
    },
    session: {
      activeTurnRunId: () => "turn-old",
      hasActiveTurn: () => false,
      abortExpectedTurn: async () => { calls.push("abort"); },
      closeSession: async () => { calls.push("close"); },
    },
    timeoutMs: 10,
  });

  await coordinator.replaceLastTurn({
    sessionKey: "web:s_coordinated",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-new",
  });
  assert.deepEqual(calls, ["abort", "close", "replace"]);
  assert.equal(coordinator.claimForSubmit("web:s_coordinated", "turn-new"), "claimed");
  await coordinator.commitAcceptedInput("web:s_coordinated", "turn-new");
  assert.deepEqual(calls, ["abort", "close", "replace", "finalize:commit"]);
});

test("InProcessGateway delegates replacement and transcript reservations to an injected coordinator", async () => {
  const calls: string[] = [];
  const coordinator: GatewayTurnReplacementCoordinatorPort = {
    reserveTranscriptWrite: (_sessionKey, operation) => { calls.push(`reserve:${operation}`); },
    releaseTranscriptWrite: () => { calls.push("release"); },
    hasTranscriptWriteReservation: () => false,
    replaceLastTurn: async (input) => {
      calls.push("replace");
      return {
        sessionKey: input.sessionKey,
        replacedTurnId: input.expectedTurnId,
        removedEntryCount: 1,
        transactionId: "77777777-7777-4777-8777-777777777777",
      };
    },
    finalizeLastTurnReplacement: async (input) => {
      calls.push(`finalize:${input.action}`);
      return input;
    },
    claimForSubmit: () => "none",
    releaseSubmitClaim: () => undefined,
    commitAcceptedInput: async () => undefined,
    dispose: () => { calls.push("dispose"); },
  };
  const gateway = new InProcessGateway({} as SessionRouter, {
    turnReplacementCoordinator: coordinator,
    sessionModelSet: async (input) => ({
      sessionKey: input.sessionKey,
      projectKey: input.projectKey,
      saved: input.selection,
      effective: { provider: "openai", model: "gpt-test", source: "session" },
    }),
  });

  await gateway.replaceLastTurn({
    sessionKey: "web:s_injected",
    expectedTurnId: "turn-old",
    replacementTurnId: "turn-new",
  });
  await gateway.sessionModelSet({
    sessionKey: "web:s_injected",
    projectKey: "/tmp/project",
    selection: { mode: "model", provider: "openai", model: "gpt-test" },
  });
  await gateway.finalizeLastTurnReplacement({
    sessionKey: "web:s_injected",
    transactionId: "77777777-7777-4777-8777-777777777777",
    action: "commit",
  });
  gateway.dispose();

  assert.deepEqual(calls, [
    "replace",
    "reserve:change the session model",
    "release",
    "finalize:commit",
    "dispose",
  ]);
});
