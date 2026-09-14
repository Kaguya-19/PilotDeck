import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, relative } from "node:path";
import test from "node:test";

import { readSubagentWebMessages } from "../../src/web/server/readSessionMessages.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import type {
  ProjectSessionStorageBackends,
  ProjectSessionStorageProvider,
} from "../../src/session/storage/ProjectSessionStorageProvider.js";
import { InMemorySessionPersistence } from "../../src/session/persistence/InMemorySessionPersistence.js";
import { InMemorySessionProjectionCheckpointStore } from "../../src/session/projection/checkpoint/InMemorySessionProjectionCheckpointStore.js";
import type { SessionCatalogPort } from "../../src/session/catalog/SessionCatalogPort.js";

test("Web subagent history reads parent and one-shot child from the selected storage provider", async () => {
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
  const projectRoot = "/virtual/provider-sidechain-project";
  const pilotHome = "/virtual/provider-sidechain-home";
  const sessionId = "provider-parent";
  const subagentId = "provider-child";
  const childSessionId = `${projectRoot}::sub::${subagentId}`;
  const parent = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome,
    sessionId,
    storageProvider: provider,
    now: () => new Date("2026-09-11T00:00:00.000Z"),
  });
  const child = parent.createSidechainStorage({
    sessionId: childSessionId,
    subagentId,
    now: () => new Date("2026-09-11T00:00:01.000Z"),
  });
  try {
    await parent.transcript.recordSubagentStarted(sessionId, "parent-turn", {
      subagentId,
      subagentType: "explore",
      prompt: "Inspect durable provider history.",
      transcriptRelativePath: relative(dirname(parent.transcriptPath), child.transcriptPath),
      subagentSessionId: childSessionId,
    });
    await child.transcript.recordAcceptedInput(childSessionId, "child-turn", [
      { role: "user", content: [{ type: "text", text: "Inspect provider history." }] },
    ]);
    await child.transcript.recordDurableMessage(childSessionId, "child-turn", {
      role: "assistant",
      content: [{ type: "text", text: "Provider-backed child result." }],
    });
    await child.dispose();
    await parent.dispose();

    assert.equal(existsSync(parent.transcriptPath), false);
    assert.equal(existsSync(child.transcriptPath), false);

    const sessionCatalog: SessionCatalogPort = { async list() { return []; } };
    const result = await readSubagentWebMessages(
      { sessionKey: sessionId, subagentId },
      { projectRoot, pilotHome, sessionCatalog, storageProvider: provider },
    );

    assert.equal(result.total, 1);
    assert.equal(result.messages[0]?.role, "assistant");
    assert.equal(result.messages[0]?.text, "Provider-backed child result.");
  } finally {
    await child.dispose();
    await parent.dispose();
  }
});
