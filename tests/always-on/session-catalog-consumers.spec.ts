import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildChatDigest } from "../../src/always-on/context/ChatDigestBuilder.js";
import {
  AlwaysOnRunContextRegistry,
  createAlwaysOnRuntime,
  defaultAlwaysOnConfig,
  resolveAlwaysOnPaths,
} from "../../src/always-on/index.js";
import {
  createAlwaysOnChatHistoryTool,
  type AlwaysOnChatHistoryOutput,
} from "../../src/always-on/tool/AlwaysOnChatHistoryTool.js";
import { getPilotProjectChatDir } from "../../src/pilot/paths.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { SessionCatalogListInput, SessionCatalogPort, SessionInfo } from "../../src/session/catalog/SessionCatalogPort.js";
import type { SessionTranscriptReaderPort } from "../../src/session/history/SessionTranscriptReaderPort.js";
import {
  InMemorySessionPersistence,
  InMemorySessionProjectionCheckpointStore,
  type ProjectSessionStorageProvider,
} from "../../src/session/index.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

test("chat digest lists sessions through the injected catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-catalog-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sessionId = "chat-session";
  await writeConversation(projectRoot, pilotHome, sessionId, "Digest prompt");

  const calls: SessionCatalogListInput[] = [];
  const readerCalls: unknown[] = [];
  const catalog: SessionCatalogPort = {
    async list(input) {
      calls.push(input);
      return [session(sessionId, "Digest title")];
    },
  };
  const sessionTranscriptReader: SessionTranscriptReaderPort = {
    async read() {
      throw new Error("Digest must not request the full transcript.");
    },
    async readUserPromptDigest(input) {
      readerCalls.push(input);
      return { prompts: ["Digest prompt"] };
    },
  };

  const digest = await buildChatDigest({
    projectRoot,
    pilotHome,
    sessionCatalog: catalog,
    sessionTranscriptReader,
    now: () => new Date("2026-09-10T00:00:00.000Z"),
  });

  assert.deepEqual(calls, [{ projectRoot, pilotHome, includeInternal: false }]);
  assert.deepEqual(digest.sessions, [{
    sessionId,
    alias: "chat_1",
    title: "Digest title",
    lastModified: new Date(1).toISOString(),
    userPrompts: ["Digest prompt"],
  }]);
  assert.equal(digest.aliasMap.get("chat_1"), sessionId);
  assert.deepEqual(readerCalls, [{
    projectRoot,
    pilotHome,
    sessionId,
    maxPrompts: 8,
    maxPromptLength: 500,
  }]);
});

test("chat-history tool resolves catalog metadata through its injected catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-catalog-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sessionId = "chat-session";
  const discoverySessionKey = "always-on/discovery:run=run-1";
  await writeConversation(projectRoot, pilotHome, sessionId, "History prompt");

  const calls: SessionCatalogListInput[] = [];
  const readerCalls: unknown[] = [];
  const catalog: SessionCatalogPort = {
    async list(input) {
      calls.push(input);
      return [session(sessionId, "Catalog title")];
    },
  };
  const sessionTranscriptReader: SessionTranscriptReaderPort = {
    async read(input) {
      readerCalls.push(input);
      return {
        entries: [{
          type: "accepted_input",
          sessionId,
          turnId: "turn-1",
          sequence: 1,
          createdAt: "2026-09-10T00:00:00.000Z",
          messages: [{ role: "user", content: [{ type: "text", text: "History prompt" }] }],
        }],
        diagnostics: [],
      };
    },
    async readUserPromptDigest() {
      return { prompts: [] };
    },
  };
  const runContexts = new AlwaysOnRunContextRegistry();
  runContexts.register({
    kind: "discovery",
    sessionKey: discoverySessionKey,
    runId: "run-1",
    projectKey: projectRoot,
    paths: resolveAlwaysOnPaths({ projectKey: projectRoot, pilotHome }),
    startedAt: new Date("2026-09-10T00:00:00.000Z"),
    planStore: {} as never,
    planCallCount: 0,
    chatSessionAliases: new Map([["chat_1", sessionId]]),
  });
  const tool = createAlwaysOnChatHistoryTool({ runContexts, sessionCatalog: catalog, sessionTranscriptReader });

  const output = await tool.execute(
    { sessionId: "chat_1" },
    toolContext(discoverySessionKey, projectRoot),
  );

  assert.deepEqual(calls, [{ projectRoot, pilotHome, includeInternal: false }]);
  assert.equal(output.data?.sessionId, sessionId);
  assert.equal(output.data?.title, "Catalog title");
  assert.deepEqual(output.data?.conversation, [{
    role: "user",
    text: "History prompt",
    createdAt: "",
  }]);
  assert.deepEqual(readerCalls, [{ projectRoot, pilotHome, sessionId }]);
});

test("Always-On runtime derives its chat-history readers from the selected storage provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-storage-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const sessionId = "memory-session";
  const persistence = new InMemorySessionPersistence();
  persistence.entries.push({
    type: "accepted_input",
    sessionId,
    turnId: "turn-1",
    sequence: 1,
    createdAt: "2026-09-11T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text: "Provider-backed history" }] }],
  });
  const catalogCalls: SessionCatalogListInput[] = [];
  const storageProvider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence,
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
    catalog: {
      async list(input) {
        catalogCalls.push(input);
        return [session(sessionId, "Provider title")];
      },
    },
  };
  const runtime = createAlwaysOnRuntime({
    config: defaultAlwaysOnConfig(),
    pilotHome,
    projectKey: projectRoot,
    storageProvider,
  });
  const discoverySessionKey = "always-on/discovery:run=run-storage";

  try {
    runtime.getRunContexts().register({
      kind: "discovery",
      sessionKey: discoverySessionKey,
      runId: "run-storage",
      projectKey: projectRoot,
      paths: resolveAlwaysOnPaths({ projectKey: projectRoot, pilotHome }),
      startedAt: new Date("2026-09-11T00:00:00.000Z"),
      planStore: {} as never,
      planCallCount: 0,
    });
    const history = runtime.getTools().find((tool) => tool.name === "always_on_read_chat_history");
    assert.ok(history);

    const output = await history.execute({ sessionId }, toolContext(discoverySessionKey, projectRoot));

    const data = output.data as AlwaysOnChatHistoryOutput | undefined;
    assert.equal(data?.title, "Provider title");
    assert.deepEqual(data?.conversation, [{
      role: "user",
      text: "Provider-backed history",
      createdAt: "",
    }]);
    assert.deepEqual(catalogCalls, [{ projectRoot, pilotHome, includeInternal: false }]);
  } finally {
    await runtime.stop();
  }
});

function session(sessionId: string, summary: string): SessionInfo {
  return { sessionId, summary, lastModified: 1 };
}

async function writeConversation(
  projectRoot: string,
  pilotHome: string,
  sessionId: string,
  text: string,
): Promise<void> {
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  await mkdir(chatDir, { recursive: true });
  await writeFile(
    join(chatDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: "accepted_input",
      sessionId,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-09-10T00:00:00.000Z",
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    })}\n`,
    "utf8",
  );
}

function toolContext(sessionId: string, cwd: string): PilotDeckToolRuntimeContext {
  return {
    sessionId,
    turnId: "turn-1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "bypassPermissions",
      bypassAvailable: true,
    }),
  };
}
