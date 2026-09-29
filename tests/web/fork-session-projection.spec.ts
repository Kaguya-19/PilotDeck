import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import { projectAgentTranscriptEntries } from "../../src/session/projection/AgentTranscriptProjections.js";
import {
  createAgentProjectSessionStorage,
  sanitizeSessionIdForPath,
} from "../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";

const createdAt = "2026-09-06T00:00:00.000Z";

test("forked transcript rebuilds the carried conversation through session projections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sourceSessionId = "web:s_source";
  const storage = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId: sourceSessionId,
    now: () => new Date(createdAt),
  });

  await storage.transcript.recordAcceptedInput(sourceSessionId, "turn-1", [
    { role: "user", content: [{ type: "text", text: "first prompt" }] },
  ]);
  await storage.transcript.recordDurableMessage(sourceSessionId, "turn-1", {
    role: "assistant",
    content: [{ type: "text", text: "first answer" }],
  });
  await storage.transcript.recordTurnResult(sourceSessionId, "turn-1", turnResult(sourceSessionId, "turn-1"));
  await storage.transcript.recordAcceptedInput(sourceSessionId, "turn-2", [
    { role: "user", content: [{ type: "text", text: "second prompt" }] },
  ]);
  await storage.transcript.recordDurableMessage(sourceSessionId, "turn-2", {
    role: "assistant",
    content: [{ type: "text", text: "second answer" }],
  });
  await storage.transcript.recordTurnResult(sourceSessionId, "turn-2", turnResult(sourceSessionId, "turn-2"));

  const sourceEntries = (await storage.persistence.load()).entries;
  const firstAnswer = sourceEntries.find(
    (entry) => entry.type === "assistant_message" && entry.turnId === "turn-1",
  );
  assert.ok(firstAnswer?.entryId);

  const fork = await forkWebSession({
    sessionKey: sourceSessionId,
    fromEntryId: firstAnswer.entryId,
  }, {
    projectRoot,
    pilotHome,
    now: () => new Date(createdAt),
  });
  const forkPath = resolve(
    getPilotProjectChatDir(projectRoot, pilotHome),
    `${sanitizeSessionIdForPath(fork.newSessionKey)}.jsonl`,
  );
  const forkEntries = (await readTranscript(forkPath)).entries;
  const projected = projectAgentTranscriptEntries(forkEntries);

  assert.equal(fork.prefillText, "");
  assert.deepEqual(projected.messages.map((message) => message.content[0]), [
    { type: "text", text: "first prompt" },
    { type: "text", text: "first answer" },
  ]);
  assert.equal(forkEntries.every((entry) => entry.sessionId === fork.newSessionKey), true);

  storage.projections.dispose();
  storage.persistenceBinding.dispose();
});

test("native fork copies session auxiliary artifacts and retargets child transcript references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-native-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sourceSessionId = "web:s_artifact_source";
  const source = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId: sourceSessionId,
    now: () => new Date(createdAt),
  });
  await source.transcript.recordAcceptedInput(sourceSessionId, "turn-1", [
    { role: "user", content: [{ type: "text", text: "fork the artifacts" }] },
  ]);
  const entryId = (await source.persistence.load()).entries[0]?.entryId;
  assert.ok(entryId);

  const fileHistoryPath = join(source.fileHistoryDir, "document@v1");
  const childArtifactPath = join(source.subagentsDir, "child-output.txt");
  const childTranscriptPath = join(source.subagentsDir, "child.jsonl");
  await mkdir(source.fileHistoryDir, { recursive: true });
  await mkdir(source.subagentsDir, { recursive: true });
  await writeFile(fileHistoryPath, "before", "utf8");
  await writeFile(childArtifactPath, "child output", "utf8");
  await writeFile(childTranscriptPath, `${JSON.stringify({
    type: "durable_message",
    message: {
      role: "assistant",
      content: [{
        type: "media_reference",
        path: childArtifactPath,
        originalBytes: 12,
        preview: "child output",
        hasMore: false,
        mimeType: "text/plain",
        mediaType: "audio",
      }],
    },
  })}\n`, "utf8");
  await source.dispose();

  const fork = await forkWebSession({ sessionKey: sourceSessionId, fromEntryId: entryId }, {
    projectRoot,
    pilotHome,
    now: () => new Date(createdAt),
  });

  const targetSessionDir = resolve(
    getPilotProjectChatDir(projectRoot, pilotHome),
    sanitizeSessionIdForPath(fork.newSessionKey),
  );
  assert.equal(await readFile(join(targetSessionDir, "file-history", "document@v1"), "utf8"), "before");
  assert.equal(await readFile(join(targetSessionDir, "subagents", "child-output.txt"), "utf8"), "child output");
  const childTranscript = await readFile(join(targetSessionDir, "subagents", "child.jsonl"), "utf8");
  assert.match(childTranscript, new RegExp(escapeRegExp(join(targetSessionDir, "subagents", "child-output.txt"))));
  assert.doesNotMatch(childTranscript, new RegExp(escapeRegExp(childArtifactPath)));
});

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

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}
