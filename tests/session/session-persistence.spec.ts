import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  attachSessionPersistence,
  InMemorySessionPersistence,
  JsonlSessionPersistence,
  type SessionPersistence,
} from "../../src/session/persistence/index.js";
import { SessionRuntime } from "../../src/session/events/SessionRuntime.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";

const createdAt = "2026-09-06T00:00:00.000Z";

function metadataEntry(sequence: number): AgentTranscriptEntry {
  return {
    type: "session_metadata",
    sessionId: "session-persistence",
    turnId: `turn-${sequence}`,
    sequence,
    createdAt,
    entryId: `entry-${sequence}`,
    parentEntryId: sequence === 1 ? null : `entry-${sequence - 1}`,
    metadata: { title: `Title ${sequence}` },
  };
}

async function exercisePersistenceContract(persistence: SessionPersistence): Promise<void> {
  const entries = [metadataEntry(1), metadataEntry(2)];
  await Promise.all(entries.map((entry) => persistence.append(entry)));
  await persistence.flush();

  const loaded = await persistence.load();
  assert.deepEqual(loaded.entries, entries);
  assert.deepEqual(loaded.diagnostics, []);
}

test("in-memory session persistence implements append/load/flush", async () => {
  await exercisePersistenceContract(new InMemorySessionPersistence());
});

test("jsonl session persistence reloads the same durable event log after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-session-persistence-"));
  const path = join(directory, "session.jsonl");

  try {
    await exercisePersistenceContract(new JsonlSessionPersistence({ path }));

    const restarted = new JsonlSessionPersistence({ path });
    const loaded = await restarted.load();
    assert.deepEqual(loaded.entries, [metadataEntry(1), metadataEntry(2)]);
    assert.deepEqual(loaded.diagnostics, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("required persistence failure prevents sequence advancement and later append can retry", async () => {
  const entries: AgentTranscriptEntry[] = [];
  let shouldFail = true;
  const persistence: SessionPersistence = {
    async append(entry) {
      if (shouldFail) throw new Error("persistence unavailable");
      entries.push(entry);
    },
    async load() {
      return { entries: [...entries], diagnostics: [] };
    },
    async flush() {},
  };
  const runtime = new SessionRuntime({
    now: () => new Date(createdAt),
    uuid: () => "entry-retry",
  });
  attachSessionPersistence(runtime, persistence);

  await assert.rejects(
    runtime.append("session-persistence", "turn-1", {
      type: "session_metadata",
      metadata: { title: "First attempt" },
    }),
    /persistence unavailable/,
  );
  assert.deepEqual(runtime.snapshotState(), { sequence: 0, lastEntryId: null });

  shouldFail = false;
  const committed = await runtime.append("session-persistence", "turn-1", {
    type: "session_metadata",
    metadata: { title: "Retry" },
  });
  assert.equal(committed.sequence, 1);
  assert.equal(committed.parentEntryId, null);
  assert.deepEqual((await persistence.load()).entries, [committed]);
});
