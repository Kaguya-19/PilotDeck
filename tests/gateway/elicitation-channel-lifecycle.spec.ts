import assert from "node:assert/strict";
import test from "node:test";

import { AgentRuntimeScope } from "../../src/agent/scope/index.js";
import type { AgentRouterRuntime } from "../../src/agent/index.js";
import type { PermissionDecisionPort } from "../../src/permission/index.js";
import { ToolRegistry } from "../../src/tool/index.js";
import { GatewayElicitationBus } from "../../src/gateway/elicitation/GatewayElicitationBus.js";
import { GatewayElicitationChannel } from "../../src/gateway/elicitation/GatewayElicitationChannel.js";
import { createDeterministicElicitationAnswerer } from "../../src/agent/modules/interaction/index.js";
import { createElicitationChannelFromAnswerer } from "../../src/tool/elicitation/PilotDeckElicitationChannel.js";
import {
  createDefaultInteractionPolicy,
  createStaticInteractionDeadlinePolicy,
} from "../../src/interaction/index.js";

const request = {
  toolCallId: "call-1",
  toolName: "ask_user_question",
  questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "yes", description: "Yes" }] }],
};

test("headless elicitation provider answers deterministically without waiting for a host", async () => {
  const channel = createElicitationChannelFromAnswerer(createDeterministicElicitationAnswerer());
  assert.deepEqual(await channel.askUser({
    ...request,
    questions: [
      { question: "One?", header: "One", options: [{ label: "A", description: "A" }, { label: "B", description: "B" }] },
      { question: "Many?", header: "Many", multiSelect: true, options: [{ label: "X", description: "X" }] },
      { question: "Free?", header: "Free", options: [] },
    ],
  }), {
    type: "answered",
    answers: { "One?": "A", "Many?": ["X"], "Free?": "yes" },
  });
});

test("headless elicitation provider applies the shared interaction policy before invoking the answerer", async () => {
  let invoked = 0;
  const channel = createElicitationChannelFromAnswerer({
    answer: async () => {
      invoked += 1;
      return { type: "answered", answers: { Proceed: "yes" } };
    },
  }, {
    policy: createDefaultInteractionPolicy(),
    policyMode: "disabled",
    canPrompt: true,
  });

  assert.deepEqual(await channel.askUser(request), {
    type: "cancelled",
    reason: "Interaction is disabled for this profile.",
  });
  assert.equal(invoked, 0);
});

test("elicitation bus rejects duplicate request ids and exposes an exact registration handle", () => {
  const bus = new GatewayElicitationBus();
  const entry = {
    requestId: "request-duplicate",
    toolCallId: "call-1",
    toolName: "ask_user_question",
    resolve: () => undefined,
    reject: () => undefined,
  };
  const registration = bus.register("session-1", entry);
  assert.equal(registration.active, true);
  assert.throws(() => bus.register("session-1", { ...entry }), /already pending/);
  registration.dispose();
  assert.equal(registration.active, false);
  assert.equal(bus.pendingCount("session-1"), 0);
  registration.dispose();
});

test("gateway elicitation channel rejects pending requests and stops new requests on dispose", async () => {
  const bus = new GatewayElicitationBus();
  const channel = new GatewayElicitationChannel({
    sessionKey: "session-1",
    bus,
    emit: () => undefined,
    uuid: () => "request-1",
  });

  const pending = channel.askUser(request);
  assert.equal(bus.pendingCount("session-1"), 1);
  const firstDispose = channel.dispose("scope_closed");
  const secondDispose = channel.dispose("ignored");
  assert.ok(firstDispose);
  assert.ok(secondDispose);
  await assert.rejects(pending, /scope_closed/);
  await firstDispose;
  await secondDispose;
  await assert.rejects(channel.askUser(request), /disposed/);
  assert.equal(bus.pendingCount("session-1"), 0);
});

test("gateway elicitation channel converts a deadline into cancellation and drops late answers", async () => {
  const bus = new GatewayElicitationBus();
  const events: Array<{ type: string; requestId?: string; reason?: string }> = [];
  const channel = new GatewayElicitationChannel({
    sessionKey: "session-timeout",
    bus,
    emit: (event) => events.push(event as typeof events[number]),
    uuid: () => "request-timeout",
    timeoutMs: 5,
  });

  const answer = await channel.askUser(request);
  assert.deepEqual(answer, { type: "cancelled", reason: "timeout" });
  assert.equal(bus.pendingCount("session-timeout"), 0);
  assert.equal(bus.consume("session-timeout", "request-timeout"), undefined);
  assert.deepEqual(events.at(-1), {
    type: "elicitation_cancelled",
    requestId: "request-timeout",
    reason: "timeout",
  });
});

test("gateway elicitation channel uses the scope deadline policy ahead of its legacy timeout option", async () => {
  const bus = new GatewayElicitationBus();
  const channel = new GatewayElicitationChannel({
    sessionKey: "session-policy-timeout",
    bus,
    emit: () => undefined,
    uuid: () => "request-policy-timeout",
    timeoutMs: 60_000,
    deadlinePolicy: createStaticInteractionDeadlinePolicy({ questionTimeoutMs: 1 }),
  });

  assert.deepEqual(await channel.askUser(request), { type: "cancelled", reason: "timeout" });
  assert.equal(bus.pendingCount("session-policy-timeout"), 0);
});

test("gateway elicitation delivery failure rejects the request and removes its pending entry", async () => {
  const bus = new GatewayElicitationBus();
  const channel = new GatewayElicitationChannel({
    sessionKey: "session-delivery-failure",
    bus,
    emit: () => { throw new Error("host stream closed"); },
    uuid: () => "request-delivery-failure",
  });

  await assert.rejects(channel.askUser(request), /host stream closed/);
  assert.equal(bus.pendingCount("session-delivery-failure"), 0);
  assert.equal(bus.consume("session-delivery-failure", "request-delivery-failure"), undefined);
});

test("elicitation reconnect payload is transport-safe and excludes AbortSignal", async () => {
  const bus = new GatewayElicitationBus();
  const controller = new AbortController();
  const channel = new GatewayElicitationChannel({
    sessionKey: "session-replay",
    bus,
    emit: () => undefined,
    uuid: () => "request-replay",
  });
  const pending = channel.askUser({
    ...request,
    signal: controller.signal,
    metadata: { nested: { ok: true }, ignored: () => "host-only" },
  });
  const snapshot = bus.snapshot("session-replay");
  assert.equal(snapshot.length, 1);
  assert.equal("signal" in ((snapshot[0]?.payload ?? {}) as Record<string, unknown>), false);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  bus.consume("session-replay", "request-replay")?.resolve({ type: "cancelled", reason: "test" });
  assert.deepEqual(await pending, { type: "cancelled", reason: "test" });
});

test("elicitation observer failures do not change the host round-trip", async () => {
  const bus = new GatewayElicitationBus();
  const channel = new GatewayElicitationChannel({
    sessionKey: "session-observer-failure",
    bus,
    emit: () => undefined,
    dispatchHook: async () => { throw new Error("observer failed"); },
    emitAgentEvent: () => { throw new Error("agent observer failed"); },
    uuid: () => "request-observer-failure",
  });

  const pending = channel.askUser(request);
  const delivered = bus.consume("session-observer-failure", "request-observer-failure");
  delivered?.resolve({ type: "answered", answers: { Proceed: "yes" } });
  assert.deepEqual(await pending, { type: "answered", answers: { Proceed: "yes" } });
});

test("child scope inherits elicitation without disposing the parent-owned channel", async () => {
  let disposed = 0;
  const channel = {
    askUser: async () => ({ type: "cancelled" as const }),
    dispose: async () => { disposed += 1; },
  };
  const root = AgentRuntimeScope.createRoot({
    router: {} as AgentRouterRuntime,
    permission: {} as PermissionDecisionPort,
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
    elicitation: channel,
  }, { ownedElicitation: true });
  const child = root.createChild({
    toolRegistry: new ToolRegistry(),
    toolScheduler: {} as never,
  });

  await child.dispose();
  assert.equal(disposed, 0);
  await root.dispose();
  assert.equal(disposed, 1);
});
