import assert from "node:assert/strict";
import test from "node:test";

import { AgentSessionEventRecorder } from "../../src/agent/session/AgentSessionEventRecorder.js";
import { createDurableContextRuntime } from "../../src/agent/modules/context/durableContextRuntime.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import type { AgentContextRuntime, AutoCompactResult } from "../../src/context/index.js";
import { validateSessionDomainLog, SessionDomainValidationError } from "../../src/session/events/SessionDomainValidation.js";

function turnRecorder() {
  const transcript = new InMemoryTranscriptWriter({ uuid: (() => {
    let sequence = 0;
    return () => `entry-${++sequence}`;
  })() });
  const recorder = new AgentSessionEventRecorder(transcript, { uuid: () => "compact-op-1" });
  return { transcript, recorder };
}

const skipped: AutoCompactResult = {
  type: "skipped",
  snapshot: {
    tokens: 10,
    maxContextTokens: 100,
    warningRatio: 0.8,
    blockingRatio: 0.9,
    state: "ok",
    ratio: 0.1,
  },
};

test("durable context records a completed compaction bracket", async () => {
  const { transcript, recorder } = turnRecorder();
  await recorder.startTurn("session-1", "turn-1");
  const delegate: AgentContextRuntime = {
    prepareForModel: async () => ({ messages: [], systemPromptParts: [], tools: [], diagnostics: [], boundaries: [] }),
    tryAutoCompact: async () => skipped,
  };

  const runtime = createDurableContextRuntime(delegate, recorder);
  const result = await runtime.tryAutoCompact!({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
  });

  assert.deepEqual(result, skipped);
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "compaction_started",
    "compaction_completed",
  ]);
  const completed = transcript.entries[2];
  assert.equal(completed?.type, "compaction_completed");
  if (completed?.type === "compaction_completed") {
    assert.equal(completed.operationId, "compact-op-1");
    assert.equal(completed.status, "skipped");
    assert.equal(completed.messageCount, 0);
  }
});

test("durable context defers compacted completion until replacement commit", async () => {
  const { transcript, recorder } = turnRecorder();
  await recorder.startTurn("session-deferred", "turn-1");
  const compacted: AutoCompactResult = {
    type: "compacted",
    messages: [{ role: "assistant", content: [{ type: "text", text: "summary" }] }],
    tier: "full",
    snapshot: skipped.snapshot,
    result: {
      compactionId: "compact-1",
      trigger: "auto",
      preTokens: 120,
      postTokens: 20,
      messagesSummarized: 4,
      boundaryMarker: { role: "assistant", content: [{ type: "text", text: "boundary" }] },
      messagesToKeep: [],
      attachments: [],
      hookResults: [],
      diagnostics: [],
    },
  };
  const delegate: AgentContextRuntime = {
    prepareForModel: async () => ({ messages: [], systemPromptParts: [], tools: [], diagnostics: [], boundaries: [] }),
    tryAutoCompact: async () => compacted,
  };

  const runtime = createDurableContextRuntime(delegate, recorder);
  await runtime.tryAutoCompact!({ sessionId: "session-deferred", turnId: "turn-1", messages: [] });
  assert.deepEqual(transcript.entries.map((entry) => entry.type), ["turn_started", "compaction_started"]);

  await recorder.commitDeferredCompaction("session-deferred", "turn-1");
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "compaction_started",
    "compaction_completed",
  ]);
});

test("replacement failure closes the deferred compaction as failed", async () => {
  const { transcript, recorder } = turnRecorder();
  await recorder.startTurn("session-failed-replacement", "turn-1");
  await recorder.recordCompactionStarted("session-failed-replacement", "turn-1", {
    operationId: "op-replacement",
    trigger: "auto",
    messageCount: 2,
  });
  recorder.deferCompactionCompletion("session-failed-replacement", "turn-1", {
    operationId: "op-replacement",
    status: "compacted",
    tier: "full",
    compactionId: "compact-2",
    messageCount: 1,
  });

  await recorder.failDeferredCompaction(
    "session-failed-replacement",
    "turn-1",
    new Error("replacement append failed"),
  );
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "compaction_started",
    "compaction_failed",
  ]);
  const failed = transcript.entries[2];
  assert.equal(failed?.type, "compaction_failed");
  if (failed?.type === "compaction_failed") {
    assert.equal(failed.operationId, "op-replacement");
    assert.equal(failed.error, "replacement append failed");
  }
});

test("durable context closes a failed compaction bracket without exposing a result", async () => {
  const { transcript, recorder } = turnRecorder();
  await recorder.startTurn("session-2", "turn-2");
  const failure = new Error("summary unavailable");
  const delegate: AgentContextRuntime = {
    prepareForModel: async () => ({ messages: [], systemPromptParts: [], tools: [], diagnostics: [], boundaries: [] }),
    tryAutoCompact: async () => { throw failure; },
  };

  const runtime = createDurableContextRuntime(delegate, recorder);
  await assert.rejects(
    () => runtime.tryAutoCompact!({
      sessionId: "session-2",
      turnId: "turn-2",
      messages: [{ role: "user", content: [{ type: "text", text: "keep" }] }],
      allowFallbackOnFailure: true,
    }),
    /summary unavailable/,
  );

  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "compaction_started",
    "compaction_failed",
  ]);
  const failed = transcript.entries[2];
  assert.equal(failed?.type, "compaction_failed");
  if (failed?.type === "compaction_failed") {
    assert.equal(failed.operationId, "compact-op-1");
    assert.equal(failed.error, "summary unavailable");
  }
});

test("domain validation treats an unfinished compaction as a crash tail", () => {
  const base = {
    sessionId: "session-3",
    turnId: "turn-3",
    createdAt: "2026-09-07T00:00:00.000Z",
  };
  assert.doesNotThrow(() => validateSessionDomainLog([
    { ...base, type: "turn_started", sequence: 1 },
    { ...base, type: "compaction_started", sequence: 2, operationId: "op-3", trigger: "auto", messageCount: 1 },
  ]));
  assert.throws(
    () => validateSessionDomainLog([
      { ...base, type: "turn_started", sequence: 1 },
      { ...base, type: "compaction_started", sequence: 2, operationId: "op-3", trigger: "auto", messageCount: 1 },
      {
        ...base,
        type: "turn_result",
        sequence: 3,
        result: {
          type: "success",
          turnId: "turn-3",
          sessionId: "session-3",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: base.createdAt,
          completedAt: base.createdAt,
        },
      },
    ]),
    (error: unknown) => error instanceof SessionDomainValidationError && error.code === "turn_has_pending_compaction",
  );
});
