import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChannelAdapter, ChannelStartDeps } from "../../src/adapters/index.js";
import { startPilotDeckServer } from "../../src/cli/pilotdeckServer.js";
import type { Gateway } from "../../src/gateway/index.js";
import type { SessionSearchPort } from "../../src/session/search/SessionSearchPort.js";
import {
  InMemorySessionPersistence,
  InMemorySessionProjectionCheckpointStore,
  type ProjectSessionStorageProvider,
} from "../../src/session/index.js";

test("server passes the application-selected search capability to channel startup", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-server-search-"));
  const sessionSearch: SessionSearchPort = {
    async search() {
      return { query: "", matches: [], truncated: false, sessionsScanned: 0 };
    },
  };
  let received: ChannelStartDeps | undefined;
  const channel: ChannelAdapter = {
    channelKey: "telegram",
    async start(deps) {
      received = deps;
      return { stop: async () => undefined };
    },
  };
  const server = await startPilotDeckServer({
    gateway: {} as Gateway,
    port: 0,
    pilotHome,
    sessionSearch,
  });
  t.after(async () => {
    await server.close();
    await rm(pilotHome, { recursive: true, force: true });
  });

  await server.hotStartChannel(channel);

  assert.equal(received?.sessionSearch, sessionSearch);
  assert.equal(received?.pilotHome, pilotHome);
});

test("server derives search from the selected storage provider when no explicit port is supplied", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-server-search-provider-"));
  const sessionSearch: SessionSearchPort = {
    async search() {
      return { query: "", matches: [], truncated: false, sessionsScanned: 0 };
    },
  };
  const provider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence: new InMemorySessionPersistence(),
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
    search: sessionSearch,
  };
  let received: ChannelStartDeps | undefined;
  const channel: ChannelAdapter = {
    channelKey: "telegram",
    async start(deps) {
      received = deps;
      return { stop: async () => undefined };
    },
  };
  const server = await startPilotDeckServer({
    gateway: {} as Gateway,
    port: 0,
    pilotHome,
    storageProvider: provider,
  });
  t.after(async () => {
    await server.close();
    await rm(pilotHome, { recursive: true, force: true });
  });

  await server.hotStartChannel(channel);
  assert.equal(received?.sessionSearch, sessionSearch);
});
