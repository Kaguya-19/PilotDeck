import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionSubagentTranscriptBundle } from "../../src/cli/SessionSubagentTranscriptBundle.js";
import { readTranscript } from "../../src/session/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import type {
  ProjectSessionStorageBackends,
  ProjectSessionStorageProvider,
  ProjectSessionStorageProviderInput,
} from "../../src/session/storage/ProjectSessionStorageProvider.js";
import { InMemorySessionPersistence } from "../../src/session/persistence/InMemorySessionPersistence.js";
import { InMemorySessionProjectionCheckpointStore } from "../../src/session/projection/checkpoint/InMemorySessionProjectionCheckpointStore.js";

test("session subagent transcript bundle keeps parent references and child sidechain writes on existing storage", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-transcript-"));
  const sessionId = "subagent-transcript-parent";
  const turnId = "parent-turn";
  const subagentId = "child-agent";
  const storage = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome: projectRoot,
    sessionId,
    now: () => new Date("2026-09-09T00:00:00.000Z"),
  });
  t.after(async () => {
    await storage.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  });

  const hooks = new SessionSubagentTranscriptBundle({
    storage,
    now: () => new Date("2026-09-09T00:00:01.000Z"),
  }).compose();
  const sidechain = hooks.subagentTranscriptResolver?.(subagentId, "child-session");
  assert.ok(sidechain);

  await hooks.recordSubagentStarted?.({
    sessionId,
    turnId,
    subagentId,
    subagentType: "general-purpose",
    prompt: "Inspect the durable state.",
    transcriptRelativePath: sidechain.transcriptRelativePath,
    subagentSessionId: "child-session",
  });
  await sidechain.recordAcceptedInput("child-session", "child-turn", [
    { role: "user", content: [{ type: "text", text: "Inspect the durable state." }] },
  ]);
  await sidechain.recordDurableMessage("child-session", "child-turn", {
    role: "assistant",
    content: [{ type: "text", text: "Inspection complete." }],
  });
  await hooks.recordSubagentCompleted?.({
    sessionId,
    turnId,
    subagentId,
    subagentType: "general-purpose",
    summary: "Inspection complete.",
    turns: 1,
    durationMs: 12,
    errored: false,
  });

  const parent = await storage.persistence.load();
  assert.deepEqual(parent.entries.map((entry) => entry.type), [
    "subagent_started",
    "subagent_completed",
  ]);
  assert.equal(parent.entries[0]?.type === "subagent_started"
    ? parent.entries[0].transcriptRelativePath
    : undefined, sidechain.transcriptRelativePath);

  const child = await readTranscript(storage.subagentTranscriptPath(subagentId));
  assert.deepEqual(child.entries.map((entry) => entry.type), [
    "accepted_input",
    "assistant_message",
  ]);
  await sidechain.dispose?.();
});

test("session subagent transcript bundle selects parent storage provider for one-shot sidechains", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-provider-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const calls: ProjectSessionStorageProviderInput[] = [];
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const checkpointSaves = new Map<string, number>();
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      calls.push({ ...input });
      let backendsForPath = backends.get(input.transcriptPath);
      if (!backendsForPath) {
        const checkpointStore = new InMemorySessionProjectionCheckpointStore();
        const save = checkpointStore.save.bind(checkpointStore);
        checkpointStore.save = async (envelope) => {
          checkpointSaves.set(
            input.transcriptPath,
            (checkpointSaves.get(input.transcriptPath) ?? 0) + 1,
          );
          await save(envelope);
        };
        backendsForPath = {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: checkpointStore,
        };
        backends.set(input.transcriptPath, backendsForPath);
      }
      return backendsForPath;
    },
  };
  const sessionId = "provider-parent";
  const subagentId = "provider-child";
  const childSessionId = `${root}::sub::${subagentId}`;
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId,
    storageProvider: provider,
    now: () => new Date("2026-09-11T00:00:00.000Z"),
  });
  t.after(() => storage.dispose());
  const hooks = new SessionSubagentTranscriptBundle({
    storage,
    now: () => new Date("2026-09-11T00:00:01.000Z"),
  }).compose();
  const sidechain = hooks.subagentTranscriptResolver?.(subagentId, childSessionId);
  assert.ok(sidechain);

  await hooks.recordSubagentStarted?.({
    sessionId,
    turnId: "parent-turn",
    subagentId,
    subagentType: "explore",
    prompt: "Inspect provider storage.",
    transcriptRelativePath: sidechain.transcriptRelativePath,
    subagentSessionId: childSessionId,
  });
  await sidechain.recordAcceptedInput(childSessionId, "child-turn", [
    { role: "user", content: [{ type: "text", text: "Inspect provider storage." }] },
  ]);
  await sidechain.recordDurableMessage(childSessionId, "child-turn", {
    role: "assistant",
    content: [{ type: "text", text: "Provider storage inspected." }],
  });
  await sidechain.dispose?.();
  await sidechain.dispose?.();

  assert.equal(existsSync(storage.transcriptPath), false);
  assert.equal(existsSync(storage.subagentTranscriptPath(subagentId)), false);
  assert.deepEqual(calls.map((call) => call.kind), ["agent", "subagent"]);
  assert.deepEqual(calls[1], {
    kind: "subagent",
    sessionId: childSessionId,
    parentSessionId: sessionId,
    transcriptPath: storage.subagentTranscriptPath(subagentId),
    projectionCheckpointPath: `${storage.subagentTranscriptPath(subagentId)}.projections.json`,
  });
  const childBackend = backends.get(storage.subagentTranscriptPath(subagentId));
  assert.ok(childBackend);
  assert.deepEqual(
    (await childBackend.persistence.load()).entries.map((entry) => entry.type),
    ["accepted_input", "assistant_message"],
  );
  assert.equal(checkpointSaves.get(storage.subagentTranscriptPath(subagentId)), 1);
});
