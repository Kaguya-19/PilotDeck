import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionDomainValidationError,
  SessionRuntime,
  validateSessionDomainLog,
} from "../../src/session/events/index.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import type { SessionEventDraft } from "../../src/session/events/SessionEventStore.js";

const createdAt = "2026-09-06T00:00:00.000Z";

test("domain validation preserves legacy-only transcripts", () => {
  assert.doesNotThrow(() => validateSessionDomainLog([
    entry(1, { type: "accepted_input", messages: [] }),
    entry(2, { type: "turn_result", result: turnResult() }),
  ]));
});

test("domain validation accepts an open step and dangling tool call as a crash tail", () => {
  assert.doesNotThrow(() => validateSessionDomainLog([
    entry(1, { type: "turn_started" }),
    entry(2, { type: "step_started", step: 1 }),
    entry(3, { type: "model_request", step: 1, request: modelRequest() }),
    entry(4, { type: "tool_call", step: 1, call: { id: "call-1", name: "lookup", input: {} } }),
  ]));
});

test("domain validation accepts context and instructions before a model request", () => {
  assert.doesNotThrow(() => validateSessionDomainLog([
    entry(1, { type: "turn_started" }),
    entry(2, { type: "step_started", step: 1 }),
    entry(3, {
      type: "context_snapshot",
      step: 1,
      promptGeneration: 2,
      contexts: [{ name: "cwd", text: "/workspace" }],
    }),
    entry(4, {
      type: "agent_instructions",
      step: 1,
      baseline: true,
      layers: [{ scope: "project", path: "PILOTDECK.md", content: "rules" }],
      changes: [{ action: "set", scope: "project", path: "PILOTDECK.md", content: "rules" }],
    }),
    entry(5, { type: "model_request", step: 1, request: modelRequest() }),
  ]));
});

test("domain validation rejects context or instruction materialization after model dispatch", () => {
  const prefix: AgentTranscriptEntry[] = [
    entry(1, { type: "turn_started" }),
    entry(2, { type: "step_started", step: 1 }),
    entry(3, { type: "model_request", step: 1, request: modelRequest() }),
  ];
  assert.throws(
    () => validateSessionDomainLog([
      ...prefix,
      entry(4, { type: "context_snapshot", step: 1, contexts: [] }),
    ]),
    (error: unknown) => error instanceof SessionDomainValidationError
      && error.code === "context_after_model_request",
  );
  assert.throws(
    () => validateSessionDomainLog([
      ...prefix,
      entry(4, { type: "agent_instructions", step: 1, baseline: false, changes: [] }),
    ]),
    (error: unknown) => error instanceof SessionDomainValidationError
      && error.code === "instructions_after_model_request",
  );
});

test("incremental validation rejects an unpaired tool result without advancing sequence", async () => {
  let id = 0;
  const runtime = new SessionRuntime({
    now: () => new Date(createdAt),
    uuid: () => `entry-${++id}`,
  });
  await runtime.append("session-1", "turn-1", { type: "turn_started" });
  await runtime.append("session-1", "turn-1", { type: "step_started", step: 1 });
  await runtime.append("session-1", "turn-1", { type: "model_request", step: 1, request: modelRequest() });

  await assert.rejects(
    runtime.append("session-1", "turn-1", { type: "tool_result", step: 1, result: toolResult("missing") }),
    (error: unknown) => error instanceof SessionDomainValidationError && error.code === "tool_result_without_call",
  );
  assert.equal(runtime.snapshotState().sequence, 3);

  await runtime.append("session-1", "turn-1", {
    type: "tool_call",
    step: 1,
    call: { id: "call-1", name: "lookup", input: {} },
  });
  await runtime.append("session-1", "turn-1", { type: "tool_result", step: 1, result: toolResult("call-1") });
  await runtime.append("session-1", "turn-1", { type: "step_completed", step: 1, outcome: "completed" });
  await runtime.append("session-1", "turn-1", { type: "turn_result", result: turnResult() });
  assert.equal(runtime.snapshotState().sequence, 7);
});

test("domain validation rejects closing a turn with pending inbox state", () => {
  assert.throws(() => validateSessionDomainLog([
    entry(1, { type: "turn_started" }),
    entry(2, {
      type: "inbox_mutation",
      mutation: "insert",
      itemId: "queue-1",
      message: { role: "user", content: [{ type: "text", text: "guide" }] },
    }),
    entry(3, { type: "turn_result", result: turnResult() }),
  ]), (error: unknown) => error instanceof SessionDomainValidationError && error.code === "turn_has_pending_inbox");
});

test("queued turn admission is FIFO and turn start atomically claims its item", () => {
  const first = entry(1, {
    type: "agent_turn_enqueued",
    itemId: "item-1",
    input: { type: "text", text: "first" },
    submitOptions: {},
  });
  const second = { ...entry(2, {
    type: "agent_turn_enqueued",
    itemId: "item-2",
    input: { type: "text", text: "second" },
    submitOptions: {},
  }), turnId: "turn-2" } as AgentTranscriptEntry;
  assert.doesNotThrow(() => validateSessionDomainLog([
    first,
    second,
    entry(3, { type: "turn_started", inboxItemId: "item-1" }),
  ]));
  assert.throws(() => validateSessionDomainLog([
    first,
    second,
    { ...entry(3, { type: "turn_started", inboxItemId: "item-2" }), turnId: "turn-2" },
  ]), (error: unknown) => error instanceof SessionDomainValidationError
    && error.code === "invalid_inbox_mutation");
});

test("queued turn admission never reuses durable item or turn identities", () => {
  const admitted = entry(1, {
    type: "agent_turn_enqueued",
    itemId: "item-1",
    input: { type: "text", text: "first" },
    submitOptions: {},
  });
  const discarded = entry(2, {
    type: "agent_turn_discarded",
    itemId: "item-1",
    reason: "cancelled",
  });

  assert.throws(() => validateSessionDomainLog([
    admitted,
    discarded,
    { ...entry(3, {
      type: "agent_turn_enqueued",
      itemId: "item-1",
      input: { type: "text", text: "reused item" },
      submitOptions: {},
    }), turnId: "turn-2" },
  ]), (error: unknown) => error instanceof SessionDomainValidationError
    && error.code === "invalid_inbox_mutation");

  assert.throws(() => validateSessionDomainLog([
    admitted,
    discarded,
    { ...entry(3, {
      type: "agent_turn_enqueued",
      itemId: "item-2",
      input: { type: "text", text: "reused turn" },
      submitOptions: {},
    }), turnId: "turn-1" },
  ]), (error: unknown) => error instanceof SessionDomainValidationError
    && error.code === "invalid_inbox_mutation");
});

test("domain-invalid restore is transactional and unknown legacy entries remain ignorable", async () => {
  let id = 0;
  const runtime = new SessionRuntime({
    now: () => new Date(createdAt),
    uuid: () => `entry-${++id}`,
  });
  await runtime.append("session-1", "legacy", { type: "session_metadata", metadata: { title: "kept" } });
  const previous = await runtime.read();

  assert.throws(() => runtime.restore([
    entry(1, { type: "turn_started" }),
    entry(2, { type: "step_started", step: 1 }),
    entry(3, { type: "step_completed", step: 2, outcome: "completed" }),
  ]), SessionDomainValidationError);
  assert.deepEqual((await runtime.read()).entries, previous.entries);

  assert.doesNotThrow(() => validateSessionDomainLog([
    entry(1, { type: "future_legacy_event" } as unknown as SessionEventDraft),
  ]));
});

function entry(
  sequence: number,
  event: SessionEventDraft,
): AgentTranscriptEntry {
  return {
    ...event,
    sessionId: "session-1",
    turnId: "turn-1",
    sequence,
    createdAt,
  } as AgentTranscriptEntry;
}

function modelRequest() {
  return {
    provider: "provider-a",
    model: "model-a",
    messages: [],
  };
}

function toolResult(toolCallId: string) {
  return {
    type: "success" as const,
    toolCallId,
    toolName: "lookup",
    content: [{ type: "text" as const, text: "done" }],
    startedAt: createdAt,
    completedAt: createdAt,
  };
}

function turnResult() {
  return {
    type: "success" as const,
    sessionId: "session-1",
    turnId: "turn-1",
    stopReason: "completed" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}
