import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import {
  createAgentProjectSessionStorage,
  InMemorySessionPersistence,
  InMemorySessionProjectionCheckpointStore,
  sanitizeSessionIdForPath,
  type ProjectSessionForkInput,
  type ProjectSessionStorageBackends,
  type ProjectSessionStorageProvider,
} from "../../src/session/index.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";

const createdAt = "2026-09-11T00:00:00.000Z";

test("web fork writes the target session through the selected storage provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-storage-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sourceSessionId = "web:s_provider_source";
  const { provider, forkCalls } = createInMemoryStorageProvider({ fork: true });
  const source = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId: sourceSessionId,
    storageProvider: provider,
    now: () => new Date(createdAt),
  });

  await source.transcript.recordAcceptedInput(sourceSessionId, "turn-1", [
    { role: "user", content: [{ type: "text", text: "first prompt" }] },
  ]);
  await source.transcript.recordDurableMessage(sourceSessionId, "turn-1", {
    role: "assistant",
    content: [{ type: "text", text: "first answer" }],
  });
  await source.transcript.recordTurnResult(sourceSessionId, "turn-1", turnResult(sourceSessionId, "turn-1"));
  await source.transcript.recordAcceptedInput(sourceSessionId, "turn-2", [
    { role: "user", content: [{ type: "text", text: "second prompt" }] },
  ]);
  const sourceEntries = (await source.persistence.load()).entries;
  const secondInput = sourceEntries.find((entry) => entry.type === "accepted_input" && entry.turnId === "turn-2");
  assert.ok(secondInput?.entryId);
  await source.dispose();

  const fork = await forkWebSession({
    sessionKey: sourceSessionId,
    fromEntryId: secondInput.entryId,
  }, {
    projectRoot,
    pilotHome,
    storageProvider: provider,
    now: () => new Date(createdAt),
  });

  assert.equal(forkCalls.length, 1);
  assert.equal(forkCalls[0]?.sourceSessionId, sourceSessionId);
  assert.equal(forkCalls[0]?.targetSessionId, fork.newSessionKey);
  assert.ok(forkCalls[0]?.entries.every((entry) => entry.sessionId === fork.newSessionKey));
  assert.equal(fork.prefillText, "second prompt");

  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  assert.equal(existsSync(resolve(chatDir, `${sanitizeSessionIdForPath(sourceSessionId)}.jsonl`)), false);
  assert.equal(existsSync(resolve(chatDir, `${sanitizeSessionIdForPath(fork.newSessionKey)}.jsonl`)), false);

  const target = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId: fork.newSessionKey,
    storageProvider: provider,
  });
  const targetEntries = (await target.restore()).entries;
  assert.deepEqual(targetEntries.map((entry) => entry.type), [
    "accepted_input",
    "assistant_message",
    "turn_result",
    "session_metadata",
  ]);
  assert.equal(targetEntries.every((entry) => entry.sessionId === fork.newSessionKey), true);
  await target.dispose();
});

test("web fork fails closed when the selected storage provider has no fork port", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-fork-no-provider-port-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sourceSessionId = "web:s_no_fork";
  const { provider } = createInMemoryStorageProvider({ fork: false });
  const source = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId: sourceSessionId,
    storageProvider: provider,
    now: () => new Date(createdAt),
  });
  await source.transcript.recordAcceptedInput(sourceSessionId, "turn-1", [
    { role: "user", content: [{ type: "text", text: "cannot fork to JSONL" }] },
  ]);
  const entryId = (await source.persistence.load()).entries[0]?.entryId;
  assert.ok(entryId);
  await source.dispose();

  await assert.rejects(
    forkWebSession({ sessionKey: sourceSessionId, fromEntryId: entryId }, {
      projectRoot,
      pilotHome,
      storageProvider: provider,
    }),
    /does not support session fork writes/,
  );
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  assert.equal(existsSync(resolve(chatDir, `${sanitizeSessionIdForPath(sourceSessionId)}.jsonl`)), false);
});

function createInMemoryStorageProvider(
  options: { fork: boolean },
): { provider: ProjectSessionStorageProvider; forkCalls: ProjectSessionForkInput[] } {
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const forkCalls: ProjectSessionForkInput[] = [];
  const backend = (sessionId: string): ProjectSessionStorageBackends => {
    let selected = backends.get(sessionId);
    if (!selected) {
      selected = {
        persistence: new InMemorySessionPersistence(),
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
      backends.set(sessionId, selected);
    }
    return selected;
  };
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      return backend(input.sessionId);
    },
    ...(options.fork
      ? {
          fork: {
            async fork(input: ProjectSessionForkInput) {
              if (backends.has(input.targetSessionId)) {
                throw new Error(`Fork target session already exists: ${input.targetSessionId}`);
              }
              forkCalls.push({ ...input, entries: input.entries.map((entry) => structuredClone(entry)) });
              const target = backend(input.targetSessionId);
              for (const entry of input.entries) await target.persistence.append(structuredClone(entry));
            },
          },
        }
      : {}),
  };
  return { provider, forkCalls };
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
