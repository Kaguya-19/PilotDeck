import assert from "node:assert/strict";
import test from "node:test";

import {
  createWebHistoryProjectionRegistry,
  projectWebHistory,
  projectSubagentReferences,
  SessionProjectionRegistry,
  type SessionProjectionDefinition,
} from "../../src/session/projection/index.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";

const createdAt = "2026-09-06T00:00:00.000Z";

function acceptedInput(sequence: number): AgentTranscriptEntry {
  return {
    type: "accepted_input",
    sessionId: "session-projection",
    turnId: `turn-${sequence}`,
    sequence,
    createdAt,
    messages: [{ role: "user", content: [{ type: "text", text: `message-${sequence}` }] }],
  };
}

test("session projection registry projects typed transcript events", () => {
  type State = { count: number; sequences: number[] };

  const definition: SessionProjectionDefinition<State, Readonly<State>> = {
    name: "test.accepted-input-count",
    version: 1,
    create: () => ({ count: 0, sequences: [] }),
    reduce(state, entry) {
      if (entry.type !== "accepted_input") return;
      state.count += 1;
      state.sequences.push(entry.sequence);
    },
    finalize: (state) => ({ count: state.count, sequences: [...state.sequences] }),
  };

  const registry = new SessionProjectionRegistry();
  registry.register(definition);

  assert.deepEqual(registry.project<Readonly<State>>(definition.name, [acceptedInput(1), acceptedInput(2)]), {
    count: 2,
    sequences: [1, 2],
  });
  assert.deepEqual(registry.list(), [{ name: definition.name, version: 1 }]);
});

test("projection registration is unique and disposable", () => {
  const registry = new SessionProjectionRegistry();
  const definition: SessionProjectionDefinition<{ count: number }> = {
    name: "test.disposable",
    version: 1,
    create: () => ({ count: 0 }),
    reduce(state) {
      state.count += 1;
    },
  };

  const registration = registry.register(definition);
  assert.throws(() => registry.register(definition), /already registered/);
  assert.equal(registration.active, true);

  registration.dispose();
  registration.dispose();

  assert.equal(registration.active, false);
  assert.throws(() => registry.project(definition.name, [acceptedInput(1)]), /not registered/);
});

test("projection create and reduce receive immutable replay context", () => {
  const registry = new SessionProjectionRegistry();
  const seenIndexes: number[] = [];
  const entries = [acceptedInput(3), acceptedInput(4)];

  registry.register({
    name: "test.context",
    version: 2,
    create(context) {
      assert.equal(context.entries, entries);
      return { count: 0 };
    },
    reduce(state, _entry, context) {
      assert.equal(context.entries, entries);
      seenIndexes.push(context.index);
      state.count += 1;
    },
  });

  assert.deepEqual(registry.project("test.context", entries), { count: 2 });
  assert.deepEqual(seenIndexes, [0, 1]);
});

test("subagent reference projection correlates durable start and completion entries", () => {
  const entries: AgentTranscriptEntry[] = [
    {
      type: "subagent_started",
      sessionId: "session-projection",
      turnId: "turn-parent",
      sequence: 1,
      createdAt,
      subagentId: "sub-1",
      subagentType: "explore",
      promptPreview: "inspect",
      promptTruncated: false,
      transcriptRelativePath: "session/subagents/sub-1.jsonl",
    },
    {
      type: "subagent_completed",
      sessionId: "session-projection",
      turnId: "turn-parent",
      sequence: 2,
      createdAt,
      subagentId: "sub-1",
      subagentType: "explore",
      summaryPreview: "done",
      summaryTruncated: false,
      turns: 1,
      durationMs: 10,
    },
    {
      type: "subagent_started",
      sessionId: "session-projection",
      turnId: "turn-parent",
      sequence: 3,
      createdAt,
      subagentId: "sub-1",
      subagentType: "explore",
      promptPreview: "duplicate",
      promptTruncated: false,
      transcriptRelativePath: "session/subagents/duplicate.jsonl",
    },
  ];

  const projection = projectSubagentReferences(entries);

  assert.deepEqual(projection.started, [entries[0], entries[2]]);
  assert.deepEqual(projection.completed, [entries[1]]);
  assert.equal(projection.startedById.get("sub-1"), entries[0]);
  assert.equal(projection.completedById.get("sub-1"), entries[1]);
});

test("web history projections own artifact, status, turn error, and token usage replay", () => {
  const errorResult = (turnId: string): AgentTranscriptEntry => ({
    type: "turn_result",
    sessionId: "session-projection",
    turnId,
    sequence: 1,
    createdAt,
    result: {
      type: "error",
      sessionId: "session-projection",
      turnId,
      stopReason: "model_error",
      usage: {},
      permissionDenials: [],
      errors: [{ code: "agent_model_error", message: `${turnId} failed` }],
      turns: 0,
      startedAt: createdAt,
      completedAt: createdAt,
    },
  });
  const entries: AgentTranscriptEntry[] = [
    {
      type: "tool_result_message",
      sessionId: "session-projection",
      turnId: "turn-with-tool",
      sequence: 1,
      createdAt,
      message: {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "tool-1", content: [{ type: "text", text: "done" }] }],
      },
    },
    {
      type: "file_artifacts",
      sessionId: "session-projection",
      turnId: "turn-with-tool",
      sequence: 2,
      createdAt,
      artifacts: [{
        id: "kept",
        name: "kept.txt",
        path: "kept.txt",
        operation: "created",
        source: "workspace_diff",
        status: "complete",
        size: 1,
        sha256: "a".repeat(64),
        createdAt,
      }],
    },
    {
      type: "file_artifacts",
      sessionId: "session-projection",
      turnId: "turn-without-tool",
      sequence: 3,
      createdAt,
      artifacts: [{
        id: "stale",
        name: "stale.txt",
        path: "stale.txt",
        operation: "updated",
        source: "workspace_diff",
        status: "complete",
        size: 1,
        sha256: "b".repeat(64),
        createdAt,
      }],
    },
    {
      type: "agent_status_message",
      sessionId: "session-projection",
      turnId: "turn-visible-error",
      sequence: 4,
      createdAt,
      event: "model_request_failed",
      kind: "error",
      text: "visible failure",
      detail: { visible: true },
    },
    { ...errorResult("turn-visible-error"), sequence: 5 },
    { ...errorResult("turn-hidden-error"), sequence: 6 },
    {
      type: "agent_status_message",
      sessionId: "session-projection",
      turnId: "turn-budget",
      sequence: 7,
      createdAt,
      event: "context_budget",
      kind: "status",
      text: "context budget",
      detail: { displayUsed: 60, budgetUsed: 90, total: 500, effectiveTotal: 450 },
    },
    {
      type: "control_boundary",
      sessionId: "session-projection",
      turnId: "turn-budget",
      sequence: 8,
      createdAt,
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 90, postTokens: 20 },
      },
    },
    {
      type: "turn_result",
      sessionId: "session-projection",
      turnId: "turn-usage",
      sequence: 9,
      createdAt,
      result: {
        type: "success",
        sessionId: "session-projection",
        turnId: "turn-usage",
        stopReason: "completed",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    },
    {
      type: "durable_message",
      sessionId: "session-projection",
      turnId: "turn-incomplete",
      sequence: 10,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    },
    {
      type: "durable_message",
      sessionId: "session-projection",
      turnId: "turn-completed-message",
      sequence: 11,
      createdAt,
      message: { role: "assistant", content: [{ type: "text", text: "complete" }] },
    },
    {
      type: "turn_result",
      sessionId: "session-projection",
      turnId: "turn-completed-message",
      sequence: 12,
      createdAt,
      result: {
        type: "success",
        sessionId: "session-projection",
        turnId: "turn-completed-message",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    },
  ];

  const projection = projectWebHistory(entries);

  assert.deepEqual(projection.fileArtifacts.map((entry) => entry.artifacts[0]?.id), ["kept"]);
  assert.deepEqual(projection.agentStatuses.map((entry) => entry.sequence), [4, 7]);
  assert.deepEqual(projection.turnErrors.map((entry) => entry.turnId), ["turn-hidden-error"]);
  assert.equal(projection.tokenUsage.latestContextBudget?.index, 6);
  assert.equal(projection.tokenUsage.latestContextBudget?.usage.used, 60);
  assert.equal(projection.tokenUsage.latestCompactBudget?.index, 7);
  assert.equal(projection.tokenUsage.latestCompactBudget?.postTokens, 20);
  assert.deepEqual(projection.tokenUsage.latestTurnUsage, {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
  });
  assert.deepEqual(projection.incompleteTurnIds, ["turn-with-tool", "turn-incomplete"]);
});

test("web history projection fails when a required projection is missing", () => {
  const registry = createWebHistoryProjectionRegistry();
  const tokenUsage = registry.resolve("web-history.token-usage");
  assert.ok(tokenUsage);

  const incompleteRegistry = new SessionProjectionRegistry();
  incompleteRegistry.register(tokenUsage);

  assert.throws(
    () => projectWebHistory([], incompleteRegistry),
    /Session projection is not available: web-history\.file-artifacts/,
  );
});
