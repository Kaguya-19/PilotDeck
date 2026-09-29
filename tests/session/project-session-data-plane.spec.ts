import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectSessionDataPlane,
  nodeProjectSessionStorageProvider,
  ProjectSessionCatalogUnavailableError,
  ProjectSessionForkUnavailableError,
  ProjectSessionReplacementUnavailableError,
  ProjectSessionSearchUnavailableError,
  type ProjectSessionPersistenceProvider,
  type ProjectSessionStorageProvider,
} from "../../src/session/index.js";

const unusedPersistence: ProjectSessionPersistenceProvider = {
  create() {
    throw new Error("not used");
  },
};

test("session data plane gives explicit ports precedence over legacy capabilities", () => {
  const legacyCatalog = { async list() { return []; } };
  const explicitCatalog = { async list() { return []; } };
  const legacyFork = { async fork() {} };
  const explicitFork = { async fork() {} };
  const legacyReplacement = {
    async prepare() {},
    async finalize() {},
    recover: () => ({ committed: 0, rolledBack: 0, cleaned: 0, skipped: 0, failures: [] }),
  };
  const explicitReplacement = { ...legacyReplacement };
  const legacySearch = { async search() { return { query: "", matches: [], truncated: false, sessionsScanned: 0 }; } };
  const explicitSearch = { ...legacySearch };
  const legacy: ProjectSessionStorageProvider = {
    ...unusedPersistence,
    catalog: legacyCatalog,
    fork: legacyFork,
    replacement: legacyReplacement,
    search: legacySearch,
  };

  const plane = createProjectSessionDataPlane({
    storageProvider: legacy,
    catalog: explicitCatalog,
    fork: explicitFork,
    replacement: explicitReplacement,
    search: explicitSearch,
  });

  assert.ok(Object.isFrozen(plane));
  assert.equal(plane.persistence, legacy);
  assert.equal(plane.catalog, explicitCatalog);
  assert.equal(plane.fork, explicitFork);
  assert.equal(plane.replacement, explicitReplacement);
  assert.equal(plane.search, explicitSearch);
});

test("session data plane preserves legacy provider capabilities", () => {
  const legacy: ProjectSessionStorageProvider = {
    ...unusedPersistence,
    catalog: { async list() { return []; } },
    fork: { async fork() {} },
    replacement: {
      async prepare() {},
      async finalize() {},
      recover: () => ({ committed: 0, rolledBack: 0, cleaned: 0, skipped: 0, failures: [] }),
    },
    search: { async search() { return { query: "", matches: [], truncated: false, sessionsScanned: 0 }; } },
  };
  const plane = createProjectSessionDataPlane({ storageProvider: legacy });

  assert.equal(plane.catalog, legacy.catalog);
  assert.equal(plane.fork, legacy.fork);
  assert.equal(plane.replacement, legacy.replacement);
  assert.equal(plane.search, legacy.search);
});

test("native persistence receives all native data-plane capabilities", () => {
  const plane = createProjectSessionDataPlane({
    persistenceProvider: nodeProjectSessionStorageProvider,
  });

  assert.equal(plane.persistence, nodeProjectSessionStorageProvider);
  assert.equal(typeof plane.catalog.list, "function");
  assert.equal(typeof plane.fork.fork, "function");
  assert.equal(typeof plane.replacement.prepare, "function");
  assert.equal(typeof plane.search.search, "function");
});

test("custom persistence without data-plane capabilities remains fail-closed", async () => {
  const plane = createProjectSessionDataPlane({ persistenceProvider: unusedPersistence });

  await assert.rejects(
    plane.catalog.list({ projectRoot: "/project", pilotHome: "/pilot" }),
    ProjectSessionCatalogUnavailableError,
  );
  await assert.rejects(plane.fork.fork({} as never), ProjectSessionForkUnavailableError);
  await assert.rejects(plane.replacement.prepare({} as never), ProjectSessionReplacementUnavailableError);
  await assert.rejects(plane.search.search({} as never), ProjectSessionSearchUnavailableError);
});
