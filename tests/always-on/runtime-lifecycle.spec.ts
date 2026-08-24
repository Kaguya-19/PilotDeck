import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { Gateway } from "../../src/gateway/index.js";
import { defaultAlwaysOnConfig } from "../../src/always-on/config/parseAlwaysOnConfig.js";
import { AlwaysOnManager, createAlwaysOnManager } from "../../src/always-on/runtime/AlwaysOnManager.js";
import { AlwaysOnRuntime, createAlwaysOnRuntime } from "../../src/always-on/runtime/AlwaysOnRuntime.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function configFor(projectKey: string) {
  const config = defaultAlwaysOnConfig();
  config.projects[projectKey] = { enabled: true };
  return config;
}

function fakeGateway(): Gateway {
  return {
    async *submitTurn() {},
    abortTurn: async () => undefined,
    listSessions: async () => ({ sessions: [] }),
    resumeSession: async ({ sessionKey }) => ({ sessionKey }),
    newSession: async ({ sessionKey }) => ({ sessionKey: sessionKey ?? "new" }),
    closeSession: async () => undefined,
    describeServer: async () => ({ mode: "in_process" }),
    cronCreate: async () => ({ ok: true } as never),
    cronList: async () => ({ tasks: [] } as never),
    cronUpdate: async () => ({ ok: true } as never),
    cronDelete: async () => ({ ok: true } as never),
    cronStop: async () => ({ ok: true } as never),
    cronRunNow: async () => ({ ok: true } as never),
    respondElicitation: async () => ({ delivered: false }),
    permissionDecide: async () => ({ delivered: false }),
    grantSessionPermission: async () => ({ granted: false }),
    readSessionMessages: async () => ({ messages: [] } as never),
    forkSession: async () => ({ sessionKey: "fork" } as never),
    readSubagentMessages: async () => ({ messages: [] } as never),
    listProjects: async () => ({ projects: [] } as never),
    describeProject: async () => ({}) as never,
  } as Gateway;
}

test("AlwaysOnRuntime exposes isolated tools and rejects lifecycle misuse", async (t) => {
  const root = await tempDir("pilotdeck-always-on-runtime-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const runtime = createAlwaysOnRuntime({
    config: configFor(project),
    pilotHome: join(root, "home"),
    projectKey: project,
    uuid: () => "runtime-run",
  });

  assert.ok(runtime instanceof AlwaysOnRuntime);
  assert.equal(runtime.getTools().length, 4);
  assert.notEqual(runtime.getTools(), runtime.getTools());
  assert.equal(runtime.getSessionOverrides().get("missing"), undefined);
  assert.deepEqual(runtime.getRunContexts().list(), []);
  assert.deepEqual(runtime.getChannelLeases().list(), []);
  assert.deepEqual(await runtime.rerunPlan({ planId: "missing" }), {
    runId: "",
    error: { code: "not_ready", message: "AlwaysOnRuntime.bindGateway not called" },
  });
  assert.deepEqual(await runtime.applyCycle({ workCycleId: "missing", projectRoot: project, projectName: "Project" }), {
    sessionKey: "",
    error: { code: "not_ready", message: "AlwaysOnRuntime.bindGateway not called" },
  });

  const gateway = fakeGateway();
  await runtime.start().catch((error: unknown) => assert.match(String(error), /before bindGateway/));
  runtime.bindGateway(gateway, { isSessionInFlight: () => false });
  assert.throws(() => runtime.bindGateway(gateway), /already called/);
  assert.deepEqual(await runtime.rerunPlan({ planId: "missing" }), {
    runId: "runtime-run",
    error: { code: "plan_not_found", message: "Plan missing not found" },
  });
  await runtime.start();
  await runtime.start();
  await runtime.stop();
  await runtime.stop();
  assert.deepEqual(runtime.getRunContexts().list(), []);
  assert.equal(runtime.getSessionOverrides().get("always-on/discovery:project=anything:run=anything"), undefined);
});

test("AlwaysOnRuntime disabled mode is a no-op and manager isolates projects", async (t) => {
  const root = await tempDir("pilotdeck-always-on-manager-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });

  const disabledConfig = configFor(first);
  disabledConfig.enabled = false;
  const disabled = createAlwaysOnRuntime({ config: disabledConfig, pilotHome: join(root, "home"), projectKey: first });
  await disabled.start();
  await disabled.stop();

  const config = configFor(first);
  config.projects[second] = { enabled: true };
  const manager = createAlwaysOnManager({ config, pilotHome: join(root, "manager-home"), uuid: () => "manager-run" });
  assert.ok(manager instanceof AlwaysOnManager);
  assert.equal(manager.getTools().length, 4);
  assert.deepEqual(await manager.rerunPlan({ projectKey: join(root, "unknown"), planId: "p" }), {
    runId: "",
    error: { code: "project_not_found", message: `No Always-On runtime for project ${join(root, "unknown")}` },
  });
  assert.deepEqual(await manager.applyCycle({ projectKey: join(root, "unknown"), workCycleId: "c", projectName: "Unknown" }), {
    sessionKey: "",
    error: { code: "project_not_found", message: `No Always-On runtime for project ${join(root, "unknown")}` },
  });
  manager.bindGateway(fakeGateway(), { isProjectBusy: () => false });
  await manager.start();
  await manager.stop();
  assert.equal(manager.getSessionOverrides().get("always-on/discovery:project=anything:run=anything"), undefined);
});
