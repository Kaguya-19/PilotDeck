import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import {
  createAgentProjectSessionStorage,
  InMemorySessionPersistence,
  InMemorySessionProjectionCheckpointStore,
  sanitizeSessionIdForPath,
  type ProjectSessionReplacementPort,
  type ProjectSessionStorageBackends,
  type ProjectSessionStorageProvider,
} from "../../src/session/index.js";
import {
  finalizeLastWebSessionTurnReplacement,
  replaceLastWebSessionTurn,
} from "../../src/web/server/replaceLastTurn.js";

const createdAt = "2026-09-11T00:00:00.000Z";
const replacementTurnId = "99999999-9999-4999-8999-999999999999";

test("web replacement uses the selected provider for prepare, rollback, and recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-replace-storage-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sessionId = "web:s_replace_provider";
  const { provider, replacementPort, prepareCalls, entriesFor } = createInMemoryReplacementProvider();
  const source = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId,
    storageProvider: provider,
    now: () => new Date(createdAt),
  });
  await recordCompletedTurn(source, sessionId, "turn-1", "first prompt", "first answer");
  await recordCompletedTurn(source, sessionId, "turn-2", "second prompt", "second answer");
  await source.dispose();

  const prepared = await replaceLastWebSessionTurn({
    sessionKey: sessionId,
    expectedTurnId: "turn-2",
    replacementTurnId,
  }, {
    projectRoot,
    pilotHome,
    storageProvider: provider,
    now: () => new Date(createdAt),
    transactionOwner: { instanceId: "gateway", pid: 42 },
  });

  assert.equal(prepareCalls.length, 1);
  assert.equal(prepareCalls[0]?.sessionId, sessionId);
  assert.equal(prepareCalls[0]?.replacementTurnId, replacementTurnId);
  assert.equal(prepared.replacedTurnId, "turn-2");
  assert.equal(prepared.removedEntryCount, 3);
  assert.deepEqual(entriesFor(sessionId).map((entry) => entry.turnId), ["turn-1", "turn-1", "turn-1"]);
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  assert.equal(existsSync(resolve(chatDir, `${sanitizeSessionIdForPath(sessionId)}.jsonl`)), false);

  await finalizeLastWebSessionTurnReplacement({
    sessionKey: sessionId,
    transactionId: prepared.transactionId,
    action: "rollback",
  }, { projectRoot, pilotHome, storageProvider: provider });
  assert.deepEqual(entriesFor(sessionId).map((entry) => entry.turnId), [
    "turn-1", "turn-1", "turn-1", "turn-2", "turn-2", "turn-2",
  ]);

  await replaceLastWebSessionTurn({
    sessionKey: sessionId,
    expectedTurnId: "turn-2",
    replacementTurnId,
  }, { projectRoot, pilotHome, storageProvider: provider, now: () => new Date(createdAt) });
  const replacement = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId,
    storageProvider: provider,
    now: () => new Date(createdAt),
  });
  await replacement.restore();
  await replacement.transcript.recordAcceptedInput(sessionId, replacementTurnId, [
    { role: "user", content: [{ type: "text", text: "corrected prompt" }] },
  ]);
  await replacement.dispose();

  assert.deepEqual(replacementPort.recover({ pilotHome }), {
    committed: 1,
    rolledBack: 0,
    cleaned: 1,
    skipped: 0,
    failures: [],
  });
});

test("web replacement fails closed when the selected provider does not own replacement transactions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-replace-no-provider-port-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sessionId = "web:s_replace_unavailable";
  const persistence = new InMemorySessionPersistence();
  const projectionCheckpointStore = new InMemorySessionProjectionCheckpointStore();
  const provider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence,
        projectionCheckpointStore,
      };
    },
  };
  const source = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId, storageProvider: provider });
  await source.transcript.recordAcceptedInput(sessionId, "turn-1", [
    { role: "user", content: [{ type: "text", text: "must not fall back" }] },
  ]);
  await source.dispose();

  await assert.rejects(
    replaceLastWebSessionTurn({
      sessionKey: sessionId,
      expectedTurnId: "turn-1",
      replacementTurnId,
    }, { projectRoot, pilotHome, storageProvider: provider }),
    /does not support replacement transactions/,
  );
  assert.equal(
    existsSync(resolve(getPilotProjectChatDir(projectRoot, pilotHome), `${sanitizeSessionIdForPath(sessionId)}.jsonl`)),
    false,
  );
});

test("local Gateway runs selected replacement recovery before publishing providers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-replace-provider-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const { provider, replacementPort } = createInMemoryReplacementProvider();

  const local = createLocalGateway({ projectRoot: root, pilotHome: root, storageProvider: provider });
  try {
    assert.equal(replacementPort.recoveryCalls, 1);
  } finally {
    await local.dispose();
  }
});

function createInMemoryReplacementProvider(): {
  provider: ProjectSessionStorageProvider;
  replacementPort: ProjectSessionReplacementPort & { recoveryCalls: number };
  prepareCalls: Array<{ sessionId: string; replacementTurnId: string }>;
  entriesFor(sessionId: string): import("../../src/session/index.js").AgentTranscriptEntry[];
} {
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const transactions = new Map<string, {
    sessionId: string;
    replacementTurnId: string;
    originalEntries: import("../../src/session/index.js").AgentTranscriptEntry[];
  }>();
  const prepareCalls: Array<{ sessionId: string; replacementTurnId: string }> = [];
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
  const replaceEntries = (sessionId: string, entries: readonly import("../../src/session/index.js").AgentTranscriptEntry[]) => {
    const persistence = backend(sessionId).persistence as InMemorySessionPersistence;
    persistence.entries.splice(0, persistence.entries.length, ...entries.map((entry) => structuredClone(entry)));
  };
  const replacementPort: ProjectSessionReplacementPort & { recoveryCalls: number } = {
    recoveryCalls: 0,
    async prepare(input) {
      if (transactions.has(input.transactionId)) throw new Error("Replacement transaction already exists.");
      prepareCalls.push({ sessionId: input.sessionId, replacementTurnId: input.replacementTurnId });
      transactions.set(input.transactionId, {
        sessionId: input.sessionId,
        replacementTurnId: input.replacementTurnId,
        originalEntries: input.originalEntries.map((entry) => structuredClone(entry)),
      });
      replaceEntries(input.sessionId, input.replacementEntries);
    },
    async finalize(input) {
      const transaction = transactions.get(input.transactionId);
      if (!transaction || transaction.sessionId !== input.sessionId) {
        throw new Error("Replacement transaction is unavailable.");
      }
      if (input.action === "rollback") replaceEntries(transaction.sessionId, transaction.originalEntries);
      transactions.delete(input.transactionId);
    },
    recover() {
      replacementPort.recoveryCalls += 1;
      let committed = 0;
      let rolledBack = 0;
      for (const [transactionId, transaction] of transactions) {
        const accepted = entriesFor(transaction.sessionId).some(
          (entry) => entry.type === "accepted_input" && entry.turnId === transaction.replacementTurnId,
        );
        if (accepted) {
          committed += 1;
        } else {
          replaceEntries(transaction.sessionId, transaction.originalEntries);
          rolledBack += 1;
        }
        transactions.delete(transactionId);
      }
      return { committed, rolledBack, cleaned: committed + rolledBack, skipped: 0, failures: [] };
    },
  };
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      return backend(input.sessionId);
    },
    replacement: replacementPort,
  };
  const entriesFor = (sessionId: string) => (backend(sessionId).persistence as InMemorySessionPersistence).entries;
  return { provider, replacementPort, prepareCalls, entriesFor };
}

async function recordCompletedTurn(
  storage: ReturnType<typeof createAgentProjectSessionStorage>,
  sessionId: string,
  turnId: string,
  prompt: string,
  answer: string,
): Promise<void> {
  await storage.transcript.recordAcceptedInput(sessionId, turnId, [
    { role: "user", content: [{ type: "text", text: prompt }] },
  ]);
  await storage.transcript.recordDurableMessage(sessionId, turnId, {
    role: "assistant",
    content: [{ type: "text", text: answer }],
  });
  await storage.transcript.recordTurnResult(sessionId, turnId, {
    type: "success",
    sessionId,
    turnId,
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: createdAt,
    completedAt: createdAt,
  });
}

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
