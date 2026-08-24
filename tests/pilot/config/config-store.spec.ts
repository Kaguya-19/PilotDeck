import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getPilotConfigFilePath } from "../../../src/pilot/paths.js";
import { createPilotConfigStoreSync } from "../../../src/pilot/config/PilotConfigStore.js";
import { PilotConfigError } from "../../../src/pilot/config/types.js";

function configYaml(model = "first"): string {
  return `schemaVersion: 1
agent:
  model: test/${model}
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models:
        first:
          capabilities:
            maxOutputTokens: 1000
        second:
          capabilities:
            maxOutputTokens: 1000
`;
}

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilotdeck-config-store-"));
}

test("PilotConfigStore publishes reload diffs and serializes concurrent reloads", async (t) => {
  const pilotHome = await makeHome();
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const configPath = getPilotConfigFilePath(pilotHome);
  await writeFile(configPath, configYaml(), "utf8");

  const store = createPilotConfigStoreSync({ env: { PILOT_HOME: pilotHome } });
  assert.equal(store.getSnapshot().version, 1);
  const events: Array<{ changedPaths: string[]; changeClasses: string[] }> = [];
  const unsubscribe = store.subscribe((event) => {
    events.push({ changedPaths: event.changedPaths, changeClasses: event.changeClasses });
  });

  await writeFile(configPath, configYaml("second"), "utf8");
  const first = store.reload("test");
  const second = store.reload("test-concurrent");
  const [snapshot, concurrentSnapshot] = await Promise.all([first, second]);
  assert.equal(snapshot.version, 2);
  assert.equal(concurrentSnapshot, snapshot);
  assert.equal(snapshot.config.agent.model.id, "test/second");
  assert.deepEqual(events, [{
    changedPaths: ["agent.model.id", "agent.model.model"],
    changeClasses: ["next-request"],
  }]);

  unsubscribe();
  await writeFile(configPath, configYaml("first"), "utf8");
  await store.reload();
  assert.equal(events.length, 1);
});

test("PilotConfigStore retains the previous snapshot and diagnostics after reload failure", async (t) => {
  const pilotHome = await makeHome();
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const configPath = getPilotConfigFilePath(pilotHome);
  await writeFile(configPath, configYaml(), "utf8");
  const store = createPilotConfigStoreSync({ env: { PILOT_HOME: pilotHome } });
  const previous = store.getSnapshot();

  await writeFile(configPath, "schemaVersion: [broken\n", "utf8");
  await assert.rejects(store.reload("invalid"), (error: unknown) => error instanceof PilotConfigError);
  assert.equal(store.getSnapshot(), previous);
  assert.equal(store.getDiagnostics().some((item) => item.code === "CONFIG_YAML_INVALID"), true);
});

test("PilotConfigStore watcher can be started and stopped without leaking the config file", async (t) => {
  const pilotHome = await makeHome();
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const configPath = getPilotConfigFilePath(pilotHome);
  await writeFile(configPath, configYaml(), "utf8");
  const store = createPilotConfigStoreSync({ env: { PILOT_HOME: pilotHome } });
  const stopWatching = store.startWatching({ debounceMs: 1 });
  assert.equal(typeof stopWatching, "function");
  stopWatching();
  assert.equal(await readFile(configPath, "utf8"), configYaml());
});
