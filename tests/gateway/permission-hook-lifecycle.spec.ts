import assert from "node:assert/strict";
import test from "node:test";

import { GatewayPermissionBus } from "../../src/gateway/permission/GatewayPermissionBus.js";
import { createGatewayPermissionHook } from "../../src/gateway/permission/createGatewayPermissionHook.js";
import { createStaticInteractionDeadlinePolicy } from "../../src/interaction/index.js";

function hookInput() {
  return {
    hookEventName: "PermissionRequest",
    sessionId: "session-1",
    transcriptPath: "",
    cwd: "/workspace",
    toolName: "write_file",
    toolCallId: "call-1",
    toolInput: { path: "file.txt" },
  } as never;
}

test("permission bus returns an exact registration handle and rejects duplicate request ids", () => {
  const bus = new GatewayPermissionBus();
  const pending = {
    requestId: "request-1",
    toolCallId: "call-1",
    toolName: "write_file",
    resolve: () => undefined,
    reject: () => undefined,
  };
  const registration = bus.register("session-1", pending);
  assert.equal(registration.active, true);
  assert.throws(() => bus.register("session-1", pending), /already pending/);
  assert.equal(bus.consume("session-1", "request-1"), pending);
  assert.equal(registration.active, false);
  const secondRegistration = bus.register("session-1", pending);
  secondRegistration.dispose();
  assert.equal(secondRegistration.active, false);
  const thirdRegistration = bus.register("session-1", pending);
  thirdRegistration.dispose();
  assert.equal(bus.pendingCount("session-1"), 0);
});

test("permission hook fails closed on timeout and removes the pending request", async () => {
  const bus = new GatewayPermissionBus();
  let emitted = 0;
  const hook = createGatewayPermissionHook({
    sessionKey: "session-1",
    bus,
    emit: () => {
      emitted += 1;
      return true;
    },
    permissionRules: [],
    uuid: () => "request-1",
    timeoutMs: 5,
  });

  const output = await hook({ hookInput: hookInput() });
  assert.equal(emitted, 1);
  assert.equal(bus.pendingCount("session-1"), 0);
  assert.deepEqual(output, {
    type: "sync",
    specific: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Permission prompt timed out." },
    },
  });
});

test("permission hook uses the scope deadline policy ahead of its legacy timeout option", async () => {
  const bus = new GatewayPermissionBus();
  const hook = createGatewayPermissionHook({
    sessionKey: "session-policy-timeout",
    bus,
    emit: () => true,
    permissionRules: [],
    uuid: () => "request-policy-timeout",
    timeoutMs: 60_000,
    deadlinePolicy: createStaticInteractionDeadlinePolicy({ permissionTimeoutMs: 1 }),
  });

  const output = await hook({ hookInput: hookInput() });
  assert.deepEqual((output as { specific?: { decision?: unknown } }).specific?.decision, {
    behavior: "deny",
    message: "Permission prompt timed out.",
  });
  assert.equal(bus.pendingCount("session-policy-timeout"), 0);
});

test("permission timeout carries the shared interaction outcome internally", async () => {
  const bus = new GatewayPermissionBus();
  const hook = createGatewayPermissionHook({
    sessionKey: "session-1",
    bus,
    emit: () => true,
    permissionRules: [],
    uuid: () => "request-timeout-outcome",
    timeoutMs: 1,
  });
  const output = await hook({ hookInput: hookInput() });
  assert.deepEqual((output as { specific?: { decision?: unknown } }).specific?.decision, {
    behavior: "deny",
    message: "Permission prompt timed out.",
  });
  assert.equal(bus.consume("session-1", "request-timeout-outcome"), undefined);
});

test("permission hook abort is fail-closed and a late host answer is undeliverable", async () => {
  const bus = new GatewayPermissionBus();
  const controller = new AbortController();
  const hook = createGatewayPermissionHook({
    sessionKey: "session-1",
    bus,
    emit: () => true,
    permissionRules: [],
    uuid: () => "request-1",
    timeoutMs: 1000,
  });

  const pending = hook({ hookInput: hookInput(), signal: controller.signal });
  assert.equal(bus.pendingCount("session-1"), 1);
  controller.abort();
  const output = await pending;
  assert.equal(bus.pendingCount("session-1"), 0);
  assert.equal(bus.consume("session-1", "request-1"), undefined);
  assert.deepEqual((output as { specific?: { decision?: unknown } }).specific?.decision, {
    behavior: "deny",
    message: "Permission prompt cancelled.",
  });
});

test("permission hook denies when no active gateway sink exists", async () => {
  const bus = new GatewayPermissionBus();
  const hook = createGatewayPermissionHook({
    sessionKey: "session-1",
    bus,
    emit: () => false,
    permissionRules: [],
    uuid: () => "request-1",
  });

  const output = await hook({ hookInput: hookInput() });
  assert.equal(bus.pendingCount("session-1"), 0);
  assert.deepEqual((output as { specific?: { decision?: unknown } }).specific?.decision, {
    behavior: "deny",
    message: "Permission prompt could not be delivered to the Web UI.",
  });
});

test("permission bus closes session teardown as deny without leaving a pending promise", async () => {
  const bus = new GatewayPermissionBus();
  let resolved: unknown;
  const pending = {
    requestId: "request-1",
    toolCallId: "call-1",
    toolName: "write_file",
    resolve: (decision: unknown) => { resolved = decision; },
    reject: () => { throw new Error("teardown must not reject permission"); },
  };
  const registration = bus.register("session-1", pending);
  bus.denySession("session-1", "turn_ended");
  assert.equal(registration.active, false);
  assert.deepEqual(resolved, { requestId: "request-1", decision: "deny", reason: "turn_ended" });
  assert.equal(bus.pendingCount("session-1"), 0);
});
