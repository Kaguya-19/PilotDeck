import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { SessionMetadataStore } from "../../src/session/metadata/SessionMetadataStore.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

const turnResult = (sessionId: string, turnId: string): AgentTurnResult => ({
  type: "success",
  sessionId,
  turnId,
  stopReason: "completed",
  usage: {},
  permissionDenials: [],
  turns: 1,
  startedAt: "2026-08-21T00:00:00.000Z",
  completedAt: "2026-08-21T00:00:01.000Z",
});

function createRunner(
  metadataStore: SessionMetadataStore,
  transcript: InMemoryTranscriptWriter,
  generateTitle: (input: { text: string; sessionId: string; turnId: string; signal: AbortSignal }) => Promise<string | null>,
): TurnRunner {
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      const result = turnResult(input.sessionId, input.turnId);
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
      return { result, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  return new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date("2026-08-21T00:00:00.000Z"),
    undefined,
    { cwd: "/workspace/project", transcriptPath: "", collectFileArtifacts: false },
    { metadataStore, sessionTitleGenerator: generateTitle, autoGenerateSessionTitle: true },
  );
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("TurnRunner shares one pending title generation across concurrent turns", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId: "title-race" });
  let calls = 0;
  let resolveTitle!: (title: string) => void;
  const titleReady = new Promise<string>((resolve) => { resolveTitle = resolve; });
  const runner = createRunner(metadataStore, transcript, async () => {
    calls += 1;
    return titleReady;
  });

  const first = collect(runner.run({
    sessionId: "title-race",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "first prompt" },
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = collect(runner.run({
    sessionId: "title-race",
    turnId: "turn-2",
    messages: [],
    input: { type: "text", text: "second prompt" },
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  resolveTitle("AI title");
  await Promise.all([first, second]);
  assert.equal(metadataStore.getSnapshot().aiTitle, "AI title");
});

test("TurnRunner never lets a manual title get overwritten by a late AI title", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId: "manual-title" });
  let resolveTitle!: (title: string) => void;
  const titleReady = new Promise<string>((resolve) => { resolveTitle = resolve; });
  const runner = createRunner(metadataStore, transcript, async () => titleReady);

  const pending = collect(runner.run({
    sessionId: "manual-title",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "generate a title" },
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await metadataStore.saveTitle("Manual title", "manual-turn");
  resolveTitle("Late AI title");
  await pending;

  const snapshot = metadataStore.getSnapshot();
  assert.equal(snapshot.title, "Manual title");
  assert.equal(snapshot.aiTitle, undefined);
});
