import assert from "node:assert/strict";
import test from "node:test";

import {
  InProcessModuleAdapter,
  ModuleOperationHost,
  validateModuleMessage,
  type ModuleExecuteRequest,
} from "../../../src/agent/modules/index.js";

const executeRequest: ModuleExecuteRequest = {
  kind: "request",
  messageId: "message-1",
  method: "execute",
  runId: "run-1",
  operationId: "operation-1",
  requestId: "request-1",
  payload: {},
};

test("Module Protocol v2 validates slim execute and event profiles", () => {
  assert.deepEqual(validateModuleMessage(executeRequest), { ok: true });
  assert.equal(validateModuleMessage({ ...executeRequest, attemptId: "attempt-1" }).ok, false);
  assert.equal(validateModuleMessage({
    kind: "event",
    eventType: "model.delta",
    streamId: "stream-1",
    sequence: 0,
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    final: false,
    payload: {},
  }).ok, true);
  assert.equal(validateModuleMessage({
    kind: "event",
    eventType: "model.delta",
    streamId: "stream-1",
    sequence: 0,
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    final: true,
    payload: {},
  }).ok, false);
});

test("Module Protocol v2 validates host-owned module_call requests", () => {
  assert.deepEqual(validateModuleMessage({
    kind: "request",
    messageId: "call-1",
    method: "module_call",
    runId: "run-1",
    operationId: "operation-1",
    requestId: "request-1",
    module: "capability",
    payload: { name: "lookup", arguments: {} },
  }), { ok: true });
});

test("ModuleOperationHost keeps one outcome and rejects stream gaps", () => {
  const host = new ModuleOperationHost(() => new Date("2026-09-02T00:00:00.000Z"));
  host.accept(executeRequest);
  assert.deepEqual(host.acceptSequence("operation-1", "stream-1", 0), { accepted: true, gap: false });
  assert.deepEqual(host.acceptSequence("operation-1", "stream-1", 0), { accepted: false, gap: false });
  assert.deepEqual(host.acceptSequence("operation-1", "stream-1", 2), { accepted: false, gap: true });
  assert.equal(host.recordFinal("operation-1", "request-1", "completed").outcome, "completed");
  assert.equal(host.recordFinal("operation-1", "request-2", "cancelled").outcome, "completed");
});

test("InProcessModuleAdapter emits accepted, ordered events and a final outcome", async () => {
  const adapter = new InProcessModuleAdapter({
    capabilities: {
      capabilitiesVersion: "2.0",
      methods: [{ name: "execute", profiles: ["streaming"], resumeSupport: "streaming", retry: "safe" }],
    },
    async *execute() {
      yield { eventType: "model.delta", payload: { text: "hello" } };
    },
  }, { moduleId: "model", uuid: () => "fixed" });

  const messages = [];
  for await (const message of adapter.execute(executeRequest)) messages.push(message);
  assert.equal(messages[0]?.kind, "response");
  assert.equal(messages[1]?.kind, "event");
  assert.equal(messages[1]?.final, false);
  assert.equal(messages[2]?.kind, "event");
  assert.equal(messages[2]?.final, true);
  assert.equal(messages[2]?.outcome, "completed");
});

test("InProcessModuleAdapter emits a single final response for unary/tool profiles", async () => {
  const adapter = new InProcessModuleAdapter({
    capabilities: {
      capabilitiesVersion: "2.0",
      methods: [{ name: "execute", profiles: ["unary", "tool"], resumeSupport: "none", retry: "safe" }],
    },
    async *execute() {
      yield { eventType: "tool.result", payload: { value: 42 }, final: true, outcome: "completed" as const };
    },
  }, { moduleId: "tool", uuid: () => "fixed" });

  const messages = [];
  for await (const message of adapter.execute(executeRequest)) messages.push(message);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.kind, "response");
  assert.equal(messages[0]?.final, true);
  assert.equal(messages[0]?.outcome, "completed");
});

test("InProcessModuleAdapter rejects an expired deadline before dispatch", async () => {
  let dispatched = false;
  const adapter = new InProcessModuleAdapter({
    capabilities: { capabilitiesVersion: "2.0", methods: [{ name: "execute", profiles: ["unary"] }] },
    async *execute() {
      dispatched = true;
      yield { eventType: "tool.result", payload: {} };
    },
  }, { moduleId: "tool", now: () => new Date("2026-09-02T00:00:00.000Z"), uuid: () => "fixed" });
  const messages = [];
  for await (const message of adapter.execute({
    ...executeRequest,
    operationDeadline: "2026-09-01T00:00:00.000Z",
  })) messages.push(message);
  assert.equal(dispatched, false);
  assert.equal(messages[0]?.kind, "response");
  assert.equal(messages[0]?.outcome, "failed");
});
