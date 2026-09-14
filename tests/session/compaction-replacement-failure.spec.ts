import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopRunResult,
} from "../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

test("TurnRunner aborts before the next dispatch when replacement persistence fails", async () => {
  const result: AgentTurnResult = {
    type: "aborted",
    sessionId: "session-replacement-failure",
    turnId: "turn-1",
    stopReason: "aborted_streaming",
    usage: {},
    permissionDenials: [],
    turns: 0,
    startedAt: "2026-09-07T00:00:00.000Z",
    completedAt: "2026-09-07T00:00:01.000Z",
  };

  class FailingReplacementTranscript extends InMemoryTranscriptWriter {
    override recordCompactionReplacement(): Promise<void> {
      return Promise.reject(new Error("replacement append failed"));
    }
  }

  let dispatches = 0;
  let runner!: TurnRunner;
  const fakeLoop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      await runner.sessionEventRecorder.recordCompactionStarted(input.sessionId, input.turnId, {
        operationId: "op-replacement",
        trigger: "auto",
        messageCount: input.messages.length,
      });
      runner.sessionEventRecorder.deferCompactionCompletion(input.sessionId, input.turnId, {
        operationId: "op-replacement",
        status: "compacted",
        tier: "full",
        compactionId: "compact-1",
        messageCount: input.messages.length,
      });

      await input.onCompactPersisted?.({
        boundary: {
          kind: "compact",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 20 },
        },
        messages: [{ role: "assistant", content: [{ type: "text", text: "summary" }] }],
      });
      if (!input.abortSignal?.aborted) dispatches += 1;
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
      return { result, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;

  const transcript = new FailingReplacementTranscript();
  runner = new TurnRunner(
    fakeLoop,
    transcript,
    undefined,
    () => new Date("2026-09-07T00:00:01.000Z"),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
  );

  for await (const _event of runner.run({
    sessionId: "session-replacement-failure",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "Continue" },
  })) {
    // Drain the runner so its durable turn result is committed.
  }

  assert.equal(dispatches, 0);
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "accepted_input",
    "compaction_started",
    "compaction_failed",
    "turn_result",
  ]);
  const failure = transcript.entries.find((entry) => entry.type === "compaction_failed");
  assert.equal(failure?.type, "compaction_failed");
  if (failure?.type === "compaction_failed") {
    assert.equal(failure.error, "replacement append failed");
  }
});
