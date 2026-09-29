import assert from "node:assert/strict";
import test from "node:test";

import { AgentSessionEventRecorder } from "../../src/agent/session/AgentSessionEventRecorder.js";
import { createDurableElicitationChannel } from "../../src/agent/modules/interaction/durableElicitationChannel.js";
import { InMemoryElicitationChannel } from "../../src/tool/elicitation/PilotDeckElicitationChannel.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { validateSessionDomainLog, SessionDomainValidationError } from "../../src/session/events/index.js";

const request = {
  toolCallId: "turn-1",
  toolName: "ask_user_question",
  questions: [{ question: "Which?", header: "Choice", options: [
    { label: "A", description: "A" },
    { label: "B", description: "B" },
  ] }],
};

test("durable elicitation records lifecycle without persisting answer payload", async () => {
  let entryId = 0;
  const transcript = new InMemoryTranscriptWriter({ uuid: () => `entry-${++entryId}` });
  const recorder = new AgentSessionEventRecorder(transcript, { uuid: () => "question-op-1" });
  await recorder.startTurn("session-question", "turn-1");
  const channel = createDurableElicitationChannel(
    new InMemoryElicitationChannel({ "Which?": "A" }),
    recorder,
    { sessionId: "session-question", uuid: () => "question-op-1" },
  );

  const answer = await channel.askUser(request);
  assert.deepEqual(answer, { type: "answered", answers: { "Which?": "A" } });
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "question_started",
    "question_completed",
  ]);
  assert.equal(JSON.stringify(transcript.entries).includes('"answers"'), false);
});

test("durable elicitation closes cancellation and rejects turn closure with a crash tail", async () => {
  let entryId = 0;
  const transcript = new InMemoryTranscriptWriter({ uuid: () => `entry-${++entryId}` });
  const recorder = new AgentSessionEventRecorder(transcript, { uuid: () => "question-op-2" });
  await recorder.startTurn("session-question-cancel", "turn-1");
  const channel = createDurableElicitationChannel(
    new InMemoryElicitationChannel({}, { cancelOnAsk: true }),
    recorder,
    { sessionId: "session-question-cancel", uuid: () => "question-op-2" },
  );
  const answer = await channel.askUser(request);
  assert.deepEqual(answer, { type: "cancelled", reason: "in-memory cancel" });
  assert.doesNotThrow(() => validateSessionDomainLog(transcript.entries));
});

test("domain validation rejects a turn result with an unfinished question audit", () => {
  assert.throws(
    () => validateSessionDomainLog([
      { sessionId: "session-question-tail", turnId: "turn-1", sequence: 1, createdAt: "2026-09-07T00:00:00.000Z", type: "turn_started" },
      { sessionId: "session-question-tail", turnId: "turn-1", sequence: 2, createdAt: "2026-09-07T00:00:00.000Z", type: "question_started", operationId: "question-op", toolCallId: "turn-1", toolName: "ask_user_question", questionCount: 1 },
      { sessionId: "session-question-tail", turnId: "turn-1", sequence: 3, createdAt: "2026-09-07T00:00:00.000Z", type: "turn_result", result: {
        type: "success", sessionId: "session-question-tail", turnId: "turn-1", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "2026-09-07T00:00:00.000Z", completedAt: "2026-09-07T00:00:00.000Z",
      } },
    ]),
    (error: unknown) => error instanceof SessionDomainValidationError && error.code === "turn_has_pending_question",
  );
});
