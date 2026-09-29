import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentProjectSessionStorage,
  createSubagentProjectSessionStorage,
} from "../../src/session/storage/ProjectSessionStorage.js";
import { createProjectSessionCatalog } from "../../src/session/catalog/ProjectSessionCatalog.js";
import { createProjectSessionReplacementPort } from "../../src/session/replacement/ProjectSessionReplacementPort.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type {
  ProjectSessionStorageBackends,
  ProjectSessionStorageProvider,
  ProjectSessionStorageProviderInput,
} from "../../src/session/storage/ProjectSessionStorageProvider.js";
import { nodeProjectSessionStorageProvider } from "../../src/session/storage/ProjectSessionStorageProvider.js";
import { InMemorySessionPersistence } from "../../src/session/persistence/InMemorySessionPersistence.js";
import { InMemorySessionProjectionCheckpointStore } from "../../src/session/projection/checkpoint/InMemorySessionProjectionCheckpointStore.js";
import {
  AGENT_TRANSCRIPT_PROJECTION_NAMES,
  requireSessionProjectionValue,
} from "../../src/session/projection/index.js";
import type { SessionMetadataValue } from "../../src/session/transcript/TranscriptEntry.js";

test("project session replacement selects the native provider-owned transaction port by default", () => {
  assert.equal(
    createProjectSessionReplacementPort(),
    nodeProjectSessionStorageProvider.replacement,
  );
});

test("project session catalog selects the catalog owned by the durable storage provider", async () => {
  const listed = [{
    sessionId: "provider-catalog-session",
    summary: "Provider catalog session",
    lastModified: 42,
  }];
  const calls: unknown[] = [];
  const provider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence: new InMemorySessionPersistence(),
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
    catalog: {
      async list(input) {
        calls.push(input);
        return listed;
      },
    },
  };

  const catalog = createProjectSessionCatalog({ storageProvider: provider });
  const result = await catalog.list({ projectRoot: "/virtual/project", pilotHome: "/virtual/home", limit: 4 });

  assert.equal(result, listed);
  assert.deepEqual(calls, [{ projectRoot: "/virtual/project", pilotHome: "/virtual/home", limit: 4 }]);
});

test("non-native storage provider without catalog fails closed instead of scanning JSONL", async () => {
  const provider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence: new InMemorySessionPersistence(),
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
  };

  await assert.rejects(
    createProjectSessionCatalog({ storageProvider: provider }).list({
      projectRoot: "/virtual/project",
      pilotHome: "/virtual/home",
    }),
    /does not support session catalog reads/,
  );
});

test("project session storage composes persistence and checkpoints through the selected provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-session-storage-provider-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const calls: ProjectSessionStorageProviderInput[] = [];
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      calls.push({ ...input });
      let selected = backends.get(input.transcriptPath);
      if (!selected) {
        selected = {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
        };
        backends.set(input.transcriptPath, selected);
      }
      return selected;
    },
  };
  const options = {
    projectRoot: join(root, "project"),
    pilotHome: join(root, "pilot-home"),
    sessionId: "provider-session",
    now: () => new Date("2026-09-10T00:00:00.000Z"),
    storageProvider: provider,
  };
  const storage = createAgentProjectSessionStorage(options);
  await storage.events.append("provider-session", "turn-1", {
    type: "session_metadata",
    metadata: { title: "Persisted through provider" },
  });
  await storage.flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    kind: "agent",
    sessionId: "provider-session",
    transcriptPath: storage.transcriptPath,
    projectionCheckpointPath: storage.projectionCheckpointPath,
  });
  assert.equal(existsSync(storage.transcriptPath), false);
  assert.equal((await storage.persistence.load()).entries.length, 1);
  assert.equal(
    (await storage.projectionCheckpointStore.load("provider-session"))?.asOfSequence,
    1,
  );

  const restored = createAgentProjectSessionStorage(options);
  const replay = await restored.restore();
  assert.equal(replay.entries.length, 1);
  assert.equal(
    requireSessionProjectionValue<SessionMetadataValue>(
      restored.projections.snapshot([AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata]),
      AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata,
    ).title,
    "Persisted through provider",
  );

  const child = createSubagentProjectSessionStorage({
    ...options,
    sessionId: "provider-child",
    parentSessionId: "provider-session",
  });
  assert.deepEqual(calls[2], {
    kind: "subagent",
    sessionId: "provider-child",
    parentSessionId: "provider-session",
    transcriptPath: child.transcriptPath,
    projectionCheckpointPath: child.projectionCheckpointPath,
  });

  await child.dispose();
  await restored.dispose();
  await storage.dispose();
});

test("local Gateway uses the selected storage provider for one-shot history status writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-local-storage-provider-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const calls: ProjectSessionStorageProviderInput[] = [];
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      calls.push({ ...input });
      let selected = backends.get(input.transcriptPath);
      if (!selected) {
        selected = {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
        };
        backends.set(input.transcriptPath, selected);
      }
      return selected;
    },
  };
  const sessionKey = "history-provider-session";
  const existing = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: sessionKey,
    storageProvider: provider,
  });
  await existing.transcript.recordAcceptedInput(sessionKey, "existing-turn", [{
    role: "user",
    content: [{ type: "text", text: "Persisted before the one-shot status" }],
  }]);
  await existing.dispose();

  const local = createLocalGateway({ projectRoot: root, pilotHome: root, storageProvider: provider });
  t.after(async () => {
    await local.dispose();
  });

  const result = await local.gateway.recordAgentStatusMessage!({
    projectKey: root,
    sessionKey,
    turnId: "status-turn",
    status: { event: "working", kind: "status", text: "Working" },
  });

  assert.deepEqual(result, { recorded: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.kind, "agent");
  const backend = backends.get(calls[1]!.transcriptPath)!;
  const entries = (await backend.persistence.load()).entries;
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2]);
  assert.deepEqual(entries.map((entry) => entry.type), ["accepted_input", "agent_status_message"]);
  assert.equal(entries[1]?.sessionId, sessionKey);
});

test("local Gateway reads session history through the selected storage provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-local-storage-history-provider-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      let selected = backends.get(input.transcriptPath);
      if (!selected) {
        selected = {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
        };
        backends.set(input.transcriptPath, selected);
      }
      return selected;
    },
  };
  const sessionKey = "history-read-provider-session";
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: sessionKey,
    storageProvider: provider,
  });
  await storage.transcript.recordAcceptedInput(sessionKey, "history-turn", [{
    role: "user",
    content: [{ type: "text", text: "Read from the selected provider" }],
  }]);
  await storage.flush();
  await storage.dispose();

  assert.equal(existsSync(storage.transcriptPath), false);

  const local = createLocalGateway({ projectRoot: root, pilotHome: root, storageProvider: provider });
  t.after(async () => {
    await local.dispose();
  });

  const result = await local.gateway.readSessionMessages({ projectKey: root, sessionKey });

  assert.equal(result.total, 1);
  assert.equal(result.messages[0]?.role, "user");
  assert.equal(result.messages[0]?.text, "Read from the selected provider");
});

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
