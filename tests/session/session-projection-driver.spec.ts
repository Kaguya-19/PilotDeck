import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";

import { InMemorySessionEventStore } from "../../src/session/events/index.js";
import {
  AGENT_TRANSCRIPT_PROJECTION_NAMES,
  createDefaultSessionProjectionRegistry,
  FILE_HISTORY_PROJECTION_NAMES,
  SessionProjectionDriver,
  SessionProjectionRegistry,
  type FileHistorySnapshotProjectionResult,
  type SessionProjectionDefinition,
} from "../../src/session/projection/index.js";

const createdAt = "2026-09-06T00:00:00.000Z";

test("live projection cells match a cold replay at one as-of sequence", async () => {
  let id = 0;
  const runtime = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: () => `projection-live-${++id}`,
  });
  const driver = new SessionProjectionDriver({
    runtime,
    registry: createDefaultSessionProjectionRegistry(),
  });
  const changes: Array<{ name: string; sequence: number }> = [];
  driver.subscribe((change) => {
    changes.push({ name: change.name, sequence: change.asOfSequence });
  });

  await runtime.append("session-live-projection", "turn-1", {
    type: "accepted_input",
    messages: [{ role: "user", content: [{ type: "text", text: "create a report" }] }],
  });
  await runtime.append("session-live-projection", "turn-1", {
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
  });
  await runtime.append("session-live-projection", "turn-1", {
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
  await runtime.append("session-live-projection", "turn-1", {
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
  await runtime.append("session-live-projection", "turn-1", {
    type: "agent_status_message",
    event: "context_budget",
    kind: "status",
    text: "context budget",
    detail: { displayUsed: 50, total: 500, effectiveTotal: 450 },
  });
  await runtime.append("session-live-projection", "turn-1", {
    type: "turn_result",
    result: {
      type: "success",
      sessionId: "session-live-projection",
      turnId: "turn-1",
      stopReason: "completed",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      permissionDenials: [],
      turns: 1,
      startedAt: createdAt,
      completedAt: createdAt,
    },
  });
  await runtime.append("session-live-projection", "turn-1", {
    type: "session_metadata",
    metadata: { title: "Live projection" },
  });
  await runtime.append("session-live-projection", "turn-1", {
    type: "file_snapshot_recorded",
    snapshotKind: "create",
    messageId: "turn-1",
    trackedFileBackups: {
      "/workspace/report.txt": {
        backupFileName: "report@v1",
        version: 1,
        backupTime: createdAt,
      },
    },
    timestamp: createdAt,
  });

  const live = driver.snapshot();
  const persisted = await runtime.read();
  const coldDriver = new SessionProjectionDriver({
    registry: createDefaultSessionProjectionRegistry(),
    entries: persisted.entries,
  });
  const cold = coldDriver.snapshot();

  assert.equal(live.asOfSequence, 8);
  assert.deepEqual(live, cold);
  assert.equal(
    (live.values[AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata] as { title?: string }).title,
    "Live projection",
  );
  assert.ok(changes.some((change) => change.sequence === 7));
  assert.equal(
    (live.values[FILE_HISTORY_PROJECTION_NAMES.snapshots] as FileHistorySnapshotProjectionResult)[0]
      ?.messageId,
    "turn-1",
  );
  assert.ok(changes.some((change) => change.sequence === 8));
  assert.ok(changes.every((change) => change.sequence >= 1 && change.sequence <= 8));

  coldDriver.dispose();
  driver.dispose();
});

test("file history projection replaces updates without changing first insertion order", async () => {
  const runtime = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: (() => {
      let id = 0;
      return () => `file-history-projection-${++id}`;
    })(),
  });
  const driver = new SessionProjectionDriver({
    runtime,
    registry: createDefaultSessionProjectionRegistry(),
  });

  await runtime.append("session-file-history", "turn-a", fileSnapshot("create", "turn-a", 1));
  await runtime.append("session-file-history", "turn-b", fileSnapshot("create", "turn-b", 1));
  await runtime.append("session-file-history", "turn-a", fileSnapshot("update", "turn-a", 2));

  const snapshot = driver.snapshot([FILE_HISTORY_PROJECTION_NAMES.snapshots]);
  const projected = snapshot.values[
    FILE_HISTORY_PROJECTION_NAMES.snapshots
  ] as FileHistorySnapshotProjectionResult;
  assert.equal(snapshot.asOfSequence, 3);
  assert.deepEqual(projected.map((entry) => entry.messageId), ["turn-a", "turn-b"]);
  assert.equal(projected[0]?.snapshotKind, "update");
  assert.equal(projected[0]?.trackedFileBackups["/workspace/report.txt"]?.version, 2);

  driver.dispose();
});

test("late registration folds history and checkpoint restore honors projection version", async () => {
  const runtime = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: (() => {
      let id = 0;
      return () => `projection-checkpoint-${++id}`;
    })(),
  });
  await runtime.append("session-checkpoint", "turn-1", {
    type: "accepted_input",
    messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
  });

  const registry = new SessionProjectionRegistry();
  const driver = new SessionProjectionDriver({ runtime, registry, entries: (await runtime.read()).entries });
  let decodeCount = 0;
  const definition: SessionProjectionDefinition<number> = {
    name: "test.accepted-count",
    version: 1,
    create: () => 0,
    reduce: (state, entry) => entry.type === "accepted_input" ? state + 1 : state,
    checkpoint: {
      encode: (state) => state,
      decode(value) {
        decodeCount += 1;
        if (typeof value !== "number") throw new TypeError("invalid count checkpoint");
        return value;
      },
    },
  };
  const registration = registry.register(definition);
  assert.equal(driver.snapshot().values[definition.name], 1);

  const changes: number[] = [];
  driver.subscribe((change) => {
    if (change.name === definition.name) changes.push(change.asOfSequence);
  });
  await runtime.append("session-checkpoint", "turn-2", {
    type: "accepted_input",
    messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
  });
  await runtime.append("session-checkpoint", "turn-2", {
    type: "session_metadata",
    metadata: { tag: "unchanged-count" },
  });
  assert.deepEqual(changes, [2]);

  const entries = (await runtime.read()).entries;
  const checkpoint = driver.checkpoint();
  const restoredRegistry = new SessionProjectionRegistry();
  restoredRegistry.register(definition);
  const restored = new SessionProjectionDriver({
    registry: restoredRegistry,
    entries,
    checkpoint,
  });
  assert.equal(restored.snapshot().values[definition.name], 2);
  assert.equal(decodeCount, 1);

  const upgradedRegistry = new SessionProjectionRegistry();
  upgradedRegistry.register({ ...definition, version: 2 });
  const upgraded = new SessionProjectionDriver({
    registry: upgradedRegistry,
    entries,
    checkpoint,
  });
  assert.equal(upgraded.snapshot().values[definition.name], 2);
  assert.equal(decodeCount, 1, "version mismatch must discard the checkpoint");

  registration.dispose();
  assert.equal(definition.name in driver.snapshot().values, false);
  upgraded.dispose();
  restored.dispose();
  driver.dispose();
});

test("conversation checkpoint round-trip preserves durable runtime context ordering", () => {
  const createdAt = "2026-09-06T00:00:00.000Z";
  const entries: AgentTranscriptEntry[] = [
    {
      type: "accepted_input" as const,
      sessionId: "session-runtime-context-checkpoint",
      turnId: "turn-1",
      sequence: 1,
      createdAt,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
    },
    {
      type: "context_snapshot" as const,
      sessionId: "session-runtime-context-checkpoint",
      turnId: "turn-1",
      sequence: 2,
      createdAt,
      step: 1,
      contexts: [{ name: "cwd", text: "/workspace" }],
      runtimeContextMessages: [{
        role: "user" as const,
        metadata: { synthetic: true, purpose: "runtime_context" },
        content: [{ type: "text" as const, text: "runtime" }],
      }],
    },
    {
      type: "turn_result" as const,
      sessionId: "session-runtime-context-checkpoint",
      turnId: "turn-1",
      sequence: 3,
      createdAt,
      result: {
        type: "success" as const,
        sessionId: "session-runtime-context-checkpoint",
        turnId: "turn-1",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    },
  ];
  const registry = createDefaultSessionProjectionRegistry();
  const source = new SessionProjectionDriver({ registry, entries });
  const restored = new SessionProjectionDriver({
    registry: createDefaultSessionProjectionRegistry(),
    entries,
    checkpoint: source.checkpoint(),
  });

  const messages = (snapshot: ReturnType<SessionProjectionDriver["snapshot"]>) =>
    (snapshot.values[AGENT_TRANSCRIPT_PROJECTION_NAMES.conversation] as { messages: Array<{ content: Array<{ text?: string }> }> }).messages
      .map((message) => message.content.map((block) => block.text ?? "").join("\n"));
  assert.deepEqual(messages(restored.snapshot()), ["runtime", "hello"]);
  assert.deepEqual(
    restored.snapshot().values[AGENT_TRANSCRIPT_PROJECTION_NAMES.conversation],
    source.snapshot().values[AGENT_TRANSCRIPT_PROJECTION_NAMES.conversation],
  );

  restored.dispose();
  source.dispose();
});

test("a broken projection cell is removed without blocking durable commits", async () => {
  const errors: string[] = [];
  const runtime = new InMemorySessionEventStore({
    now: () => new Date(createdAt),
    uuid: () => "projection-error-entry",
  });
  const registry = new SessionProjectionRegistry();
  registry.register({
    name: "test.good",
    version: 1,
    create: () => 0,
    reduce: (state) => state + 1,
  });
  registry.register({
    name: "test.broken",
    version: 1,
    create: () => 0,
    reduce(_state, entry) {
      if (entry.type === "session_metadata") throw new Error("broken projection");
      return 0;
    },
  });
  const driver = new SessionProjectionDriver({
    runtime,
    registry,
    onError: (error, name) => errors.push(`${name}:${error instanceof Error ? error.message : String(error)}`),
  });

  const committed = await runtime.append("session-projection-error", "turn-1", {
    type: "session_metadata",
    metadata: { title: "Still durable" },
  });
  const snapshot = driver.snapshot();

  assert.equal(committed.sequence, 1);
  assert.equal(snapshot.asOfSequence, 1);
  assert.equal(snapshot.values["test.good"], 1);
  assert.equal("test.broken" in snapshot.values, false);
  assert.equal(errors.length, 2);
  driver.dispose();
});

function fileSnapshot(
  snapshotKind: "create" | "update",
  messageId: string,
  version: number,
) {
  return {
    type: "file_snapshot_recorded" as const,
    snapshotKind,
    messageId,
    trackedFileBackups: {
      "/workspace/report.txt": {
        backupFileName: `report@v${version}`,
        version,
        backupTime: createdAt,
      },
    },
    timestamp: createdAt,
  };
}
