import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemorySessionEventStore,
  JsonlSessionEventStore,
  SessionEventValidationError,
  type SessionEventStore,
} from "../../src/session/events/index.js";
import { projectWebHistory } from "../../src/session/projection/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";

const createdAt = "2026-09-06T00:00:00.000Z";

function metadataEntry(
  sequence: number,
  entryId?: string,
  parentEntryId?: string | null,
): AgentTranscriptEntry {
  return {
    type: "session_metadata",
    sessionId: "session-validation",
    turnId: `turn-${sequence}`,
    sequence,
    createdAt,
    ...(entryId !== undefined ? { entryId } : {}),
    ...(parentEntryId !== undefined ? { parentEntryId } : {}),
    metadata: { title: `Entry ${sequence}` },
  };
}

function runSessionEventStoreContract(
  name: string,
  createStore: () => SessionEventStore,
): void {
  test(`${name} materializes ordered session events and restores writer state`, async () => {
    const store = createStore();

    const first = await store.append("session-store", "turn-1", {
      type: "session_metadata",
      metadata: { title: "First" },
    });
    const second = await store.append("session-store", "turn-1", {
      type: "accepted_input",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    assert.equal(first.sequence, 1);
    assert.equal(first.parentEntryId, null);
    assert.equal(second.sequence, 2);
    assert.equal(second.parentEntryId, first.entryId);
    assert.equal(first.createdAt, createdAt);
    assert.deepEqual(store.snapshotState(), { sequence: 2, lastEntryId: second.entryId });

    store.restoreState({ sequence: 8, lastEntryId: "entry-restored" });
    const restored = await store.append("session-store", "turn-2", {
      type: "session_metadata",
      metadata: { tag: "restored" },
    });

    assert.equal(restored.sequence, 9);
    assert.equal(restored.parentEntryId, "entry-restored");
    await store.flush();

    const readResult = await store.read();
    assert.equal(readResult.diagnostics.length, 0);
    assert.deepEqual(readResult.entries.map((entry) => entry.sequence), [1, 2, 9]);
  });
}

let inMemoryId = 0;
runSessionEventStoreContract(
  "in-memory session event store",
  () => new InMemorySessionEventStore({ now: () => new Date(createdAt), uuid: () => `memory-${++inMemoryId}` }),
);

test("jsonl session event store appends one materialized event per line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-session-events-"));
  const path = join(directory, "session.jsonl");
  let id = 0;
  const store = new JsonlSessionEventStore({
    path,
    now: () => new Date(createdAt),
    uuid: () => `jsonl-${++id}`,
  });

  try {
    const entry = await store.append("session-jsonl", "turn-1", {
      type: "session_metadata",
      metadata: { title: "Persisted" },
    });
    await store.flush();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), entry);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project session storage shares one event owner with the transcript compatibility facade", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-project-session-events-"));
  const projectRoot = join(directory, "project");
  const pilotHome = join(directory, "pilot-home");
  const storage = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId: "session-shared-owner",
    now: () => new Date(createdAt),
  });

  try {
    await storage.transcript.recordSessionMetadata?.("session-shared-owner", "turn-1", {
      title: "Shared owner",
    });
    const readResult = await storage.events.read();

    assert.equal(readResult.diagnostics.length, 0);
    assert.equal(readResult.entries.length, 1);
    assert.equal(readResult.entries[0].type, "session_metadata");
    assert.notEqual(storage.events, storage.persistence);
    assert.deepEqual(storage.events.snapshotState(), storage.transcript.snapshotState?.());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session runtime serializes concurrent commits and publishes immutable snapshots", async () => {
  const subscriberErrors: Array<{ message: string; sequence: number }> = [];
  let id = 0;
  const store = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: () => `runtime-${++id}`,
    onSubscriberError: (error, entry) => {
      subscriberErrors.push({
        message: error instanceof Error ? error.message : String(error),
        sequence: entry.sequence,
      });
    },
  });
  const committed: AgentTranscriptEntry[] = [];
  const failing = store.subscribe(() => {
    throw new Error("observer failed");
  });
  const subscription = store.subscribe(async (entry) => {
    await Promise.resolve();
    committed.push(entry);
  });
  const metadata = { title: "Before mutation" };

  const firstPromise = store.append("session-runtime", "turn-1", {
    type: "session_metadata",
    metadata,
  });
  metadata.title = "After mutation";
  const secondPromise = store.append("session-runtime", "turn-1", {
    type: "accepted_input",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.deepEqual(committed.map((entry) => entry.sequence), [1, 2]);
  assert.equal(first.type === "session_metadata" ? first.metadata.title : undefined, "Before mutation");
  assert.equal(second.parentEntryId, first.entryId);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.type === "session_metadata" ? first.metadata : {}), true);
  assert.deepEqual(subscriberErrors, [
    { message: "observer failed", sequence: 1 },
    { message: "observer failed", sequence: 2 },
  ]);

  subscription.dispose();
  failing.dispose();
  await store.append("session-runtime", "turn-2", {
    type: "session_metadata",
    metadata: { tag: "after-dispose" },
  });
  assert.equal(subscription.active, false);
  assert.deepEqual(committed.map((entry) => entry.sequence), [1, 2]);
});

test("committed stream and persisted replay produce equivalent Web history projections", async () => {
  let id = 0;
  const store = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: () => `projection-${++id}`,
  });
  const committed: AgentTranscriptEntry[] = [];
  store.subscribe((entry) => {
    committed.push(entry);
  });

  await store.append("session-projection-runtime", "turn-1", {
    type: "tool_result_message",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "created report.txt" }],
      }],
    },
  });
  await store.append("session-projection-runtime", "turn-1", {
    type: "file_artifacts",
    artifacts: [{
      id: "artifact-1",
      name: "report.txt",
      path: "report.txt",
      operation: "created",
      source: "workspace_diff",
      status: "complete",
      size: 6,
      sha256: "a".repeat(64),
      createdAt,
    }],
  });
  await store.append("session-projection-runtime", "turn-1", {
    type: "agent_status_message",
    event: "context_budget",
    kind: "status",
    text: "context budget",
    detail: { displayUsed: 50, total: 500, effectiveTotal: 450 },
  });
  await store.append("session-projection-runtime", "turn-1", {
    type: "control_boundary",
    boundary: {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto", preTokens: 50, postTokens: 20 },
    },
  });

  const replay = await store.read();
  assert.deepEqual(projectWebHistory(committed), projectWebHistory(replay.entries));

  const restored = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: () => "projection-restored",
  });
  restored.restore(replay.entries);
  const next = await restored.append("session-projection-runtime", "turn-2", {
    type: "session_metadata",
    metadata: { title: "Restored" },
  });
  assert.equal(next.sequence, 5);
  assert.equal(next.parentEntryId, replay.entries[3].entryId);
});

test("session runtime restore accepts gaps, branches, legacy ids, and missing-parent orphans", async () => {
  const store = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: () => "after-restore",
  });
  const entries = [
    metadataEntry(1, "root", null),
    metadataEntry(3, "branch-a", "root"),
    metadataEntry(7, undefined, "missing-parent"),
    metadataEntry(9, "branch-b", "root"),
  ];

  store.restore(entries);

  assert.deepEqual(store.snapshotState(), { sequence: 9, lastEntryId: "branch-b" });
  const next = await store.append("session-validation", "turn-10", {
    type: "session_metadata",
    metadata: { title: "After restore" },
  });
  assert.equal(next.sequence, 10);
  assert.equal(next.parentEntryId, "branch-b");
});

test("session runtime restore rejects invalid event envelopes transactionally", async () => {
  const invalidLogs: Array<{ code: SessionEventValidationError["code"]; entries: AgentTranscriptEntry[] }> = [
    { code: "invalid_sequence", entries: [metadataEntry(0, "zero")] },
    { code: "sequence_not_increasing", entries: [metadataEntry(2, "later"), metadataEntry(1, "earlier")] },
    { code: "sequence_not_increasing", entries: [metadataEntry(1, "first"), metadataEntry(1, "second")] },
    { code: "invalid_entry_id", entries: [metadataEntry(1, " ")] },
    { code: "duplicate_entry_id", entries: [metadataEntry(1, "same"), metadataEntry(2, "same")] },
    { code: "self_parent", entries: [metadataEntry(1, "self", "self")] },
    {
      code: "invalid_parent_entry_id",
      entries: [{ ...metadataEntry(1, "child"), parentEntryId: 42 } as unknown as AgentTranscriptEntry],
    },
  ];

  for (const invalid of invalidLogs) {
    const store = new InMemorySessionEventStore({
      now: () => new Date(createdAt),
      uuid: () => "existing",
    });
    const existing = await store.append("session-validation", "turn-existing", {
      type: "session_metadata",
      metadata: { title: "Existing" },
    });

    assert.throws(
      () => store.restore(invalid.entries),
      (error: unknown) => error instanceof SessionEventValidationError && error.code === invalid.code,
    );
    assert.deepEqual(store.snapshotState(), { sequence: 1, lastEntryId: existing.entryId });
  }
});

test("session runtime validates recorded appends before publishing them", async () => {
  let generatedId = 0;
  const store = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: () => `generated-${++generatedId}`,
  });
  const published: number[] = [];
  store.subscribe((entry) => {
    published.push(entry.sequence);
  });
  const first = await store.append("session-validation", "turn-1", {
    type: "session_metadata",
    metadata: { title: "First" },
  });

  await assert.rejects(
    store.appendRecorded(metadataEntry(1, "recorded-regression")),
    (error: unknown) => error instanceof SessionEventValidationError && error.code === "sequence_not_increasing",
  );
  await assert.rejects(
    store.appendRecorded(metadataEntry(4, first.entryId)),
    (error: unknown) => error instanceof SessionEventValidationError && error.code === "duplicate_entry_id",
  );
  assert.deepEqual(published, [1]);
  assert.deepEqual((await store.read()).entries.map((entry) => entry.sequence), [1]);

  await store.appendRecorded(metadataEntry(4, "recorded-gap", "missing-parent"));
  const next = await store.append("session-validation", "turn-5", {
    type: "session_metadata",
    metadata: { title: "After recorded gap" },
  });
  assert.equal(next.sequence, 5);
  assert.equal(next.parentEntryId, "recorded-gap");
  assert.deepEqual(published, [1, 4, 5]);
});

test("session runtime rejects invalid restored writer state", () => {
  const store = new InMemorySessionEventStore();

  assert.throws(
    () => store.restoreState({ sequence: Number.MAX_SAFE_INTEGER + 1, lastEntryId: null }),
    (error: unknown) => error instanceof SessionEventValidationError && error.code === "invalid_sequence",
  );
  assert.throws(
    () => store.restoreState({ sequence: 2, lastEntryId: "" }),
    (error: unknown) => error instanceof SessionEventValidationError && error.code === "invalid_entry_id",
  );
});
