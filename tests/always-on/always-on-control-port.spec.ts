import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAlwaysOnRuntime,
  createStandaloneAlwaysOnControl,
  defaultAlwaysOnConfig,
  DiscoveryFire,
  AlwaysOnRunContextRegistry,
  SessionConfigOverrides,
  type AlwaysOnAgentGatewayPort,
  type AlwaysOnProjectStorageProvider,
  resolveAlwaysOnPaths,
} from "../../src/always-on/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import type { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

function createFakeAgentGateway(): AlwaysOnAgentGatewayPort {
  return {
    async *submitTurn() {
      yield { type: "turn_started", runId: "fake-turn" };
    },
    async abortTurn() {},
    async closeSession() {},
  };
}

test("Gateway always-on RPCs consume one control port rather than retaining operation callbacks", async () => {
  const calls: string[] = [];
  const gateway = new InProcessGateway({} as SessionRouter, {
    alwaysOnControl: {
      async applyCycle(input) {
        calls.push(`apply:${input.workCycleId}`);
        return { sessionKey: `apply:${input.workCycleId}` };
      },
      async abortRun(input) {
        calls.push(`abort:${input.sessionKey}`);
        return { aborted: true, sessionKey: input.sessionKey };
      },
      async rerunPlan(input) {
        calls.push(`rerun:${input.planId}`);
        return { runId: `rerun:${input.planId}` };
      },
    },
  });

  assert.deepEqual(
    await gateway.alwaysOnApply({ projectKey: "/project", workCycleId: "cycle-1", projectName: "PilotDeck" }),
    { sessionKey: "apply:cycle-1" },
  );
  assert.deepEqual(
    await gateway.alwaysOnRerunPlan({ projectKey: "/project", planId: "plan-1", projectName: "PilotDeck" }),
    { runId: "rerun:plan-1" },
  );
  assert.deepEqual(
    await gateway.alwaysOnAbort({ projectKey: "/project", sessionKey: "always-on/execute:project=/project:run=run-1" }),
    { aborted: true, sessionKey: "always-on/execute:project=/project:run=run-1" },
  );
  assert.deepEqual(calls, ["apply:cycle-1", "rerun:plan-1", "abort:always-on/execute:project=/project:run=run-1"]);
});

test("Remote Gateway maps Always-On abort to the typed transport operation", async () => {
  const input = {
    projectKey: "/project",
    sessionKey: "always-on/execute:project=/project:run=run-1",
    reason: "operator_stop",
  };
  const expected = { aborted: true, sessionKey: input.sessionKey, runId: "run-1" };
  let method: string | undefined;
  let received: unknown;
  const gateway = new RemoteGateway({
    async request(nextMethod: string, nextInput: unknown) {
      method = nextMethod;
      received = nextInput;
      return expected;
    },
  } as unknown as GatewayWsClient);

  assert.deepEqual(await gateway.alwaysOnAbort(input), expected);
  assert.equal(method, "always_on_abort");
  assert.deepEqual(received, input);
});

test("native Always-On runtime binds only the narrow agent turn facade", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-port-"));
  const projectKey = join(root, "project");
  const runtime = createAlwaysOnRuntime({
    config: defaultAlwaysOnConfig(),
    pilotHome: join(root, "pilot-home"),
    projectKey,
    uuid: () => "run-1",
    now: () => new Date("2026-09-09T00:00:00.000Z"),
  });

  try {
    runtime.bindAgentGateway(createFakeAgentGateway());
    assert.deepEqual(
      await runtime.rerunPlan({ projectKey, planId: "missing-plan" }),
      {
        runId: "run-1",
        error: {
          code: "plan_not_found",
          message: "Plan missing-plan not found",
        },
      },
    );
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime stop drains an already-admitted control run and rejects later controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-drain-"));
  const projectKey = join(root, "project");
  const runtime = createAlwaysOnRuntime({
    config: defaultAlwaysOnConfig(),
    pilotHome: join(root, "pilot-home"),
    projectKey,
    uuid: () => "run-drain",
  });
  let begin!: () => void;
  let release!: () => void;
  const began = new Promise<void>((resolve) => { begin = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });

  try {
    runtime.bindAgentGateway(createFakeAgentGateway());
    (runtime as unknown as {
      fire: { rerunPlan: (input: { runId: string }) => Promise<{ runId: string; outcome: "no_plan" }> };
    }).fire = {
      async rerunPlan(input) {
        begin();
        await pending;
        return { runId: input.runId, outcome: "no_plan" };
      },
    };

    const rerun = runtime.rerunPlan({ projectKey, planId: "plan-drain" });
    await began;
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    assert.deepEqual(
      await runtime.rerunPlan({ projectKey, planId: "late-plan" }),
      { runId: "", error: { code: "not_ready", message: "AlwaysOnRuntime.bindGateway not called" } },
    );

    release();
    assert.deepEqual(await rerun, { runId: "run-drain", error: undefined });
    await stopping;
    assert.equal(stopped, true);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("one project runtime stop preserves shared registry entries owned by another project", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-project-owner-"));
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  const runContexts = new AlwaysOnRunContextRegistry();
  const sessionOverrides = new SessionConfigOverrides();
  const firstSessionKey = DiscoveryFire.deriveExecutionSessionKey(firstProject, "run-first");
  const secondSessionKey = DiscoveryFire.deriveExecutionSessionKey(secondProject, "run-second");
  const runtime = createAlwaysOnRuntime({
    config: defaultAlwaysOnConfig(),
    pilotHome: join(root, "pilot-home"),
    projectKey: firstProject,
    runContexts,
    sessionOverrides,
  });

  try {
    runContexts.register({ kind: "execution", sessionKey: firstSessionKey, runId: "run-first", projectKey: firstProject } as never);
    runContexts.register({ kind: "execution", sessionKey: secondSessionKey, runId: "run-second", projectKey: secondProject } as never);
    sessionOverrides.set(firstSessionKey, { cwd: firstProject });
    sessionOverrides.set(secondSessionKey, { cwd: secondProject });

    await runtime.stop();

    assert.equal(runContexts.get(firstSessionKey), undefined);
    assert.ok(runContexts.get(secondSessionKey));
    assert.equal(sessionOverrides.get(firstSessionKey), undefined);
    assert.deepEqual(sessionOverrides.get(secondSessionKey), { cwd: secondProject });
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime abort validates an active Always-On session and delegates only through the narrow turn facade", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-abort-"));
  const projectKey = join(root, "project");
  const runtime = createAlwaysOnRuntime({
    config: defaultAlwaysOnConfig(),
    pilotHome: join(root, "pilot-home"),
    projectKey,
    uuid: () => "run-abort",
  });
  const aborts: Array<{ sessionKey: string; runId?: string; reason?: string }> = [];
  let begin!: () => void;
  let release!: () => void;
  const began = new Promise<void>((resolve) => { begin = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });

  try {
    runtime.bindAgentGateway({
      async *submitTurn() {},
      async abortTurn(input) { aborts.push(input); },
      async closeSession() {},
    });
    (runtime as unknown as {
      fire: { rerunPlan: (input: { runId: string }) => Promise<{ runId: string; outcome: "no_plan" }> };
    }).fire = {
      async rerunPlan(input) {
        begin();
        await pending;
        return { runId: input.runId, outcome: "no_plan" };
      },
    };

    const rerun = runtime.rerunPlan({ projectKey, planId: "plan-abort" });
    await began;
    const sessionKey = DiscoveryFire.deriveExecutionSessionKey(projectKey, "run-abort");
    assert.deepEqual(
      await runtime.abortRun({ projectKey, sessionKey, reason: "operator_stop" }),
      { aborted: true, sessionKey, runId: "run-abort" },
    );
    assert.deepEqual(aborts, [{ sessionKey, runId: "run-abort", reason: "operator_stop" }]);

    release();
    await rerun;
    await Promise.resolve();
    assert.deepEqual(
      await runtime.abortRun({ projectKey, sessionKey }),
      {
        aborted: false,
        sessionKey,
        error: { code: "session_not_active", message: "No active Always-On run owns this session." },
      },
    );
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone control preserves apply while failing runtime-owned controls closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-standalone-"));
  const control = createStandaloneAlwaysOnControl({
    agentGateway: createFakeAgentGateway(),
    pilotHome: join(root, "pilot-home"),
    sessionOverrides: new SessionConfigOverrides(),
  });

  try {
    assert.deepEqual(
      await control.applyCycle({ projectKey: join(root, "project"), workCycleId: "missing-cycle", projectName: "PilotDeck" }),
      {
        sessionKey: "",
        error: {
          code: "cycle_not_found",
          message: "Work cycle missing-cycle not found",
        },
      },
    );
    assert.deepEqual(
      await control.rerunPlan({ projectKey: join(root, "project"), planId: "plan-1" }),
      {
        runId: "",
        error: {
          code: "not_configured",
          message: "Always-On plan rerun requires an enabled Always-On runtime.",
        },
      },
    );
    const sessionKey = "always-on/execute:project=/project:run=run-1";
    assert.deepEqual(
      await control.abortRun({ projectKey: join(root, "project"), sessionKey }),
      {
        aborted: false,
        sessionKey,
        error: {
          code: "not_configured",
          message: "Always-On abort requires an enabled Always-On runtime.",
        },
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime and standalone apply control consume the selected Always-On project storage provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-storage-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectKey = join(root, "project");
  const calls: Array<{ pilotHome: string; projectKey: string }> = [];
  const unexpectedStorageCall = async (): Promise<never> => {
    throw new Error("unexpected storage operation for missing cycle");
  };
  const storageProvider: AlwaysOnProjectStorageProvider = {
    create(input) {
      calls.push({ ...input });
      return {
        paths: resolveAlwaysOnPaths(input),
        stateStore: {
          read: unexpectedStorageCall,
          markFireStarted: unexpectedStorageCall,
          markFireCompleted: unexpectedStorageCall,
          setActiveWorkCycleId: unexpectedStorageCall,
          setDormant: unexpectedStorageCall,
          clearDormant: unexpectedStorageCall,
        },
        planStore: {
          readIndex: unexpectedStorageCall,
          writePlanMarkdown: unexpectedStorageCall,
          readPlanMarkdown: unexpectedStorageCall,
          upsert: unexpectedStorageCall,
          updateStatus: unexpectedStorageCall,
          getRecord: unexpectedStorageCall,
        },
        cycleStore: {
          async getRecord() {
            return undefined;
          },
          create: unexpectedStorageCall,
          addPlan: unexpectedStorageCall,
        },
        reportStore: {
          writeReport: unexpectedStorageCall,
          appendRunEvent: unexpectedStorageCall,
          appendHistory: unexpectedStorageCall,
        },
        eventStore: {
          appendEvent: unexpectedStorageCall,
        },
      };
    },
  };

  const runtime = createAlwaysOnRuntime({
    config: defaultAlwaysOnConfig(),
    pilotHome: join(root, "pilot-home"),
    projectKey,
    alwaysOnStorageProvider: storageProvider,
  });
  runtime.bindAgentGateway(createFakeAgentGateway());
  assert.deepEqual(
    await runtime.applyCycle({ projectKey, workCycleId: "missing-runtime-cycle", projectName: "PilotDeck" }),
    {
      sessionKey: "",
      error: {
        code: "cycle_not_found",
        message: "Work cycle missing-runtime-cycle not found",
      },
    },
  );

  const standalone = createStandaloneAlwaysOnControl({
    agentGateway: createFakeAgentGateway(),
    pilotHome: join(root, "pilot-home"),
    sessionOverrides: new SessionConfigOverrides(),
    alwaysOnStorageProvider: storageProvider,
  });
  assert.deepEqual(
    await standalone.applyCycle({ projectKey, workCycleId: "missing-standalone-cycle", projectName: "PilotDeck" }),
    {
      sessionKey: "",
      error: {
        code: "cycle_not_found",
        message: "Work cycle missing-standalone-cycle not found",
      },
    },
  );
  assert.deepEqual(calls, [
    { pilotHome: join(root, "pilot-home"), projectKey },
    { pilotHome: join(root, "pilot-home"), projectKey },
  ]);
  await runtime.stop();
});
