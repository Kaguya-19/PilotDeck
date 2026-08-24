import assert from "node:assert/strict";
import test from "node:test";

import { AgentSession } from "../../src/agent/session/AgentSession.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentInput } from "../../src/agent/protocol/input.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type {
  TurnRunner,
  TurnRunnerOptions,
  TurnRunnerResult,
  TurnRunnerRuntimeReloadSnapshot,
} from "../../src/agent/turn/TurnRunner.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { createInitialAgentSessionState } from "../../src/agent/session/AgentSessionState.js";

const completedResult = (sessionId: string, turnId: string): AgentTurnResult => ({
  type: "success",
  sessionId,
  turnId,
  stopReason: "completed",
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  permissionDenials: [],
  turns: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
});

function fakeRunner(
  run: (input: TurnRunnerOptions) => AsyncGenerator<AgentEvent, TurnRunnerResult, unknown>,
  reloadSnapshot: TurnRunnerRuntimeReloadSnapshot = { runtimeContext: { cwd: "/tmp", transcriptPath: "" } },
): TurnRunner {
  return {
    run,
    snapshotForRuntimeReload: () => reloadSnapshot,
    snapshotFileState: () => ({}),
  } as unknown as TurnRunner;
}

test("AgentSession emits one session lifecycle around each turn and persists the result", async () => {
  const sessionId = "session-1";
  const turnId = "turn-1";
  const input: AgentInput = { type: "text", text: "hello" };
  const session = new AgentSession({
    sessionId,
    uuid: () => turnId,
    turnRunner: fakeRunner(async function* (options) {
      yield { type: "turn_started", sessionId, turnId: options.turnId };
      yield { type: "input_accepted", sessionId, turnId: options.turnId, messages: [] };
      yield { type: "turn_completed", sessionId, turnId: options.turnId, result: completedResult(sessionId, options.turnId) };
      return { result: completedResult(sessionId, options.turnId), messages: [] };
    }),
  });

  const events: Array<{ type: string; sessionId?: string; turnId?: string }> = [];
  for await (const event of session.submit(input)) events.push(event as typeof events[number]);

  assert.deepEqual(events.map((event) => event.type), [
    "session_started",
    "setup_completed",
    "turn_started",
    "input_accepted",
    "turn_completed",
    "session_ended",
  ]);
  assert.ok(events.every((event) => !event.turnId || event.turnId === turnId));
  const snapshot = session.snapshot();
  assert.equal(snapshot.sessionId, sessionId);
  assert.deepEqual(snapshot.messages, []);
  assert.deepEqual(snapshot.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  });
  assert.deepEqual(snapshot.permissionDenials, []);
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.currentTurnId, undefined);
});

test("AgentSession abort propagates the reason and closes the turn after the runner unwinds", async () => {
  const sessionId = "session-2";
  const turnId = "turn-2";
  let abortReason: unknown;
  let releaseRunner!: () => void;
  let runnerStarted!: () => void;
  const started = new Promise<void>((resolve) => { runnerStarted = resolve; });
  const session = new AgentSession({
    sessionId,
    turnRunner: fakeRunner(async function* (options) {
      yield { type: "turn_started", sessionId, turnId: options.turnId };
      await new Promise<void>((resolve) => {
        releaseRunner = resolve;
        runnerStarted();
        options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      const result: AgentTurnResult = {
        ...completedResult(sessionId, options.turnId),
        type: "aborted",
        stopReason: "aborted_streaming",
      };
      yield { type: "turn_completed", sessionId, turnId: options.turnId, result };
      return { result, messages: [] as CanonicalMessage[] };
    }),
  });
  const originalAbort = session.abort.bind(session);
  session.abort = (reason?: string) => {
    abortReason = reason;
    originalAbort(reason);
  };

  const iterator = session.submit({ type: "text", text: "wait" }, { turnId });
  await iterator.next();
  await iterator.next();
  await iterator.next();
  const pending = iterator.next();
  await started;
  session.abort("user_stop");
  releaseRunner();
  await pending;
  const ended = await iterator.next();

  assert.equal(abortReason, "user_stop");
  assert.equal(ended.value?.type, "session_ended");
  assert.equal(session.snapshot().status, "aborted");
  assert.equal(session.snapshot().currentTurnId, undefined);
});

test("AgentSession runtime reload preserves state and runtime-owned snapshots without preserving an active turn", () => {
  const sessionId = "reload-session";
  const initialState = createInitialAgentSessionState(sessionId);
  initialState.messages = [{ role: "user", content: [{ type: "text", text: "keep this" }] }];
  initialState.usage = { inputTokens: 7, totalTokens: 7 };
  initialState.status = "running";
  initialState.currentTurnId = "old-turn";
  const runtimeSnapshot: TurnRunnerRuntimeReloadSnapshot = {
    runtimeContext: { cwd: "/workspace/project", transcriptPath: "/workspace/session.jsonl" },
    transcriptWriterState: { sequence: 8, lastEntryId: "entry-8" },
    metadata: { title: "Saved title", firstPrompt: "keep this" },
  };
  const session = new AgentSession({
    sessionId,
    initialState,
    turnRunner: fakeRunner(async function* () {
      return { result: completedResult(sessionId, "unused"), messages: [] };
    }, runtimeSnapshot),
  });

  const reload = session.snapshotForRuntimeReload();
  assert.equal(reload.state.sessionId, sessionId);
  assert.deepEqual(reload.state.messages, initialState.messages);
  assert.deepEqual(reload.state.usage, initialState.usage);
  assert.equal(reload.state.status, "idle");
  assert.equal(reload.state.currentTurnId, undefined);
  assert.equal(reload.cwd, runtimeSnapshot.runtimeContext.cwd);
  assert.equal(reload.transcriptPath, runtimeSnapshot.runtimeContext.transcriptPath);
  assert.deepEqual(reload.transcriptWriterState, runtimeSnapshot.transcriptWriterState);
  assert.deepEqual(reload.metadata, runtimeSnapshot.metadata);
  assert.deepEqual(reload.fileState, {});
});

test("AgentSession accumulates usage across consecutive turns and resets current turn state", async () => {
  const sessionId = "multi-turn";
  const session = new AgentSession({
    sessionId,
    turnRunner: fakeRunner(async function* (options) {
      const result = completedResult(sessionId, options.turnId);
      yield { type: "turn_completed", sessionId, turnId: options.turnId, result };
      return { result, messages: [] as CanonicalMessage[] };
    }),
  });

  for (const turnId of ["turn-1", "turn-2"]) {
    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: turnId }, { turnId })) events.push(event);
    assert.equal(events.at(-1)?.type, "session_ended");
    assert.equal(session.snapshot().currentTurnId, undefined);
    assert.equal(session.snapshot().status, "idle");
  }

  assert.deepEqual(session.snapshot().usage, {
    inputTokens: 4,
    outputTokens: 6,
    totalTokens: 10,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  });
});
