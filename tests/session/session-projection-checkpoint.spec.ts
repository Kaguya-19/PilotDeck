import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemorySessionEventStore } from "../../src/session/events/InMemorySessionEventStore.js";
import {
  AGENT_TRANSCRIPT_PROJECTION_NAMES,
  createDefaultSessionProjectionRegistry,
  requireSessionProjectionValue,
  SessionProjectionDriver,
} from "../../src/session/projection/index.js";
import {
  checkpointMatchesLog,
  createSessionProjectionCheckpointEnvelope,
  InMemorySessionProjectionCheckpointStore,
  JsonFileSessionProjectionCheckpointStore,
  SessionProjectionCheckpointBinding,
  type SessionProjectionCheckpointEnvelope,
  type SessionProjectionCheckpointStore,
} from "../../src/session/projection/checkpoint/index.js";
import { checkpointTranscriptEntry } from "../../src/session/projection/SessionProjectionCheckpointCodec.js";
import { PLAN_TODO_PROJECTION_NAME } from "../../src/plan-todo/projection/PlanTodoProjection.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import type {
  AgentTranscriptEntry,
  SessionMetadataValue,
} from "../../src/session/transcript/TranscriptEntry.js";

const createdAt = "2026-09-06T00:00:00.000Z";

test("projection checkpoint stores round trip and JSON writes replace atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-projection-checkpoint-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.projections.json");
  const entries = [metadataEntry(1, "First")];
  const first = createSessionProjectionCheckpointEnvelope(
    "checkpoint-session",
    1,
    { test: { version: 1, asOfSequence: 1, state: { count: 1 } } },
    entries,
  );
  const second = createSessionProjectionCheckpointEnvelope(
    "checkpoint-session",
    1,
    { test: { version: 1, asOfSequence: 1, state: { count: 2 } } },
    entries,
  );

  const memory = new InMemorySessionProjectionCheckpointStore();
  await memory.save(first);
  assert.deepEqual(await memory.load("checkpoint-session"), first);

  const json = new JsonFileSessionProjectionCheckpointStore({ path });
  await Promise.all([json.save(first), json.save(second)]);
  assert.deepEqual(await json.load("checkpoint-session"), second);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), second);
});

test("projection checkpoint JSON store treats corrupt, wrong-version, and wrong-session files as cache misses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-projection-checkpoint-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.projections.json");
  const errors: unknown[] = [];
  const store = new JsonFileSessionProjectionCheckpointStore({ path, onError: (error) => errors.push(error) });

  await writeFile(path, "{broken", "utf8");
  assert.equal(await store.load("checkpoint-session"), undefined);

  const envelope = createSessionProjectionCheckpointEnvelope(
    "checkpoint-session",
    1,
    {},
    [metadataEntry(1, "First")],
  );
  await writeFile(path, JSON.stringify({ ...envelope, version: 999 }), "utf8");
  assert.equal(await store.load("checkpoint-session"), undefined);

  await writeFile(path, JSON.stringify(envelope), "utf8");
  assert.equal(await store.load("another-session"), undefined);
  assert.equal(errors.length, 3);
});

test("checkpoint anchor rejects future or mismatched log cuts", () => {
  const entries = [metadataEntry(1, "First")];
  const valid = createSessionProjectionCheckpointEnvelope("checkpoint-session", 1, {}, entries);
  assert.equal(checkpointMatchesLog(valid, entries), true);
  assert.equal(checkpointMatchesLog({
    ...valid,
    anchor: valid.anchor && { ...valid.anchor, entryId: "different" },
  }, entries), false);
  assert.equal(checkpointMatchesLog({
    ...valid,
    asOfSequence: 2,
    anchor: valid.anchor && { ...valid.anchor, sequence: 2 },
  }, entries), false);
});

test("projection checkpoint validates both descriptor versions without accepting schema drift", () => {
  const base = {
    type: "subagent_descriptor",
    sessionId: "child-session",
    turnId: "child-turn",
    sequence: 1,
    createdAt,
    entryId: "entry-1",
    parentEntryId: null,
  } as const;
  const oneShot = {
    ...base,
    descriptor: {
      version: 1,
      mode: "one-shot",
      provider: "pilotdeck-native",
      definitionId: "explore",
    },
  } as const;
  const continuable = {
    ...base,
    descriptor: {
      version: 2,
      mode: "continuable",
      provider: "pilotdeck-native",
      definitionId: "explore",
      parentSessionId: "parent-session",
      label: "Inspect the runtime",
      agentProvider: "anthropic",
      agentModel: "claude-sonnet",
    },
  } as const;

  assert.deepEqual(
    checkpointTranscriptEntry(oneShot, ["subagent_descriptor"], "one-shot"),
    oneShot,
  );
  assert.deepEqual(
    checkpointTranscriptEntry(continuable, ["subagent_descriptor"], "continuable"),
    continuable,
  );
  assert.throws(
    () => checkpointTranscriptEntry({
      ...continuable,
      descriptor: { ...continuable.descriptor, unexpected: true },
    }, ["subagent_descriptor"], "unknown-field"),
    /descriptor checkpoint is invalid/,
  );
  assert.throws(
    () => checkpointTranscriptEntry({
      ...continuable,
      descriptor: { ...continuable.descriptor, parentSessionId: "" },
    }, ["subagent_descriptor"], "missing-field"),
    /required non-empty string fields/,
  );
  assert.throws(
    () => checkpointTranscriptEntry({
      ...continuable,
      descriptor: { ...continuable.descriptor, mode: "one-shot" },
    }, ["subagent_descriptor"], "mode-mismatch"),
    /descriptor checkpoint is invalid/,
  );
  assert.throws(
    () => checkpointTranscriptEntry({
      ...continuable,
      descriptor: { ...continuable.descriptor, version: 999 },
    }, ["subagent_descriptor"], "unsupported-version"),
    /descriptor checkpoint is invalid/,
  );
});

test("default projection checkpoint plus tail equals full replay and malformed state falls back", () => {
  const first = metadataEntry(1, "First");
  const tail = metadataEntry(2, "Second");
  const source = new SessionProjectionDriver({
    registry: createDefaultSessionProjectionRegistry(),
    entries: [first],
  });
  const checkpoint = source.checkpoint();
  assert.equal(Object.keys(checkpoint).length, 13);
  assert.ok(Object.hasOwn(checkpoint, PLAN_TODO_PROJECTION_NAME));

  const restored = new SessionProjectionDriver({
    registry: createDefaultSessionProjectionRegistry(),
    entries: [first, tail],
    checkpoint,
  });
  const fullReplay = new SessionProjectionDriver({
    registry: createDefaultSessionProjectionRegistry(),
    entries: [first, tail],
  });
  assert.deepEqual(restored.snapshot(), fullReplay.snapshot());

  const errors: unknown[] = [];
  const malformed = structuredClone(checkpoint);
  malformed[AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata]!.state = "not-an-object";
  const fallback = new SessionProjectionDriver({
    registry: createDefaultSessionProjectionRegistry(),
    entries: [first, tail],
    checkpoint: malformed,
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(fallback.snapshot(), fullReplay.snapshot());
  assert.equal(errors.length, 1);

  fallback.dispose();
  fullReplay.dispose();
  restored.dispose();
  source.dispose();
});

test("project storage restores checkpoint plus tail and rejects damaged cache without changing results", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-projection-checkpoint-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    projectRoot: join(directory, "project"),
    pilotHome: join(directory, "pilot-home"),
    sessionId: "checkpoint-session",
    now: () => new Date(createdAt),
  };
  const storage = createAgentProjectSessionStorage(options);
  await storage.events.append("checkpoint-session", "turn-1", {
    type: "session_metadata",
    metadata: { title: "First" },
  });
  await storage.flush();
  await storage.events.append("checkpoint-session", "turn-2", {
    type: "session_metadata",
    metadata: { title: "Second" },
  });

  const restored = createAgentProjectSessionStorage(options);
  const readResult = await restored.restore();
  assert.equal(readResult.entries.length, 2);
  assert.equal(projectedTitle(restored.projections), "Second");

  const checkpoint = JSON.parse(
    await readFile(storage.projectionCheckpointPath, "utf8"),
  ) as SessionProjectionCheckpointEnvelope;
  const damaged = structuredClone(checkpoint);
  damaged.anchor = damaged.anchor && { ...damaged.anchor, createdAt: "not-the-log-anchor" };
  damaged.projections[AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata] = {
    version: 1,
    asOfSequence: 1,
    state: { title: "Wrong cached title" },
  };
  await writeFile(storage.projectionCheckpointPath, JSON.stringify(damaged), "utf8");
  const anchorFallback = createAgentProjectSessionStorage(options);
  await anchorFallback.restore();
  assert.equal(projectedTitle(anchorFallback.projections), "Second");

  const future = structuredClone(checkpoint);
  future.asOfSequence = 99;
  future.anchor = future.anchor && { ...future.anchor, sequence: 99 };
  future.projections[AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata] = {
    version: 1,
    asOfSequence: 99,
    state: { title: "Future cached title" },
  };
  await writeFile(storage.projectionCheckpointPath, JSON.stringify(future), "utf8");
  const futureFallback = createAgentProjectSessionStorage(options);
  await futureFallback.restore();
  assert.equal(projectedTitle(futureFallback.projections), "Second");

  await writeFile(storage.projectionCheckpointPath, "{broken", "utf8");
  const corruptFallback = createAgentProjectSessionStorage(options);
  await corruptFallback.restore();
  assert.equal(projectedTitle(corruptFallback.projections), "Second");

  await unlink(storage.projectionCheckpointPath);
  const missingFallback = createAgentProjectSessionStorage(options);
  await missingFallback.restore();
  assert.equal(projectedTitle(missingFallback.projections), "Second");

  await missingFallback.dispose();
  await corruptFallback.dispose();
  await futureFallback.dispose();
  await anchorFallback.dispose();
  await restored.dispose();
  await storage.dispose();
});

test("turn-end and final disposal persist checkpoints while cache failures stay fail-soft", async () => {
  const runtime = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: (() => {
      let id = 0;
      return () => `checkpoint-entry-${++id}`;
    })(),
  });
  const projections = new SessionProjectionDriver({
    runtime,
    registry: createDefaultSessionProjectionRegistry(),
  });
  const errors: unknown[] = [];
  let saves = 0;
  let signalSave: (() => void) | undefined;
  const saveAttempted = new Promise<void>((resolve) => {
    signalSave = resolve;
  });
  const failingStore: SessionProjectionCheckpointStore = {
    async load() {
      return undefined;
    },
    async save() {
      saves += 1;
      signalSave?.();
      throw new Error("cache unavailable");
    },
  };
  const binding = new SessionProjectionCheckpointBinding({
    sessionId: "checkpoint-session",
    runtime,
    projections,
    store: failingStore,
    onError: (error) => errors.push(error),
  });

  await runtime.append("checkpoint-session", "turn-1", { type: "turn_started" });
  await runtime.append("checkpoint-session", "turn-1", {
    type: "turn_result",
    result: turnResult("checkpoint-session", "turn-1"),
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      saveAttempted,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("turn_result did not schedule a checkpoint write")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  assert.ok(saves >= 1, "turn_result should schedule a checkpoint attempt");
  await binding.flush();
  assert.ok(errors.length >= 1);
  assert.equal((await runtime.read()).entries.length, 2);

  await binding.dispose();
  projections.dispose();
});

function metadataEntry(sequence: number, title: string): AgentTranscriptEntry {
  return {
    type: "session_metadata",
    sessionId: "checkpoint-session",
    turnId: `turn-${sequence}`,
    sequence,
    createdAt,
    entryId: `entry-${sequence}`,
    parentEntryId: sequence === 1 ? null : `entry-${sequence - 1}`,
    metadata: { title },
  };
}

function projectedTitle(driver: SessionProjectionDriver): string | undefined {
  return requireSessionProjectionValue<SessionMetadataValue>(
    driver.snapshot([AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata]),
    AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata,
  ).title;
}

function turnResult(sessionId: string, turnId: string) {
  return {
    type: "success" as const,
    sessionId,
    turnId,
    stopReason: "completed" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}
