import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

const result: AgentTurnResult = {
  type: "success",
  sessionId: "session-1",
  turnId: "turn-1",
  stopReason: "completed",
  usage: {},
  permissionDenials: [],
  turns: 1,
  startedAt: "2026-08-21T00:00:00.000Z",
  completedAt: "2026-08-21T00:00:01.000Z",
};

test("TurnRunner emits one terminal event when the loop reports a duplicate completion", async () => {
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
      return { result, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    new InMemoryTranscriptWriter(),
    undefined,
    () => new Date("2026-08-21T00:00:00.000Z"),
    undefined,
    { cwd: "/workspace/project", transcriptPath: "", collectFileArtifacts: false },
    { autoGenerateSessionTitle: false },
  );

  const events: AgentEvent[] = [];
  for await (const event of runner.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "hello" },
  })) {
    events.push(event);
  }

  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.equal(events.at(-1)?.type, "turn_completed");
});

test("TurnRunner converts accepted-input transcript failure into a structured failed turn", async () => {
  let loopCalled = false;
  const loop = {
    async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      loopCalled = true;
      throw new Error("loop must not run after transcript failure");
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const transcript = {
    recordAcceptedInput: async () => {
      throw new Error("disk full");
    },
    recordDurableMessage: async () => undefined,
    recordTurnResult: async () => undefined,
  };
  const runner = new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date("2026-08-21T00:00:00.000Z"),
    undefined,
    { cwd: "/workspace/project", transcriptPath: "", collectFileArtifacts: false },
    { autoGenerateSessionTitle: false },
  );
  const events: AgentEvent[] = [];
  for await (const event of runner.run({
    sessionId: "transcript-failure",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "hello" },
  })) {
    events.push(event);
  }

  assert.equal(loopCalled, false);
  assert.ok(events.some((event) => event.type === "turn_failed"));
  const terminal = events.find((event) => event.type === "turn_completed");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.type : undefined, "error");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.stopReason : undefined, "model_error");
});
