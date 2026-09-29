import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../../src/agent/protocol/result.js";
import { AgentHandle } from "../../../src/agent/scope/AgentHandle.js";
import { AgentSession } from "../../../src/agent/session/AgentSession.js";
import { AgentSessionEventRecorder } from "../../../src/agent/session/AgentSessionEventRecorder.js";
import { AgentTurnInbox } from "../../../src/agent/session/AgentTurnInbox.js";
import type { AgentLoopInput, AgentLoopRunResult } from "../../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";

const now = "2026-09-08T00:00:00.000Z";

test("agent turn inbox persists admission before mutation and restores only pending work", async () => {
  const transcript = new InMemoryTranscriptWriter({
    now: () => new Date(now),
    uuid: sequenceIds("entry"),
  });
  const recorder = new AgentSessionEventRecorder(transcript);
  const inbox = new AgentTurnInbox({ sessionId: "session-1", recorder });

  await inbox.enqueue(queuedTurn("item-1", "turn-1", "first"));
  await inbox.enqueue(queuedTurn("item-2", "turn-2", "second"));
  assert.deepEqual(inbox.snapshot().map((turn) => turn.itemId), ["item-1", "item-2"]);

  await recorder.startTurn("session-1", "turn-1", "item-1");
  inbox.markStarted("item-1", "turn-1");
  await inbox.discard("item-2", "cancelled");

  const restored = new AgentTurnInbox({
    sessionId: "session-1",
    recorder: new AgentSessionEventRecorder(transcript, { restoredEntries: transcript.entries }),
    restoredEntries: transcript.entries,
  });
  assert.equal(restored.size, 0);
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "agent_turn_enqueued",
    "agent_turn_enqueued",
    "turn_started",
    "agent_turn_discarded",
  ]);
  assert.equal(
    transcript.entries.find((entry) => entry.type === "turn_started")?.inboxItemId,
    "item-1",
  );
});

test("agent turn inbox does not mutate when durable admission fails", async () => {
  const transcript = new InMemoryTranscriptWriter();
  transcript.recordSessionEvent = async (_sessionId, _turnId, event) => {
    if (event.type === "agent_turn_enqueued") throw new Error("persistence unavailable");
  };
  const inbox = new AgentTurnInbox({
    sessionId: "session-1",
    recorder: new AgentSessionEventRecorder(transcript),
  });

  await assert.rejects(inbox.enqueue(queuedTurn("item-1", "turn-1", "first")), /persistence unavailable/);
  assert.equal(inbox.size, 0);
});

test("agent handle rechecks admission cancellation after waiting for an earlier enqueue", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let observeFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { observeFirst = resolve; });
  let enqueueCalls = 0;
  const session = {
    pendingTurnCount: 0,
    pendingTurns: () => [],
    enqueueTurn: async () => {
      enqueueCalls += 1;
      if (enqueueCalls === 1) {
        observeFirst();
        await firstGate;
      }
    },
  } as unknown as AgentSession;
  const handle = new AgentHandle(session);
  const controller = new AbortController();

  const first = handle.followup(
    { type: "text", text: "first" },
    { itemId: "item-1", turnId: "turn-1" },
  );
  await firstStarted;
  const cancelled = handle.followup(
    { type: "text", text: "cancelled" },
    { itemId: "item-2", turnId: "turn-2", abortSignal: controller.signal },
  );
  controller.abort("caller stopped");
  releaseFirst();

  await first;
  await assert.rejects(cancelled, /Agent follow-up admission aborted: caller stopped/);
  assert.equal(enqueueCalls, 1);
  await handle.dispose();
});

test("agent handle rechecks transient authority at the durable enqueue boundary", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let observeFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { observeFirst = resolve; });
  let enqueueCalls = 0;
  const session = {
    sessionId: "session-1",
    pendingTurnCount: 0,
    pendingTurns: () => [],
    enqueueTurn: async () => {
      enqueueCalls += 1;
      if (enqueueCalls === 1) {
        observeFirst();
        await firstGate;
      }
    },
  } as unknown as AgentSession;
  const handle = new AgentHandle(session);
  let authorized = true;

  const first = handle.followup(
    { type: "text", text: "first" },
    { itemId: "item-1", turnId: "turn-1" },
  );
  await firstStarted;
  const guarded = handle.followup(
    { type: "text", text: "guarded" },
    {
      itemId: "item-2",
      turnId: "turn-2",
      authorizeAdmission: () => {
        if (!authorized) throw new Error("stale authority");
      },
    },
  );
  authorized = false;
  releaseFirst();

  await first;
  await assert.rejects(guarded, /stale authority/);
  assert.equal(enqueueCalls, 1);
  await handle.dispose();
});

test("agent handle followup drives durable turns in FIFO order without a result wrapper", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let observeFirst!: () => void;
  const firstObserved = new Promise<void>((resolve) => { observeFirst = resolve; });
  const prompts: string[] = [];
  const transcript = new InMemoryTranscriptWriter({
    now: () => new Date(now),
    uuid: sequenceIds("entry"),
  });
  const session = sessionWithLoop(transcript, async (input) => {
    prompts.push(latestText(input));
    if (prompts.length === 1) {
      observeFirst();
      await firstGate;
    }
    return successResult(input);
  });
  const handle = new AgentHandle(session);
  const admissionController = new AbortController();
  assert.equal(session.sessionId, "session-1");
  assert.equal(handle.sessionId, "session-1");

  assert.deepEqual(await handle.followup(
    { type: "text", text: "first" },
    { itemId: "item-1", turnId: "turn-1", abortSignal: admissionController.signal },
  ), { itemId: "item-1", turnId: "turn-1" });
  await firstObserved;
  assert.deepEqual(await handle.followup(
    { type: "text", text: "second" },
    { itemId: "item-2", turnId: "turn-2" },
  ), { itemId: "item-2", turnId: "turn-2" });
  assert.deepEqual(handle.pendingTurns().map((turn) => turn.itemId), ["item-2"]);
  await assert.rejects(
    handle.submit({ type: "text", text: "bypass" }, { turnId: "turn-bypass" }).next(),
    /already has an active turn/,
  );

  releaseFirst();
  await handle.whenIdle();
  assert.deepEqual(prompts, ["first", "second"]);
  assert.equal(handle.pendingTurns().length, 0);
  const starts = transcript.entries.filter((entry) => entry.type === "turn_started");
  assert.deepEqual(starts.map((entry) => [entry.turnId, entry.inboxItemId]), [
    ["turn-1", "item-1"],
    ["turn-2", "item-2"],
  ]);
  const enqueued = transcript.entries.find((entry) => entry.type === "agent_turn_enqueued");
  assert.equal(enqueued?.type === "agent_turn_enqueued" && "abortSignal" in enqueued.submitOptions, false);
  assert.equal(enqueued?.type === "agent_turn_enqueued" && "authorizeAdmission" in enqueued.submitOptions, false);
  await handle.dispose();
});

test("agent handle stays non-idle until a followup queued behind a direct turn completes", async () => {
  let releaseDirect!: () => void;
  const directGate = new Promise<void>((resolve) => { releaseDirect = resolve; });
  let releaseQueued!: () => void;
  const queuedGate = new Promise<void>((resolve) => { releaseQueued = resolve; });
  let directStarted!: () => void;
  const observedDirect = new Promise<void>((resolve) => { directStarted = resolve; });
  let queuedStarted!: () => void;
  const observedQueued = new Promise<void>((resolve) => { queuedStarted = resolve; });
  const transcript = new InMemoryTranscriptWriter();
  const session = sessionWithLoop(transcript, async (input) => {
    const text = latestText(input);
    if (text === "direct") {
      directStarted();
      await directGate;
    } else {
      queuedStarted();
      await queuedGate;
    }
    return successResult(input);
  });
  const handle = new AgentHandle(session);

  const directRun = drain(handle.submit({ type: "text", text: "direct" }, { turnId: "turn-direct" }));
  await observedDirect;
  await handle.followup(
    { type: "text", text: "queued" },
    { itemId: "item-queued", turnId: "turn-queued" },
  );
  let idleResolved = false;
  const idle = handle.whenIdle().then(() => { idleResolved = true; });

  releaseDirect();
  await observedQueued;
  await directRun;
  assert.equal(idleResolved, false);

  releaseQueued();
  await idle;
  assert.equal(idleResolved, true);
  await handle.dispose();
});

test("queued admission failure keeps the accepted item pending for a later wake", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const recordSessionEvent = transcript.recordSessionEvent.bind(transcript);
  let failStart = true;
  transcript.recordSessionEvent = async (sessionId, turnId, event) => {
    if (event.type === "turn_started" && failStart) {
      failStart = false;
      throw new Error("start unavailable");
    }
    await recordSessionEvent(sessionId, turnId, event);
  };
  let reportFailure!: () => void;
  const failureReported = new Promise<void>((resolve) => { reportFailure = resolve; });
  const prompts: string[] = [];
  const session = sessionWithLoop(transcript, async (input) => {
    prompts.push(latestText(input));
    return successResult(input);
  });
  const handle = new AgentHandle(session, {
    onQueuedTurnError: (error, turn) => {
      assert.match(String(error), /start unavailable/);
      assert.equal(turn.itemId, "item-1");
      reportFailure();
    },
  });

  await handle.followup(
    { type: "text", text: "first" },
    { itemId: "item-1", turnId: "turn-1" },
  );
  await failureReported;
  assert.deepEqual(handle.pendingTurns().map((turn) => turn.itemId), ["item-1"]);

  await handle.followup(
    { type: "text", text: "second" },
    { itemId: "item-2", turnId: "turn-2" },
  );
  await handle.whenIdle();
  assert.deepEqual(prompts, ["first", "second"]);
  await handle.dispose();
});

test("agent handle disposal discards queued turns and drains the active queued turn", async () => {
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const prompts: string[] = [];
  const transcript = new InMemoryTranscriptWriter({
    now: () => new Date(now),
    uuid: sequenceIds("entry"),
  });
  const session = sessionWithLoop(transcript, async (input) => {
    prompts.push(latestText(input));
    firstStarted();
    await aborted(input.abortSignal);
    return abortedResult(input);
  });
  const handle = new AgentHandle(session);

  await handle.followup(
    { type: "text", text: "active" },
    { itemId: "item-active", turnId: "turn-active" },
  );
  await started;
  await handle.followup(
    { type: "text", text: "pending" },
    { itemId: "item-pending", turnId: "turn-pending" },
  );

  const disposal = handle.dispose("test_dispose");
  assert.equal(await handle.discardQueuedTurn("item-pending"), false);
  await assert.rejects(
    handle.followup({ type: "text", text: "late" }),
    /agent handle is draining/,
  );
  await disposal;

  assert.deepEqual(prompts, ["active"]);
  assert.equal(handle.state, "disposed");
  assert.equal(handle.pendingTurns().length, 0);
  const discarded = transcript.entries.find((entry) =>
    entry.type === "agent_turn_discarded" && entry.itemId === "item-pending");
  assert.equal(discarded?.type === "agent_turn_discarded" ? discarded.reason : undefined, "agent_disposed");
});

test("agent handle disposal reports a durable discard failure without deadlocking", async () => {
  let turnStarted!: () => void;
  const started = new Promise<void>((resolve) => { turnStarted = resolve; });
  const transcript = new InMemoryTranscriptWriter();
  const recordSessionEvent = transcript.recordSessionEvent.bind(transcript);
  let failDiscard = false;
  transcript.recordSessionEvent = async (sessionId, turnId, event) => {
    if (event.type === "agent_turn_discarded" && failDiscard) {
      throw new Error("discard unavailable");
    }
    await recordSessionEvent(sessionId, turnId, event);
  };
  const session = sessionWithLoop(transcript, async (input) => {
    turnStarted();
    await aborted(input.abortSignal);
    return abortedResult(input);
  });
  const handle = new AgentHandle(session);

  const activeRun = drain(handle.submit(
    { type: "text", text: "active" },
    { turnId: "turn-active" },
  ));
  await started;
  await handle.followup(
    { type: "text", text: "pending" },
    { itemId: "item-pending", turnId: "turn-pending" },
  );
  failDiscard = true;

  await assert.rejects(handle.dispose("test_dispose"), /Failed to dispose agent handle/);
  await activeRun;
  assert.equal(handle.state, "disposed");
  assert.deepEqual(handle.pendingTurns().map((turn) => turn.itemId), ["item-pending"]);
});

function sessionWithLoop(
  transcript: InMemoryTranscriptWriter,
  run: (input: AgentLoopInput) => Promise<AgentTurnResult>,
): AgentSession {
  const loop = {
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      const result = await run(input);
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
      return { result, messages: input.messages };
    },
  };
  const recorder = new AgentSessionEventRecorder(transcript);
  const runner = new TurnRunner(
    loop as never,
    transcript,
    undefined,
    () => new Date(now),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { eventRecorder: recorder },
  );
  return new AgentSession({
    sessionId: "session-1",
    turnRunner: runner,
    eventRecorder: recorder,
  });
}

function queuedTurn(itemId: string, turnId: string, text: string) {
  return {
    itemId,
    turnId,
    input: { type: "text" as const, text },
    submitOptions: {},
  };
}

function latestText(input: AgentLoopInput): string {
  const message = input.messages.at(-1);
  const block = message?.content[0];
  return block?.type === "text" ? block.text : "";
}

function successResult(input: AgentLoopInput): AgentTurnResult {
  return {
    type: "success",
    sessionId: input.sessionId,
    turnId: input.turnId,
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: now,
    completedAt: now,
  };
}

function abortedResult(input: AgentLoopInput): AgentTurnResult {
  return {
    type: "aborted",
    sessionId: input.sessionId,
    turnId: input.turnId,
    stopReason: "aborted_streaming",
    usage: {},
    permissionDenials: [],
    turns: 0,
    startedAt: now,
    completedAt: now,
  };
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

async function drain(iterator: AsyncGenerator<AgentEvent, void, unknown>): Promise<void> {
  while (!(await iterator.next()).done) {
    // Drain the event stream to completion.
  }
}
