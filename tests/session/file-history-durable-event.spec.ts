import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { FileHistoryStore } from "../../src/session/filesystem/FileHistoryStore.js";
import {
  createAgentProjectSessionStorage,
  type AgentFileSnapshotRecordedTranscriptEntry,
  type AgentTranscriptEntry,
} from "../../src/session/index.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";

const fixedNow = () => new Date("2026-09-06T00:00:00.000Z");

test("file history awaits its durable event and can replay the recorded snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-file-history-event-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = join(root, "note.txt");
  const backupDir = join(root, "backups");
  await writeFile(filePath, "before\n", "utf8");

  const transcript = new InMemoryTranscriptWriter({
    now: fixedNow,
    uuid: () => "entry-1",
  });
  let durableAppendFinished = false;
  const history = new FileHistoryStore({
    backupDir,
    now: fixedNow,
    onSnapshotRecorded: async (snapshot, snapshotKind) => {
      await Promise.resolve();
      await transcript.recordFileHistorySnapshot(
        "session-1",
        snapshot.messageId,
        snapshot,
        snapshotKind,
      );
      durableAppendFinished = true;
    },
  });

  await history.trackEdit(filePath, "turn-1");
  assert.equal(durableAppendFinished, true);
  assert.equal(transcript.entries.length, 1);
  const recorded = transcript.entries[0];
  assert.equal(recorded?.type, "file_snapshot_recorded");
  if (recorded?.type !== "file_snapshot_recorded") assert.fail("expected file snapshot entry");
  assert.equal(recorded.snapshotKind, "update");
  assert.equal(recorded.messageId, "turn-1");
  assert.equal(recorded.turnId, "turn-1");
  assert.equal(recorded.sequence, 1);
  assert.equal(recorded.entryId, "entry-1");
  assert.equal(recorded.timestamp, "2026-09-06T00:00:00.000Z");
  assert.equal(recorded.trackedFileBackups[filePath]?.version, 1);
  assert.equal(typeof recorded.trackedFileBackups[filePath]?.backupFileName, "string");

  await writeFile(filePath, "after\n", "utf8");
  const restored = new FileHistoryStore({ backupDir });
  restored.replayFromTranscript(transcript.entries.filter(isFileSnapshotEntry));
  await restored.rewind("turn-1");
  assert.equal(await readFile(filePath, "utf8"), "before\n");
});

test("JSONL transcript preserves file history events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-file-history-jsonl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "session.jsonl");
  const writer = new JsonlTranscriptWriter({
    path: transcriptPath,
    now: fixedNow,
    uuid: () => "entry-jsonl",
  });

  await writer.recordFileHistorySnapshot(
    "session-jsonl",
    "turn-jsonl",
    {
      messageId: "turn-jsonl",
      trackedFileBackups: {
        "/workspace/example.txt": {
          backupFileName: "example@v1",
          version: 1,
          mode: 0o644,
          backupTime: "2026-09-06T00:00:00.000Z",
        },
      },
      timestamp: "2026-09-06T00:00:00.000Z",
    },
    "create",
  );

  const result = await readTranscript(transcriptPath);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.entries[0]?.type, "file_snapshot_recorded");
  assert.deepEqual(result.entries[0], {
    type: "file_snapshot_recorded",
    snapshotKind: "create",
    messageId: "turn-jsonl",
    trackedFileBackups: {
      "/workspace/example.txt": {
        backupFileName: "example@v1",
        version: 1,
        mode: 0o644,
        backupTime: "2026-09-06T00:00:00.000Z",
      },
    },
    timestamp: "2026-09-06T00:00:00.000Z",
    sessionId: "session-jsonl",
    turnId: "turn-jsonl",
    sequence: 1,
    createdAt: "2026-09-06T00:00:00.000Z",
    entryId: "entry-jsonl",
    parentEntryId: null,
  });
});

test("local gateway records file history and restores it from a legacy-compatible transcript", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-file-history-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-file-history-home-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  });

  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const filePath = join(projectRoot, "tracked.txt");
  await writeFile(filePath, "before\n", "utf8");
  const sessionKey = "file-history-session";
  const storage = createAgentProjectSessionStorage({ projectRoot: pilotHome, pilotHome, sessionId: sessionKey });
  await storage.transcript.recordSessionMetadata(sessionKey, "legacy-metadata", {
    title: "Legacy transcript",
  });

  let firstTurnId = "";
  const first = createLocalGateway({
    projectRoot: pilotHome,
    pilotHome,
    __testModelFactory: () => TEST_MODEL,
    __testAgentLoopFactory: ({ dependencies }) => createRunner(async (input) => {
      assert.ok(dependencies.fileHistory);
      firstTurnId = input.turnId;
      await dependencies.fileHistory.trackEdit(filePath, input.turnId);
      await writeFile(filePath, "after\n", "utf8");
    }),
  });
  try {
    await drain(first.gateway.submitTurn({
      sessionKey,
      channelKey: "test",
      message: "edit the file",
      runId: "turn-1",
      canPrompt: false,
    }));
  } finally {
    await first.dispose();
  }

  const persisted = await readTranscript(storage.transcriptPath);
  assert.equal(persisted.entries.some((entry) => entry.type === "session_metadata"), true);
  const snapshotEntry = persisted.entries.find(isFileSnapshotEntry);
  assert.ok(snapshotEntry, JSON.stringify(persisted.entries, null, 2));
  assert.equal(snapshotEntry.messageId, firstTurnId);

  let restoredMessageIds: string[] = [];
  const second = createLocalGateway({
    projectRoot: pilotHome,
    pilotHome,
    __testModelFactory: () => TEST_MODEL,
    __testAgentLoopFactory: ({ dependencies }) => createRunner(async () => {
      const history = dependencies.fileHistory as FileHistoryStore | undefined;
      assert.ok(history);
      restoredMessageIds = history.getState().snapshots.map((snapshot) => snapshot.messageId);
      await history.rewind(firstTurnId);
    }),
  });
  try {
    await drain(second.gateway.submitTurn({
      sessionKey,
      channelKey: "test",
      message: "resume",
      runId: "turn-2",
      canPrompt: false,
    }));
  } finally {
    await second.dispose();
  }

  assert.deepEqual(restoredMessageIds, [firstTurnId]);
  assert.equal(await readFile(filePath, "utf8"), "before\n");
});

function isFileSnapshotEntry(
  entry: AgentTranscriptEntry,
): entry is AgentFileSnapshotRecordedTranscriptEntry {
  return entry.type === "file_snapshot_recorded";
}

function createRunner(
  onRun: (input: AgentLoopInput) => Promise<void>,
) {
  return {
    snapshotFileState: () => ({}),
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      await onRun(input);
      const finalMessage = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
      };
      const result: AgentLoopRunResult = {
        result: {
          type: "success",
          sessionId: input.sessionId,
          turnId: input.turnId,
          finalMessage,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-06T00:00:00.000Z",
          completedAt: "2026-09-06T00:00:00.001Z",
        },
        messages: [...input.messages, finalMessage],
      };
      yield {
        type: "turn_completed",
        sessionId: input.sessionId,
        turnId: input.turnId,
        result: result.result,
      };
      return result;
    },
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Drain the gateway stream to completion.
  }
}

const TEST_MODEL: ModelRuntime = {
  async *stream() {},
  async complete() {
    return { role: "assistant", content: [{ type: "text", text: "" }], finishReason: "stop" };
  },
  getCapabilities() {
    return DEFAULT_MODEL_CAPABILITIES;
  },
  getMultimodal() {
    return { input: ["text"] };
  },
  getProviderProtocol() {
    return "openai";
  },
  getProviderBaseUrl() {
    return undefined;
  },
};

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 8192
  maxOutputTokens: 1024
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 8192
            maxOutputTokens: 1024
`;
