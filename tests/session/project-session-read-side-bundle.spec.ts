import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentProjectSessionStorage,
  createProjectSessionReadSideBundle,
  InMemorySessionPersistence,
  InMemorySessionProjectionCheckpointStore,
  ProjectSessionCatalogUnavailableError,
  type ProjectSessionStorageProvider,
  type SessionCatalogPort,
  type SessionTranscriptReaderPort,
} from "../../src/session/index.js";

test("read-side bundle selects catalog and transcript reader from one storage provider", async () => {
  const persistence = new InMemorySessionPersistence();
  const catalog: SessionCatalogPort = {
    async list() {
      return [{ sessionId: "provider-session", summary: "Provider session", lastModified: 1 }];
    },
  };
  const provider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence,
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
    catalog,
  };
  const projectRoot = "/virtual/project";
  const pilotHome = "/virtual/pilot-home";
  const sessionId = "provider-session";
  const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId, storageProvider: provider });
  await storage.persistence.append({
    type: "accepted_input",
    sessionId,
    turnId: "turn-1",
    sequence: 1,
    createdAt: "2026-09-11T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text: "Selected provider history" }] }],
  });

  const bundle = createProjectSessionReadSideBundle({ storageProvider: provider });
  assert.equal(bundle.catalog, catalog);
  assert.deepEqual(
    await bundle.catalog.list({ projectRoot, pilotHome }),
    [{ sessionId, summary: "Provider session", lastModified: 1 }],
  );
  assert.deepEqual(
    (await bundle.transcriptReader.read({ projectRoot, pilotHome, sessionId })).entries.map((entry) => entry.sequence),
    [1],
  );

  await storage.dispose();
});

test("read-side bundle preserves explicit catalog and transcript-reader overrides", () => {
  const catalog: SessionCatalogPort = { async list() { return []; } };
  const transcriptReader: SessionTranscriptReaderPort = {
    async read() { return { entries: [], diagnostics: [] }; },
    async readUserPromptDigest() { return { prompts: [] }; },
  };

  const bundle = createProjectSessionReadSideBundle({
    storageProvider: {
      create() {
        return {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
        };
      },
    },
    sessionCatalog: catalog,
    sessionTranscriptReader: transcriptReader,
  });

  assert.equal(bundle.catalog, catalog);
  assert.equal(bundle.transcriptReader, transcriptReader);
});

test("read-side bundle fails catalog closed while exact history remains provider-backed", async () => {
  const persistence = new InMemorySessionPersistence();
  const provider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence,
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
  };
  const projectRoot = "/virtual/project";
  const pilotHome = "/virtual/pilot-home";
  const sessionId = "history-without-catalog";
  persistence.entries.push({
    type: "accepted_input",
    sessionId,
    turnId: "turn-1",
    sequence: 1,
    createdAt: "2026-09-11T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text: "Exact history remains available" }] }],
  });

  const bundle = createProjectSessionReadSideBundle({ storageProvider: provider });
  await assert.rejects(
    bundle.catalog.list({ projectRoot, pilotHome }),
    ProjectSessionCatalogUnavailableError,
  );
  assert.equal(
    (await bundle.transcriptReader.read({ projectRoot, pilotHome, sessionId })).entries[0]?.type,
    "accepted_input",
  );
});
