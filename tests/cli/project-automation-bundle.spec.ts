import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultAlwaysOnConfig,
  type AlwaysOnControlPort,
  type AlwaysOnProjectStorageProvider,
} from "../../src/always-on/index.js";
import {
  defaultCronConfig,
  type CronControlPort,
  type CronProjectStorageProvider,
} from "../../src/cron/index.js";
import {
  ProjectAutomationBundle,
  type ProjectAutomationAgentGateway,
  type ProjectAutomationAlwaysOnProvider,
  type ProjectAutomationCronProvider,
} from "../../src/cli/ProjectAutomationBundle.js";
import type { SubsystemUpdate } from "../../src/cli/createLocalGateway.js";
import type { SessionCatalogPort } from "../../src/session/catalog/SessionCatalogPort.js";
import type { SessionTranscriptReaderPort } from "../../src/session/history/SessionTranscriptReaderPort.js";
import {
  InMemorySessionPersistence,
  InMemorySessionProjectionCheckpointStore,
  type ProjectSessionStorageProvider,
} from "../../src/session/index.js";
import type { PilotDeckToolDefinition } from "../../src/tool/index.js";

function enabledAlwaysOnConfig() {
  const config = defaultAlwaysOnConfig();
  config.projects = { "/workspace/project": { enabled: true } };
  return config;
}

function tool(name: string): PilotDeckToolDefinition {
  return {
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      return { content: [] };
    },
  };
}

function fakeAgentGateway(): ProjectAutomationAgentGateway {
  return {
    async *submitTurn() {},
    async abortTurn() {},
    async closeSession() {},
  };
}

function fallbackControl(): AlwaysOnControlPort {
  return {
    async applyCycle() {
      return { sessionKey: "fallback" };
    },
    async abortRun(input) {
      return { aborted: false, sessionKey: input.sessionKey };
    },
    async rerunPlan() {
      return { runId: "fallback" };
    },
  };
}

function fakeAlwaysOn(
  name: string,
  events: string[],
  options: { failStart?: boolean } = {},
): ProjectAutomationAlwaysOnProvider {
  return {
    getTools: () => [tool(`${name}-tool`)],
    bindAgentGateway() {
      events.push(`${name}:bind`);
    },
    async start() {
      events.push(`${name}:start`);
      if (options.failStart) throw new Error(`${name}:start failed`);
    },
    async stop() {
      events.push(`${name}:stop`);
    },
    async applyCycle() {
      return { sessionKey: name };
    },
    async abortRun(input) {
      return { aborted: false, sessionKey: input.sessionKey };
    },
    async rerunPlan() {
      return { runId: name };
    },
  };
}

function fakeCron(
  name: string,
  events: string[],
  options: { failStart?: boolean } = {},
): ProjectAutomationCronProvider {
  const control: CronControlPort = {
    async createTask() { return { task: { taskId: name } as never }; },
    async listTasks() { return { tasks: [] }; },
    async updateTask() { return { updated: false, reason: "not_found" }; },
    async deleteTask() { return { deleted: false }; },
    async stopTask(input) { return { stopped: false, taskId: input.taskId, runId: input.runId }; },
    async runTaskNow(input) { return { started: false, taskId: input.taskId, reason: "not_found" }; },
  };
  return {
    ...control,
    getTools: () => [tool(`${name}-tool`)],
    bindAgentGateway() {
      events.push(`${name}:bind`);
    },
    async start() {
      events.push(`${name}:start`);
      if (options.failStart) throw new Error(`${name}:start failed`);
    },
    async stop() {
      events.push(`${name}:stop`);
    },
  };
}

function attach(bundle: ProjectAutomationBundle, updates: SubsystemUpdate[]): void {
  bundle.attach({
    agentGateway: fakeAgentGateway(),
    isProjectBusy: () => false,
    updateSubsystems: (update) => updates.push(update),
  });
}

test("empty automation bundle publishes only fallback control and stops idempotently", async () => {
  const updates: SubsystemUpdate[] = [];
  const bundle = new ProjectAutomationBundle({
    config: {},
    pilotHome: "/tmp/pilotdeck-automation-empty",
    createStandaloneAlwaysOnControl: fallbackControl,
  });

  assert.deepEqual(bundle.getInitialGatewayOptions().extraTools, []);
  assert.equal(bundle.getInitialGatewayOptions().cron, undefined);
  attach(bundle, updates);

  assert.deepEqual(await bundle.start(), { alwaysOn: false, cron: false });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].cron, undefined);
  assert.ok(updates[0].alwaysOnControl);

  await bundle.stop();
  await bundle.stop();
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1], {
    extraTools: [],
    sessionOverrides: bundle.getInitialGatewayOptions().sessionOverrides,
    cron: undefined,
    alwaysOnControl: undefined,
  });
});

test("automation bundle passes its selected session catalog to the Always-On provider", () => {
  const catalog: SessionCatalogPort = { async list() { return []; } };
  let received: SessionCatalogPort | undefined;
  const bundle = new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig() },
    pilotHome: "/tmp/pilotdeck-automation-catalog",
    sessionCatalog: catalog,
    createAlwaysOnManager: (options) => {
      received = options.sessionCatalog;
      return fakeAlwaysOn("always", []);
    },
    createStandaloneAlwaysOnControl: fallbackControl,
  });

  assert.equal(received, catalog);
  assert.deepEqual(bundle.getInitialGatewayOptions().extraTools.map((definition) => definition.name), ["always-tool"]);
});

test("automation bundle passes its selected Always-On storage provider to the manager", () => {
  const storageProvider: AlwaysOnProjectStorageProvider = {
    create() {
      throw new Error("factory stub must not be invoked while staging a fake manager");
    },
  };
  let received: AlwaysOnProjectStorageProvider | undefined;
  new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig() },
    pilotHome: "/tmp/pilotdeck-automation-always-on-storage",
    alwaysOnStorageProvider: storageProvider,
    createAlwaysOnManager: (options) => {
      received = options.alwaysOnStorageProvider;
      return fakeAlwaysOn("always", []);
    },
    createStandaloneAlwaysOnControl: fallbackControl,
  });

  assert.equal(received, storageProvider);
});

test("automation bundle passes its selected Always-On storage provider to standalone apply", async () => {
  const storageProvider: AlwaysOnProjectStorageProvider = {
    create() {
      throw new Error("factory stub must not be invoked while staging the fallback control");
    },
  };
  let received: AlwaysOnProjectStorageProvider | undefined;
  const bundle = new ProjectAutomationBundle({
    config: {},
    pilotHome: "/tmp/pilotdeck-automation-standalone-storage",
    alwaysOnStorageProvider: storageProvider,
    createStandaloneAlwaysOnControl: (deps) => {
      received = deps.alwaysOnStorageProvider;
      return fallbackControl();
    },
  });

  const updates: SubsystemUpdate[] = [];
  attach(bundle, updates);
  await bundle.start();
  assert.ok(updates[0]?.alwaysOnControl);
  assert.equal(received, storageProvider);
});

test("automation bundle passes its selected Cron storage provider to the manager", () => {
  const storageProvider = {} as CronProjectStorageProvider;
  let received: CronProjectStorageProvider | undefined;
  new ProjectAutomationBundle({
    config: { cron: defaultCronConfig() },
    pilotHome: "/tmp/pilotdeck-automation-cron-storage",
    cronStorageProvider: storageProvider,
    createCronManager: (options) => {
      received = options.cronStorageProvider;
      return fakeCron("cron", []);
    },
    createStandaloneAlwaysOnControl: fallbackControl,
  });

  assert.equal(received, storageProvider);
});

test("automation bundle selects the catalog from its storage provider", async () => {
  const calls: unknown[] = [];
  const catalog: SessionCatalogPort = {
    async list(input) {
      calls.push(input);
      return [];
    },
  };
  const storageProvider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence: new InMemorySessionPersistence(),
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
    catalog,
  };
  let receivedCatalog: SessionCatalogPort | undefined;
  let receivedReader: SessionTranscriptReaderPort | undefined;
  new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig() },
    pilotHome: "/tmp/pilotdeck-automation-provider-catalog",
    storageProvider,
    createAlwaysOnManager: (options) => {
      receivedCatalog = options.sessionCatalog;
      receivedReader = options.sessionTranscriptReader;
      return fakeAlwaysOn("always", []);
    },
    createStandaloneAlwaysOnControl: fallbackControl,
  });

  assert.equal(receivedCatalog, catalog);
  assert.ok(receivedReader);
  await receivedCatalog.list({ projectRoot: "/virtual/project", pilotHome: "/virtual/home" });
  assert.deepEqual(calls, [{ projectRoot: "/virtual/project", pilotHome: "/virtual/home" }]);
});

test("automation bundle passes its selected transcript reader to the Always-On provider and fallback control", async () => {
  const reader: SessionTranscriptReaderPort = {
    async read() { return { entries: [], diagnostics: [] }; },
    async readUserPromptDigest() { return { prompts: [] }; },
  };
  let managerReader: SessionTranscriptReaderPort | undefined;
  let fallbackReader: SessionTranscriptReaderPort | undefined;
  const bundle = new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig() },
    pilotHome: "/tmp/pilotdeck-automation-transcript-reader",
    sessionTranscriptReader: reader,
    createAlwaysOnManager: (options) => {
      managerReader = options.sessionTranscriptReader;
      return fakeAlwaysOn("always", []);
    },
    createStandaloneAlwaysOnControl: (deps) => {
      fallbackReader = deps.sessionTranscriptReader;
      return fallbackControl();
    },
  });

  assert.equal(managerReader, reader);

  const fallback = new ProjectAutomationBundle({
    config: {},
    pilotHome: "/tmp/pilotdeck-automation-transcript-reader-fallback",
    sessionTranscriptReader: reader,
    createStandaloneAlwaysOnControl: (deps) => {
      fallbackReader = deps.sessionTranscriptReader;
      return fallbackControl();
    },
  });
  const updates: SubsystemUpdate[] = [];
  attach(fallback, updates);
  await fallback.start();
  assert.equal(fallbackReader, reader);
  await fallback.stop();
  await bundle.stop();
});

test("automation bundle passes its selected catalog to standalone Always-On control", async () => {
  const catalog: SessionCatalogPort = { async list() { return []; } };
  let received: SessionCatalogPort | undefined;
  const bundle = new ProjectAutomationBundle({
    config: {},
    pilotHome: "/tmp/pilotdeck-automation-standalone-catalog",
    sessionCatalog: catalog,
    createStandaloneAlwaysOnControl: (deps) => {
      received = deps.sessionCatalog;
      return fallbackControl();
    },
  });
  const updates: SubsystemUpdate[] = [];
  attach(bundle, updates);

  await bundle.start();

  assert.equal(received, catalog);
  await bundle.stop();
});

test("bundle binds narrow facades, starts in order, and stops in reverse order", async () => {
  const events: string[] = [];
  const updates: SubsystemUpdate[] = [];
  const alwaysOn = fakeAlwaysOn("always", events);
  const cron = fakeCron("cron", events);
  const bundle = new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig(), cron: defaultCronConfig() },
    pilotHome: "/tmp/pilotdeck-automation-order",
    createAlwaysOnManager: () => alwaysOn,
    createCronManager: () => cron,
    createStandaloneAlwaysOnControl: fallbackControl,
  });

  const initial = bundle.getInitialGatewayOptions();
  assert.deepEqual(initial.extraTools.map((definition) => definition.name), ["always-tool", "cron-tool"]);
  assert.equal(initial.cron, cron);
  attach(bundle, updates);

  assert.deepEqual(await bundle.start(), { alwaysOn: true, cron: true });
  assert.deepEqual(events, ["always:bind", "cron:bind", "always:start", "cron:start"]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].alwaysOnControl, alwaysOn);
  assert.equal(updates[0].cron, cron);

  await bundle.stop();
  assert.deepEqual(events, [
    "always:bind", "cron:bind", "always:start", "cron:start",
    "cron:stop", "always:stop",
  ]);
  assert.equal(updates.at(-1)?.alwaysOnControl, undefined);
  assert.equal(updates.at(-1)?.cron, undefined);
});

test("startup failure cleans partial providers in reverse order without publishing them", async () => {
  const events: string[] = [];
  const updates: SubsystemUpdate[] = [];
  const bundle = new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig(), cron: defaultCronConfig() },
    pilotHome: "/tmp/pilotdeck-automation-start-failure",
    createAlwaysOnManager: () => fakeAlwaysOn("always", events),
    createCronManager: () => fakeCron("cron", events, { failStart: true }),
    createStandaloneAlwaysOnControl: fallbackControl,
  });
  attach(bundle, updates);

  await assert.rejects(bundle.start(), /Project automation startup failed/);
  assert.deepEqual(events, [
    "always:bind", "cron:bind", "always:start", "cron:start",
    "cron:stop", "always:stop",
  ]);
  assert.deepEqual(updates, []);
});

test("reload build failure leaves the published generation running", async () => {
  const events: string[] = [];
  const updates: SubsystemUpdate[] = [];
  const oldAlwaysOn = fakeAlwaysOn("old", events);
  let factoryCalls = 0;
  const bundle = new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig() },
    pilotHome: "/tmp/pilotdeck-automation-build-failure",
    createAlwaysOnManager: () => {
      factoryCalls += 1;
      if (factoryCalls === 2) throw new Error("invalid replacement config");
      return oldAlwaysOn;
    },
    createStandaloneAlwaysOnControl: fallbackControl,
  });
  attach(bundle, updates);
  await bundle.start();

  await assert.rejects(
    bundle.reload({ config: { alwaysOn: enabledAlwaysOnConfig() }, alwaysOnChanged: true, cronChanged: false }),
    /invalid replacement config/,
  );
  assert.deepEqual(events, ["old:bind", "old:start"]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].alwaysOnControl, oldAlwaysOn);
});

test("reload replaces only the changed Cron provider family", async () => {
  const events: string[] = [];
  const updates: SubsystemUpdate[] = [];
  const alwaysOn = fakeAlwaysOn("always", events);
  const initialCron = fakeCron("cron-old", events);
  const replacementCron = fakeCron("cron-new", events);
  let cronFactoryCalls = 0;
  const bundle = new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig(), cron: defaultCronConfig() },
    pilotHome: "/tmp/pilotdeck-automation-selective-reload",
    createAlwaysOnManager: () => alwaysOn,
    createCronManager: () => {
      cronFactoryCalls += 1;
      return cronFactoryCalls === 1 ? initialCron : replacementCron;
    },
    createStandaloneAlwaysOnControl: fallbackControl,
  });
  attach(bundle, updates);
  await bundle.start();

  assert.deepEqual(
    await bundle.reload({
      config: { alwaysOn: enabledAlwaysOnConfig(), cron: { ...defaultCronConfig(), timezone: "Asia/Shanghai" } },
      alwaysOnChanged: false,
      cronChanged: true,
    }),
    { alwaysOn: true, cron: true },
  );
  assert.deepEqual(events, [
    "always:bind", "cron-old:bind", "always:start", "cron-old:start",
    "cron-old:stop", "cron-new:bind", "cron-new:start",
  ]);
  assert.equal(updates.at(-1)?.alwaysOnControl, alwaysOn);
  assert.equal(updates.at(-1)?.cron, replacementCron);
  assert.deepEqual(
    updates.at(-1)?.extraTools.map((definition) => definition.name),
    ["always-tool", "cron-new-tool"],
  );
});

test("reload start failure drains the candidate and restores the previous provider generation", async () => {
  const events: string[] = [];
  const updates: SubsystemUpdate[] = [];
  const initial = fakeAlwaysOn("initial", events);
  const failing = fakeAlwaysOn("candidate", events, { failStart: true });
  const restored = fakeAlwaysOn("restored", events);
  let factoryCalls = 0;
  const bundle = new ProjectAutomationBundle({
    config: { alwaysOn: enabledAlwaysOnConfig() },
    pilotHome: "/tmp/pilotdeck-automation-reload-restore",
    createAlwaysOnManager: () => {
      factoryCalls += 1;
      return [initial, failing, restored][factoryCalls - 1]!;
    },
    createStandaloneAlwaysOnControl: fallbackControl,
  });
  attach(bundle, updates);
  await bundle.start();

  await assert.rejects(
    bundle.reload({ config: { alwaysOn: enabledAlwaysOnConfig() }, alwaysOnChanged: true, cronChanged: false }),
    /Project automation reload failed; the previous generation was restored/,
  );
  assert.deepEqual(events, [
    "initial:bind", "initial:start", "initial:stop",
    "candidate:bind", "candidate:start", "candidate:stop",
    "restored:bind", "restored:start",
  ]);
  assert.equal(updates.at(-1)?.alwaysOnControl, restored);
  assert.deepEqual(updates.at(-1)?.extraTools.map((definition) => definition.name), ["restored-tool"]);
});
