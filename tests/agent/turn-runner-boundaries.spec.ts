import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

const completed: AgentTurnResult = {
  type: "success",
  sessionId: "session-boundary",
  turnId: "turn-boundary",
  stopReason: "completed",
  usage: {},
  permissionDenials: [],
  turns: 1,
  startedAt: "2026-08-23T00:00:00.000Z",
  completedAt: "2026-08-23T00:00:01.000Z",
};

function runner(
  loop: AgentLoop,
  options: {
    inputProcessor?: { accept: () => { messages: []; shouldCallModel: boolean } };
    lifecycle?: { dispatch: () => Promise<{ effects: Array<{ type: "block"; reason: string }>; messages: never[]; events: never[]; blockingErrors: never[]; nonBlockingErrors: never[] }> };
    transcript?: InMemoryTranscriptWriter;
  } = {},
): { runner: TurnRunner; transcript: InMemoryTranscriptWriter } {
  const transcript = options.transcript ?? new InMemoryTranscriptWriter();
  return {
    runner: new TurnRunner(
      loop,
      transcript,
      options.inputProcessor as never,
      () => new Date("2026-08-23T00:00:01.000Z"),
      options.lifecycle as never,
      { cwd: "/workspace/project", transcriptPath: "", collectFileArtifacts: false },
      { autoGenerateSessionTitle: false },
    ),
    transcript,
  };
}

function input(options: Record<string, unknown> = {}) {
  return {
    sessionId: "session-boundary",
    turnId: "turn-boundary",
    messages: [],
    input: { type: "text", text: "hello", ...options } as never,
  };
}

test("TurnRunner handles a lifecycle block before model execution", async () => {
  let called = false;
  const loop = {
    async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      called = true;
      return { result: completed, messages: [] };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const { runner: turnRunner } = runner(loop, {
    lifecycle: {
      dispatch: async () => ({
        effects: [{ type: "block", reason: "policy" }],
        messages: [], events: [], blockingErrors: [], nonBlockingErrors: [],
      }),
    },
  });

  const events: AgentEvent[] = [];
  for await (const event of turnRunner.run(input())) events.push(event);
  assert.equal(called, false);
  assert.ok(events.some((event) => event.type === "turn_failed"));
  const terminal = events.find((event) => event.type === "turn_completed");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.type : undefined, "error");
  assert.equal(terminal?.type === "turn_completed" ? terminal.result.stopReason : undefined, "model_error");
});

test("TurnRunner converts an input that must not call the model into a terminal error", async () => {
  let called = false;
  const loop = {
    async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      called = true;
      return { result: completed, messages: [] };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const { runner: turnRunner } = runner(loop, {
    inputProcessor: { accept: () => ({ messages: [], shouldCallModel: false }) },
  });
  const events: AgentEvent[] = [];
  for await (const event of turnRunner.run(input())) events.push(event);
  assert.equal(called, false);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.ok(events.some((event) => event.type === "agent_status"));
});

test("TurnRunner normalizes loop errors and emits a single visible failure", async () => {
  const loop = {
    async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      throw new Error("router crashed");
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const { runner: turnRunner, transcript } = runner(loop);
  const events: AgentEvent[] = [];
  for await (const event of turnRunner.run(input())) events.push(event);
  assert.equal(events.filter((event) => event.type === "turn_failed").length, 1);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.ok(transcript.entries.some((entry) => entry.type === "turn_result"));
});

test("TurnRunner forwards non-text input, synthetic messages and durable callbacks", async () => {
  let received: AgentLoopInput | undefined;
  const loop = {
    async *run(options: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      received = options;
      options.onDurableMessage?.({ role: "assistant", content: [{ type: "text", text: "durable" }] });
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result: completed };
      return { result: completed, messages: options.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const { runner: turnRunner } = runner(loop);
  const events: AgentEvent[] = [];
  for await (const event of turnRunner.run({
    ...input(),
    input: { type: "content", content: [{ type: "text", text: "content input" }] } as never,
    syntheticMessages: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }],
    permissionMode: "plan",
    runMode: "ask",
    basePermissionMode: "default",
    allowPlanModeTools: true,
  })) events.push(event);
  assert.equal(received?.messages.length, 2);
  assert.equal(received?.messages[1]?.metadata?.synthetic, undefined);
  assert.ok(events.some((event) => event.type === "input_accepted"));
});

test("TurnRunner consumes internal artifact events and persists status/control callbacks", async () => {
  const loop = {
    async *run(options: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      await options.onAgentStatusMessage?.({ event: "progress", kind: "status", text: "working" } as never);
      await options.onCompactPersisted?.({
        boundary: { type: "compact", retainedMessages: 1 },
        messages: [{ role: "user", content: [{ type: "text", text: "compact" }] }],
      } as never);
      yield { type: "tool_result", sessionId: options.sessionId, turnId: options.turnId, result: { type: "success", toolCallId: "call-1", toolName: "read_file", content: [] } } as never;
      yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts: [] } as never;
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: { code: "agent_failed", message: "failed" } } as never;
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result: completed };
      return { result: completed, messages: options.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const { runner: turnRunner, transcript } = runner(loop);
  const events: AgentEvent[] = [];
  for await (const event of turnRunner.run(input())) events.push(event);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.ok(transcript.entries.some((entry) => entry.type === "control_boundary"));
  assert.ok(transcript.entries.some((entry) => entry.type === "agent_status_message"));
});

test("TurnRunner exposes reload and file snapshots without sharing mutable state", () => {
  const transcript = new InMemoryTranscriptWriter();
  const fileState = { files: [{ path: "README.md", hash: "abc" }] };
  const loop = {
    async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      return { result: completed, messages: [] };
    },
    snapshotFileState: () => fileState,
  } as unknown as AgentLoop;
  const { runner: turnRunner } = runner(loop, { transcript });

  const snapshot = turnRunner.snapshotForRuntimeReload();
  assert.deepEqual(snapshot.runtimeContext, {
    cwd: "/workspace/project",
    transcriptPath: "",
    collectFileArtifacts: false,
  });
  assert.deepEqual(snapshot.transcriptWriterState, { sequence: 0, lastEntryId: null });
  assert.deepEqual(turnRunner.snapshotFileState(), fileState);

  snapshot.runtimeContext.cwd = "/changed";
  assert.equal(turnRunner.snapshotForRuntimeReload().runtimeContext.cwd, "/workspace/project");
});
