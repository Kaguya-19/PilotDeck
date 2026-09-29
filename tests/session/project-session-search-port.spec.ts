import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectSessionSearchPort,
  InMemorySessionPersistence,
  InMemorySessionProjectionCheckpointStore,
  ProjectSessionSearchUnavailableError,
  type ProjectSessionStorageProvider,
  type SessionSearchPort,
} from "../../src/session/index.js";

function provider(search?: SessionSearchPort): ProjectSessionStorageProvider {
  return {
    create() {
      return {
        persistence: new InMemorySessionPersistence(),
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
    ...(search ? { search } : {}),
  };
}

test("project session search selects the provider-owned capability", async () => {
  const calls: unknown[] = [];
  const search: SessionSearchPort = {
    async search(input) {
      calls.push(input);
      return { query: input.query, matches: [], truncated: false, sessionsScanned: 0 };
    },
  };
  const selected = createProjectSessionSearchPort({ storageProvider: provider(search) });
  assert.equal(selected, search);
  await selected.search({ pilotHome: "/virtual/home", projectRoot: "/virtual/project", query: "incident" });
  assert.deepEqual(calls, [{ pilotHome: "/virtual/home", projectRoot: "/virtual/project", query: "incident" }]);
});

test("non-native provider without search fails closed instead of scanning JSONL", async () => {
  const selected = createProjectSessionSearchPort({ storageProvider: provider() });
  await assert.rejects(
    selected.search({ pilotHome: "/virtual/home", projectRoot: "/virtual/project", query: "incident" }),
    ProjectSessionSearchUnavailableError,
  );
});
