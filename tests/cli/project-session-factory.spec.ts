import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import { ProjectSessionFactory } from "../../src/cli/ProjectSessionFactory.js";

function factoryWithPreparedResources(input: {
  createStorage: () => Promise<never>;
  release: () => Promise<void>;
}) {
  const factory = new ProjectSessionFactory({
    createStorage: input.createStorage,
    now: () => new Date("2026-09-18T00:00:00.000Z"),
  } as never);
  (factory as unknown as {
    prepare: () => Promise<{ runtime: object; resources: { release(): Promise<void> } }>;
  }).prepare = async () => ({
    runtime: {},
    resources: { release: input.release },
  });
  return factory;
}

test("ProjectSessionFactory releases prepared resources when storage creation fails", async () => {
  let releases = 0;
  const factory = factoryWithPreparedResources({
    createStorage: async () => { throw new Error("storage unavailable"); },
    release: async () => { releases += 1; },
  });

  await assert.rejects(
    () => factory.createSession({ sessionKey: "storage-failure", channelKey: "test" }),
    /storage unavailable/,
  );
  assert.equal(releases, 1);
});

test("ProjectSessionFactory releases prepared resources when reload snapshot fails", async () => {
  let releases = 0;
  let storageCreates = 0;
  const factory = factoryWithPreparedResources({
    createStorage: async () => {
      storageCreates += 1;
      throw new Error("storage must not be created");
    },
    release: async () => { releases += 1; },
  });
  const previous = {
    snapshotForRuntimeReload() {
      throw new Error("snapshot unavailable");
    },
  } as unknown as AgentSession;

  await assert.rejects(
    () => factory.recreateSession({ sessionKey: "snapshot-failure", channelKey: "test" }, previous),
    /snapshot unavailable/,
  );
  assert.equal(storageCreates, 0);
  assert.equal(releases, 1);
});
