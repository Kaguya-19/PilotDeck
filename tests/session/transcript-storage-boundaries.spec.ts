import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildConversationChain } from "../../src/session/transcript/TranscriptChain.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { replaySubagentTranscript } from "../../src/session/transcript/replaySubagentTranscript.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";

const createdAt = "2026-08-23T00:00:00.000Z";

function fields(sequence: number, entryId?: string, parentEntryId?: string, turnId = "turn-1") {
  return {
    sessionId: "session-1",
    turnId,
    sequence,
    createdAt,
    ...(entryId ? { entryId } : {}),
    ...(parentEntryId ? { parentEntryId } : {}),
  };
}

function completed(turnId = "turn-1") {
  return {
    type: "success" as const,
    sessionId: "session-1",
    turnId,
    stopReason: "completed" as const,
    usage: { inputTokens: 2, outputTokens: 3 },
    permissionDenials: [],
    turns: 1,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}

test("readTranscript reports missing, invalid, malformed and oversized files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-transcript-read-"));
  try {
    const missing = await readTranscript(join(dir, "missing.jsonl"));
    assert.equal(missing.entries.length, 0);
    assert.equal(missing.diagnostics[0]?.code, "transcript_missing");

    const path = join(dir, "mixed.jsonl");
    const first = { type: "accepted_input" as const, ...fields(2, "entry-2"), messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "second" }] }] };
    const second = { type: "turn_result" as const, ...fields(1, "entry-1"), result: completed() };
    await writeFile(path, `${JSON.stringify(first)}\nnot-json\n${JSON.stringify({ nope: true })}\n\n${JSON.stringify(second)}\n`);
    const mixed = await readTranscript(path);
    assert.deepEqual(mixed.entries.map((entry) => entry.sequence), [1, 2]);
    assert.deepEqual(mixed.diagnostics.map((diagnostic) => diagnostic.code), [
      "transcript_line_invalid",
      "transcript_entry_invalid",
    ]);

    const oversized = await readTranscript(path, { maxBytes: 2 });
    assert.equal(oversized.entries.length, 0);
    assert.equal(oversized.diagnostics[0]?.code, "transcript_too_large");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildConversationChain falls back for legacy entries and selects the longest branch", () => {
  const legacy = buildConversationChain([
    { type: "accepted_input" as const, ...fields(1), messages: [] },
    { type: "turn_result" as const, ...fields(2), result: completed() },
  ]);
  assert.equal(legacy.chain.length, 2);
  assert.equal(legacy.diagnostics[0]?.severity, "warning");

  const root = { type: "accepted_input" as const, ...fields(1, "root"), messages: [] };
  const short = { type: "turn_result" as const, ...fields(2, "short", "root"), result: completed() };
  const long = { type: "assistant_message" as const, ...fields(3, "long", "root"), message: { role: "assistant" as const, content: [{ type: "text" as const, text: "reply" }] } };
  const leaf = { type: "turn_result" as const, ...fields(4, "leaf", "long"), result: completed() };
  const orphan = { type: "turn_result" as const, ...fields(5, "orphan", "missing"), result: completed() };
  const result = buildConversationChain([short, orphan, leaf, root, long]);
  assert.deepEqual(result.chain.map((entry) => entry.entryId), ["root", "long", "leaf", "orphan"]);
  assert.deepEqual(result.orphans.map((entry) => entry.entryId), ["orphan"]);
  assert.equal(result.leaves.some((entry) => entry.entryId === "short"), true);
  assert.equal(result.leaves.some((entry) => entry.entryId === "leaf"), true);
});

test("buildConversationChain recovers a cycle using the first identified entry", () => {
  const a = { type: "accepted_input" as const, ...fields(1, "a", "b"), messages: [] };
  const b = { type: "turn_result" as const, ...fields(2, "b", "a"), result: completed() };
  const result = buildConversationChain([a, b]);
  assert.equal(result.roots[0]?.entryId, "a");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.message.includes("possible cycle")), true);
});

test("replayTranscriptEntries filters incomplete turns, merges metadata and usage, and clones output", () => {
  const accepted = { type: "accepted_input" as const, ...fields(1, "accepted"), messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }] };
  const completeAssistant = { type: "assistant_message" as const, ...fields(2, "assistant"), message: { role: "assistant" as const, content: [{ type: "text" as const, text: "answer" }] } };
  const incomplete = { type: "durable_message" as const, ...fields(3, "incomplete", undefined, "turn-incomplete"), message: { role: "user" as const, content: [{ type: "text" as const, text: "discard" }] } };
  const metadata = { type: "session_metadata" as const, ...fields(4, "metadata"), metadata: { title: "new", tag: "tag" } };
  const result = { type: "turn_result" as const, ...fields(5, "done"), result: completed() };
  const replay = replayTranscriptEntries([accepted, completeAssistant, incomplete, metadata, result]);
  assert.equal(replay.messages.length, 2);
  assert.equal(replay.events.filter((event) => event.type === "input_accepted").length, 1);
  assert.equal(replay.events.filter((event) => event.type === "assistant_message").length, 1);
  assert.equal(replay.usage.inputTokens, 2);
  assert.equal(replay.usage.outputTokens, 3);
  assert.equal(replay.metadata.title, "new");
  assert.equal(replay.metadata.tag, "tag");
  assert.equal(replay.diagnostics.length, 1);
  const original = (replay.messages[0]?.content[0] as { text: string }).text;
  (replay.messages[0]?.content[0] as { text: string }).text = "mutated";
  assert.equal((accepted.messages[0]?.content[0] as { text: string }).text, original);
});

test("JsonlTranscriptWriter serializes records in order and supports restore and sidechains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-transcript-writer-"));
  try {
    const path = join(dir, "session.jsonl");
    const now = () => new Date(createdAt);
    const writer = new JsonlTranscriptWriter({ path, now });
    await Promise.all([
      writer.recordAcceptedInput("session-1", "turn-1", [{ role: "user", content: [{ type: "text", text: "hello" }] }], {}),
      writer.recordDurableMessage("session-1", "turn-1", { role: "assistant", content: [{ type: "text", text: "answer" }] }),
      writer.recordAgentStatusMessage("session-1", "turn-1", { event: "working", kind: "status", text: "Working" }),
      writer.recordFileArtifacts("session-1", "turn-1", []),
      writer.recordTurnResult("session-1", "turn-1", completed()),
      writer.recordSessionMetadata("session-1", "turn-1", { title: "title" }),
      writer.recordControlBoundary("session-1", "turn-1", { kind: "resume", metadata: { source: "test" } }),
      writer.recordSubagentStarted("session-1", "turn-1", {
        subagentId: "sub-1", subagentType: "explore", prompt: "p".repeat(2_000), transcriptRelativePath: "subagents/sub-1.jsonl",
      }),
      writer.recordSubagentCompleted("session-1", "turn-1", {
        subagentId: "sub-1", subagentType: "explore", summary: "done", turns: 1, durationMs: 4, errored: false,
      }),
    ]);
    const read = await readTranscript(path);
    assert.equal(read.entries.length, 8);
    assert.deepEqual(read.entries.map((entry) => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
    const started = read.entries.find((entry) => entry.type === "subagent_started");
    assert.equal(started?.type, "subagent_started");
    assert.equal(started.promptTruncated, true);
    assert.equal(writer.snapshotState().sequence, 8);

    writer.restoreState(20, "tail");
    await writer.recordSessionMetadata("session-1", "turn-2", { title: "restored" });
    const restored = await readTranscript(path);
    assert.equal(restored.entries.at(-1)?.sequence, 21);
    assert.equal(restored.entries.at(-1)?.parentEntryId, "tail");

    const handle = writer.forSubagent("sub-2");
    assert.match(handle.transcriptPath, /session\/subagents\/sub-2\.jsonl$/);
    assert.equal(writer.relativeSubagentPath("sub-2"), "session/subagents/sub-2.jsonl");
    await handle.writer.recordAcceptedInput("sub-2", "turn-sub", [{ role: "user", content: [{ type: "text", text: "child" }] }]);
    const child = await replaySubagentTranscript(handle.transcriptPath);
    assert.equal(child.messages.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replaySubagentTranscript returns diagnostics for a missing sidechain", async () => {
  const replay = await replaySubagentTranscript(join(tmpdir(), "pilotdeck-no-sidechain.jsonl"));
  assert.equal(replay.messages.length, 0);
  assert.equal(replay.diagnostics[0]?.code, "transcript_missing");
});

test("TranscriptEntry helpers classify messages and preserve UTF-8 preview boundaries", async () => {
  const { classifyDurableMessageEntry, truncatePreview } = await import("../../src/session/transcript/TranscriptEntry.js");
  assert.equal(classifyDurableMessageEntry({ role: "assistant", content: [{ type: "text", text: "a" }] }), "assistant_message");
  assert.equal(classifyDurableMessageEntry({ role: "user", content: [{ type: "tool_result", toolCallId: "c", content: [{ type: "text", text: "x" }] }] }), "tool_result_message");
  assert.equal(classifyDurableMessageEntry({ role: "user", content: [{ type: "text", text: "a" }] }), "durable_message");
  const preview = truncatePreview("你好世界", 7);
  assert.equal(preview.truncated, true);
  assert.equal(Buffer.byteLength(preview.preview, "utf8") <= 7, true);
});
