import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_INTERACTION_PROFILE_NAME,
  createDefaultInteractionPolicy,
  createProfiledPermissionDecisionPort,
  isInteractionProfileName,
  resolveInteractionProfile,
} from "../../src/interaction/index.js";
import type { PermissionDecisionPort } from "../../src/permission/index.js";

const askedPermission = {
  type: "ask" as const,
  reason: { type: "runtime" as const, message: "approval required" },
  request: {
    toolCallId: "call-1",
    toolName: "write_file",
    inputSummary: "{}",
    reason: { type: "runtime" as const, message: "approval required" },
    options: [{ id: "allow_once" as const, label: "Allow once" }],
  },
};

test("interaction profiles select providers without owning interaction state", () => {
  assert.equal(DEFAULT_INTERACTION_PROFILE_NAME, "interactive");
  assert.equal(isInteractionProfileName("headless"), true);
  assert.equal(isInteractionProfileName("unsupported"), false);
  assert.equal(resolveInteractionProfile(undefined).name, "interactive");
  assert.deepEqual(resolveInteractionProfile("interactive"), {
    name: "interactive",
    policyMode: "interactive",
    canPrompt: true,
    questionProvider: "gateway",
    permissionProvider: "gateway",
  });
  assert.deepEqual(resolveInteractionProfile("headless"), {
    name: "headless",
    policyMode: "headless",
    canPrompt: true,
    questionProvider: "deterministic",
    permissionProvider: "fail_closed",
  });
  assert.deepEqual(resolveInteractionProfile("disabled"), {
    name: "disabled",
    policyMode: "disabled",
    canPrompt: false,
    questionProvider: "disabled",
    permissionProvider: "fail_closed",
  });
});

test("headless permission profile fails closed before a Gateway approval wait", async () => {
  let calls = 0;
  const delegate: PermissionDecisionPort = {
    async decide() {
      calls += 1;
      return askedPermission;
    },
  };
  const port = createProfiledPermissionDecisionPort(delegate, {
    policy: createDefaultInteractionPolicy(),
    mode: "headless",
    hasAnswerer: false,
    canPrompt: true,
  });

  const decision = await port.decide({} as never, {}, {} as never, "call-1");

  assert.equal(calls, 1);
  assert.deepEqual(decision, {
    type: "deny",
    reason: { type: "runtime", message: "No interaction answerer is available." },
    message: "No interaction answerer is available.",
  });
});

test("interactive permission profile preserves an ask for its Gateway consumer", async () => {
  const delegate: PermissionDecisionPort = { async decide() { return askedPermission; } };
  const port = createProfiledPermissionDecisionPort(delegate, {
    policy: createDefaultInteractionPolicy(),
    mode: "interactive",
    hasAnswerer: true,
    canPrompt: true,
  });

  assert.equal(
    await port.decide({} as never, {}, {} as never, "call-1"),
    askedPermission,
  );
});
