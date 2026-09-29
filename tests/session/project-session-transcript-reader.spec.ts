import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentProjectSessionStorage,
  createProjectSessionTranscriptReader,
  type ProjectSessionStorageBackends,
  type ProjectSessionStorageProvider,
} from "../../src/session/index.js";
import { InMemorySessionPersistence } from "../../src/session/persistence/InMemorySessionPersistence.js";
import { InMemorySessionProjectionCheckpointStore } from "../../src/session/projection/checkpoint/InMemorySessionProjectionCheckpointStore.js";

test("project session transcript reader uses the selected persistence provider for full history and digest", async () => {
  const backends = new Map<string, ProjectSessionStorageBackends>();
  const provider: ProjectSessionStorageProvider = {
    create(input) {
      let backend = backends.get(input.transcriptPath);
      if (!backend) {
        backend = {
          persistence: new InMemorySessionPersistence(),
          projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
        };
        backends.set(input.transcriptPath, backend);
      }
      return backend;
    },
  };
  const projectRoot = "/virtual/project";
  const pilotHome = "/virtual/pilot-home";
  const sessionId = "session-history";
  const reader = createProjectSessionTranscriptReader({ storageProvider: provider });
  const storage = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId,
    storageProvider: provider,
  });
  await storage.persistence.append({
    type: "accepted_input",
    sessionId,
    turnId: "turn-1",
    sequence: 1,
    createdAt: "2026-09-11T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text: "First prompt" }] }],
  });
  await storage.persistence.append({
    type: "accepted_input",
    sessionId,
    turnId: "turn-2",
    sequence: 2,
    createdAt: "2026-09-11T00:01:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text: "Second prompt is long" }] }],
  });

  const history = await reader.read({ projectRoot, pilotHome, sessionId });
  assert.deepEqual(history.entries.map((entry) => entry.sequence), [1, 2]);
  assert.deepEqual(history.diagnostics, []);

  const digest = await reader.readUserPromptDigest({
    projectRoot,
    pilotHome,
    sessionId,
    maxPrompts: 2,
    maxPromptLength: 12,
  });
  assert.deepEqual(digest.prompts, ["First prompt", "Second promp..."]);
  await storage.dispose();
});
