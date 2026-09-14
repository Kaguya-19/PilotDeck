import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeSessionModelSelectionPort } from "../../src/model/session/NativeSessionModelSelectionPort.js";
import { InMemorySessionPersistence } from "../../src/session/persistence/InMemorySessionPersistence.js";
import { InMemorySessionProjectionCheckpointStore } from "../../src/session/projection/checkpoint/InMemorySessionProjectionCheckpointStore.js";
import type { SessionProjectionCheckpointStore } from "../../src/session/projection/checkpoint/SessionProjectionCheckpointStore.js";
import type {
  ProjectSessionStorageBackends,
  ProjectSessionStorageProvider,
  ProjectSessionStorageProviderInput,
} from "../../src/session/storage/ProjectSessionStorageProvider.js";

test("native session model selection port uses the existing session transcript as durable truth", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-model-selection-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-model-selection-home-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  });

  const selection = new NativeSessionModelSelectionPort({
    pilotHome,
    now: () => new Date("2026-09-09T00:00:00.000Z"),
  });
  const scope = { projectKey: projectRoot, sessionKey: "web:model-selection" };

  assert.equal(await selection.read(scope), undefined);
  await selection.write({
    ...scope,
    selection: { mode: "model", provider: "custom", model: "durable-model", temperature: 0.4 },
  });
  assert.deepEqual(await selection.read(scope), {
    mode: "model",
    provider: "custom",
    model: "durable-model",
    temperature: 0.4,
  });

  await selection.clear(scope);
  assert.equal(await selection.read(scope), undefined);
  await assert.rejects(
    selection.read({ projectKey: projectRoot, sessionKey: "" }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "INVALID_SESSION_KEY",
  );
});

test("native session model selection uses the selected storage provider without read-side projection effects", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-model-selection-provider-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-model-selection-provider-home-"));
  t.after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  });

  const calls: ProjectSessionStorageProviderInput[] = [];
  const backends = new Map<string, ProjectSessionStorageBackends>();
  let checkpointSaveCount = 0;
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      calls.push({ ...input });
      let backendsForSession = backends.get(input.transcriptPath);
      if (!backendsForSession) {
        const checkpoints = new InMemorySessionProjectionCheckpointStore();
        const checkpointStore: SessionProjectionCheckpointStore = {
          load: (sessionId) => checkpoints.load(sessionId),
          async save(envelope) {
            checkpointSaveCount += 1;
            await checkpoints.save(envelope);
          },
        };
        backendsForSession = {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: checkpointStore,
        };
        backends.set(input.transcriptPath, backendsForSession);
      }
      return backendsForSession;
    },
  };
  const selection = new NativeSessionModelSelectionPort({
    pilotHome,
    now: () => new Date("2026-09-10T00:00:00.000Z"),
    storageProvider: provider,
  });
  const scope = { projectKey: projectRoot, sessionKey: "web:model-selection-provider" };

  assert.equal(await selection.read(scope), undefined);
  assert.equal(calls.length, 1);
  assert.equal(checkpointSaveCount, 0);
  assert.equal(existsSync(calls[0]!.transcriptPath), false);

  const saved = { mode: "model" as const, provider: "custom", model: "provider-model" };
  await selection.write({ ...scope, selection: saved });
  assert.deepEqual(await selection.read(scope), saved);
  assert.equal(checkpointSaveCount, 1);

  await selection.clear(scope);
  assert.equal(await selection.read(scope), undefined);
  assert.equal(checkpointSaveCount, 2);

  const backend = backends.get(calls[0]!.transcriptPath)!;
  const entries = (await backend.persistence.load()).entries;
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2]);
  assert.equal(existsSync(calls[0]!.transcriptPath), false);
});
