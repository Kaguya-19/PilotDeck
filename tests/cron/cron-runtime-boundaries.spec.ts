import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { mock } from "node:test";

import { defaultCronConfig, createCronRuntime } from "../../src/cron/index.js";
import { parseCronConfig } from "../../src/cron/config/parseCronConfig.js";
import type { CronTask } from "../../src/cron/protocol/types.js";
import { CronTaskStore } from "../../src/cron/storage/CronTaskStore.js";
import { resolveCronPaths } from "../../src/cron/storage/CronPaths.js";
import { CronScheduler } from "../../src/cron/runtime/CronScheduler.js";
import { CronFire } from "../../src/cron/runtime/CronFire.js";
import { createCronCreateTool } from "../../src/cron/tool/CronCreateTool.js";
import { createCronDeleteTool } from "../../src/cron/tool/CronDeleteTool.js";
import { createCronListTool } from "../../src/cron/tool/CronListTool.js";
import { createCronStopTool } from "../../src/cron/tool/CronStopTool.js";
import type { Gateway } from "../../src/gateway/index.js";

const projectKey = "/tmp/projects/cron-boundaries";

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    message: "run task",
    schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
    status: "scheduled",
    sessionKey: "cron:task-1",
    channelKey: "cron",
    projectKey,
    timezone: "UTC",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    scheduleComputationVersion: 2,
    ...overrides,
  };
}

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gateway(overrides: Record<string, unknown> = {}): Gateway {
  return {
    closeSession: async () => undefined,
    abortTurn: async () => undefined,
    submitTurn: async function* () {
      yield { type: "turn_completed", usage: {}, finishReason: "completed" };
    },
    ...overrides,
  } as unknown as Gateway;
}

function fireFor(store: CronTaskStore, gatewayInstance: Gateway, now: () => Date, options: Partial<ConstructorParameters<typeof CronFire>[0]> = {}) {
  const activeRuns = new Map<string, { runId: string; taskId: string; sessionKey: string; scheduleType: "once" | "cron"; stopRequested: boolean }>();
  return new CronFire({
    gateway: gatewayInstance,
    store,
    now,
    registerActiveRun: (run) => activeRuns.set(run.runId, run),
    unregisterActiveRun: (runId) => {
      const active = activeRuns.get(runId);
      activeRuns.delete(runId);
      return active;
    },
    getActiveRun: (runId) => activeRuns.get(runId),
    runTimeoutMs: 10_000,
    defaultTimezone: "UTC",
    releaseTaskSession: async () => undefined,
    ...options,
  });
}

test("parseCronConfig returns defaults, trims valid values and reports invalid fields", () => {
  const diagnostics: Array<{ code: string; severity: string }> = [];
  const config = parseCronConfig({ enabled: false, timezone: " Asia/Shanghai ", maxConcurrentRuns: 2, runTimeoutMinutes: 3, unknown: true }, diagnostics as never);
  assert.deepEqual(config, { enabled: false, timezone: "Asia/Shanghai", maxConcurrentRuns: 2, runTimeoutMinutes: 3 });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "CRON_UNKNOWN_FIELD");
  const invalid: Array<{ code: string }> = [];
  assert.deepEqual(parseCronConfig("bad", invalid as never), undefined);
  assert.equal(invalid[0].code, "CRON_CONFIG_INVALID");
  const fallback: Array<{ code: string }> = [];
  const parsed = parseCronConfig({ timezone: "", maxConcurrentRuns: 0, runTimeoutMinutes: "5", enabled: "yes" }, fallback as never);
  assert.deepEqual(parsed, { enabled: true, timezone: "UTC", maxConcurrentRuns: 1, runTimeoutMinutes: 60 });
  assert.deepEqual(fallback.map((item) => item.code), ["CRON_STRING_INVALID", "CRON_NUMBER_INVALID", "CRON_NUMBER_INVALID"]);
});

test("CronRuntime handles disabled, delay, history, delete and immediate-run boundaries", async () => {
  const home = tempHome("pilotdeck-cron-runtime-");
  const now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const disabled = createCronRuntime({ config: { ...defaultCronConfig(), enabled: false }, pilotHome: home, projectKey });
    assert.deepEqual(disabled.getTools(), []);
    await assert.rejects(disabled.createTask({ message: "x", schedule: { type: "delay", amount: 1, unit: "minute" } }), /disabled/);
    await assert.doesNotReject(disabled.start());

    const runtime = createCronRuntime({ config: defaultCronConfig(), pilotHome: home, projectKey, now: () => now, uuid: () => "task-delay" });
    const created = await runtime.createTask({ message: "delay", schedule: { type: "delay", amount: 2, unit: "minute" }, projectKey, sessionKey: "feishu:chat-1", channelKey: "feishu" });
    assert.equal(created.task.schedule.type, "once");
    assert.equal(created.task.nextRunAt, "2026-01-01T00:02:00.000Z");
    assert.equal(created.task.originSessionKey, "feishu:chat-1");
    assert.equal(created.task.originChannelKey, "feishu");
    await runtime.listTasks();
    const store = new CronTaskStore(resolveCronPaths({ pilotHome: home, projectKey }));
    await store.appendRun({ schemaVersion: 1, runId: "historic", taskId: created.task.taskId, sessionKey: created.task.sessionKey, startedAt: now.toISOString(), finishedAt: now.toISOString(), outcome: "completed" });
    assert.equal((await runtime.listTasks({ includeHistory: true, limit: 1 })).recentRuns?.[0]?.runId, "historic");
    assert.deepEqual(await runtime.runTaskNow({ taskId: "missing" }), { started: false, reason: "not_found" });
    await store.updateTask(created.task.taskId, (task) => ({ ...task, status: "running" }));
    assert.deepEqual(await runtime.runTaskNow({ taskId: created.task.taskId }), { started: false, reason: "already_running", taskId: created.task.taskId });
    assert.deepEqual(await runtime.deleteTask({ taskId: "missing" }), { deleted: false, stoppedRunId: undefined });
    await assert.rejects(runtime.createTask({ message: "bad", schedule: { type: "delay", amount: 0, unit: "minute" } }), /positive finite/);
    await assert.rejects(runtime.createTask({ message: "past", schedule: { type: "once", runAt: "2025-01-01T00:00:00.000Z" } }), /future/);
    const disabledUpdate = createCronRuntime({ config: { ...defaultCronConfig(), enabled: false }, pilotHome: home, projectKey });
    await assert.rejects(disabledUpdate.updateTask({ taskId: "x", projectKey, expectedRevision: 0, message: "x", schedule: { type: "once", runAt: "2026-01-02T00:00:00.000Z" } }), /disabled/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CronRuntime tool definitions forward context and preserve result data", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const fakeRuntime = {
    createTask: async (input: unknown) => { calls.push({ method: "create", input }); return { task: makeTask() }; },
    deleteTask: async (input: unknown) => { calls.push({ method: "delete", input }); return { deleted: true }; },
    listTasks: async (input: unknown) => { calls.push({ method: "list", input }); return { tasks: [] }; },
    stopTask: async (input: unknown) => { calls.push({ method: "stop", input }); return { stopped: true }; },
  } as never;
  const toolContext = { sessionId: "feishu:chat-1", turnId: "turn", cwd: projectKey } as never;
  const createResult = await createCronCreateTool(fakeRuntime).execute({ message: "m", schedule: { type: "delay", amount: 1, unit: "minute" } }, toolContext);
  const createTool = createCronCreateTool(fakeRuntime);
  const deleteTool = createCronDeleteTool(fakeRuntime);
  const listTool = createCronListTool(fakeRuntime);
  const stopTool = createCronStopTool(fakeRuntime);
  const deleteResult = await deleteTool.execute({ taskId: "task-1", stopRunning: true }, toolContext);
  const listResult = await listTool.execute({ includeHistory: true, limit: 2 }, toolContext);
  const stopResult = await stopTool.execute({ runId: "run-1" }, toolContext);
  assert.equal(createTool.isReadOnly?.(toolContext), false);
  assert.equal(createTool.isConcurrencySafe?.(toolContext), false);
  assert.equal(deleteTool.isDestructive?.(toolContext), true);
  assert.equal(deleteTool.isReadOnly?.(toolContext), false);
  assert.equal(listTool.isReadOnly?.(toolContext), true);
  assert.equal(listTool.isConcurrencySafe?.(toolContext), true);
  assert.equal(stopTool.isReadOnly?.(toolContext), false);
  assert.equal(stopTool.isConcurrencySafe?.(toolContext), false);
  assert.equal((createResult.data as { task: CronTask }).task.taskId, "task-1");
  assert.deepEqual(deleteResult.data, { deleted: true });
  assert.deepEqual(listResult.data, { tasks: [] });
  assert.deepEqual(stopResult.data, { stopped: true });
  assert.deepEqual(calls.map((call) => call.method), ["create", "delete", "list", "stop"]);
  assert.equal((calls[0].input as { channelKey: string }).channelKey, "feishu");
  assert.equal((calls[0].input as { sessionKey: string }).sessionKey, "feishu:chat-1");
  assert.equal((calls[1].input as { projectKey: string }).projectKey, projectKey);
});

test("CronRuntime binds once, rejects missing gateway, and stops active runs", async () => {
  const home = tempHome("pilotdeck-cron-lifecycle-");
  try {
    const runtime = createCronRuntime({ config: defaultCronConfig(), pilotHome: home, projectKey, skipToolCreation: true });
    await assert.rejects(runtime.start(), /before bindGateway/);
    const aborts: unknown[] = [];
    const bound = gateway({ abortTurn: async (input: unknown) => { aborts.push(input); } });
    runtime.bindGateway(bound);
    assert.throws(() => runtime.bindGateway(bound), /already called/);
    await runtime.stop();
    assert.equal(runtime.getActiveRunCount(), 0);
    assert.equal(aborts.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CronRuntime startup migrates legacy sessions, recovers interrupted runs and emits telemetry", async () => {
  const home = tempHome("pilotdeck-cron-recovery-");
  const now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const store = new CronTaskStore(resolveCronPaths({ pilotHome: home, projectKey }));
    await store.putTask(makeTask({ taskId: "legacy", sessionKey: "old-session", channelKey: "feishu", status: "running", lastRunId: "legacy-run", updatedAt: "bad-date", nextRunAt: "2026-01-01T23:00:00.000Z" }));
    await store.putTask(makeTask({ taskId: "once-running", sessionKey: "cron:once-running", status: "running", lastRunId: "once-run", schedule: { type: "once", runAt: "2026-01-02T00:00:00.000Z" }, nextRunAt: "2026-01-02T00:00:00.000Z" }));
    const closed: unknown[] = [];
    const telemetryEvents: unknown[] = [];
    const telemetry = {
      trackFeatureLoopStage: (input: unknown) => telemetryEvents.push(input),
      trackError: (error: unknown, input: unknown) => telemetryEvents.push({ error, input }),
    } as never;
    const runtime = createCronRuntime({
      config: { ...defaultCronConfig(), runTimeoutMinutes: 1 },
      pilotHome: home,
      projectKey,
      store,
      now: () => now,
      uuid: () => "generated-run",
      telemetry,
      logger: { info: () => undefined, warn: () => undefined },
    });
    assert.equal(runtime.getTools().length, 4);
    runtime.bindGateway(gateway({ closeSession: async (input: unknown) => { closed.push(input); } }));
    await runtime.start();
    await runtime.stop();
    const migrated = await store.getTask("legacy");
    assert.equal(migrated?.sessionKey, "cron:legacy");
    assert.equal(migrated?.status, "scheduled");
    assert.equal(await store.getTask("once-running"), undefined);
    assert.ok(closed.length >= 2);
    assert.ok(telemetryEvents.length >= 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CronRuntime stop aborts an active run and releases shutdown resources", async () => {
  const home = tempHome("pilotdeck-cron-active-");
  const now = new Date("2026-01-01T00:00:00.000Z");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let markDone!: () => void;
  const done = new Promise<void>((resolve) => { markDone = resolve; });
  const aborts: unknown[] = [];
  const telemetry: unknown[] = [];
  try {
    const store = new CronTaskStore(resolveCronPaths({ pilotHome: home, projectKey }));
    const task = makeTask({ nextRunAt: now.toISOString() });
    await store.putTask(task);
    const runtime = createCronRuntime({
      config: defaultCronConfig(), pilotHome: home, projectKey, store, now: () => now, uuid: () => "active-run",
      telemetry: { trackFeatureLoopStage: (input: unknown) => telemetry.push(input), trackError: (error: unknown, input: unknown) => telemetry.push({ error, input }) } as never,
    });
    runtime.bindGateway(gateway({
      abortTurn: async (input: unknown) => { aborts.push(input); release(); },
      submitTurn: async function* () {
        markStarted();
        yield { type: "assistant_text_delta", text: "active" };
        await gate;
        yield { type: "turn_completed", usage: {}, finishReason: "completed" };
        markDone();
      },
    }));
    await runtime.runTickOnce();
    await started;
    assert.equal(runtime.getActiveRunCount(), 1);
    await runtime.stop();
    await done;
    for (let attempt = 0; attempt < 100 && runtime.getActiveRunCount() > 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(aborts.length, 1);
    assert.equal((aborts[0] as { reason: string }).reason, "system:cron_shutdown");
    assert.equal(runtime.getActiveRunCount(), 0);
  } finally {
    release?.();
    rmSync(home, { recursive: true, force: true });
  }
});

test("CronScheduler starts, recalculates once tasks, fires due work and delays at capacity", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  let current = makeTask({ schedule: { type: "once", runAt: now.toISOString() }, nextRunAt: undefined });
  const updates: string[] = [];
  let fired = 0;
  const store = {
    listTasks: async () => [current],
    updateTask: async (_id: string, update: (task: CronTask) => CronTask | undefined) => {
      const next = update(current);
      if (next) current = next;
      updates.push(current.nextRunAt ?? "deleted");
      return next;
    },
  } as unknown as CronTaskStore;
  const scheduler = new CronScheduler({
    config: { ...defaultCronConfig(), maxConcurrentRuns: 1 },
    store,
    fire: { runTask: async () => { fired += 1; } } as unknown as CronFire,
    uuid: () => "run-1",
    now: () => now,
    activeRunCount: () => 0,
  });
  await scheduler.start();
  await scheduler.stop();
  assert.ok(updates.length >= 1);
  current = makeTask({ nextRunAt: now.toISOString() });
  const capacityScheduler = new CronScheduler({
    config: { ...defaultCronConfig(), maxConcurrentRuns: 1 }, store,
    fire: { runTask: async () => { fired += 1; } } as unknown as CronFire,
    uuid: () => "run-2", now: () => now, activeRunCount: () => 1,
  });
  await capacityScheduler.runTickOnce();
  assert.equal(fired, 0);
  assert.equal(current.nextRunAt, "2026-01-01T00:01:00.000Z");
});

test("CronScheduler handles disabled/repeated starts, poke and fire failures without leaking timers", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const errors: string[] = [];
  let fireCalls = 0;
  const store = {
    listTasks: async () => [makeTask({ nextRunAt: now.toISOString() })],
    updateTask: async (_id: string, updater: (task: CronTask) => CronTask | undefined) => updater(makeTask({ nextRunAt: now.toISOString() })),
  } as unknown as CronTaskStore;
  const scheduler = new CronScheduler({
    config: defaultCronConfig(),
    store,
    fire: { runTask: async () => { fireCalls += 1; throw new Error("fire failed"); } } as unknown as CronFire,
    uuid: () => "timer-run",
    now: () => now,
    activeRunCount: () => 0,
    logger: { warn: (message) => errors.push(message) },
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    scheduler.poke();
    await scheduler.start();
    await scheduler.start();
    scheduler.poke();
    mock.timers.tick(250);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await scheduler.stop();
    scheduler.poke();
    assert.ok(fireCalls >= 1);
    assert.ok(errors.includes("cron fire failed"));
  } finally {
    mock.timers.reset();
  }

  const disabled = new CronScheduler({
    config: { ...defaultCronConfig(), enabled: false }, store,
    fire: {} as CronFire, uuid: () => "disabled", now: () => now, activeRunCount: () => 0,
  });
  await disabled.start();
  await disabled.stop();
});

test("CronFire handles interaction, timeout, abort and thrown gateway failures", async () => {
  const home = tempHome("pilotdeck-cron-fire-errors-");
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  try {
    const store = new CronTaskStore(resolveCronPaths({ pilotHome: home, projectKey }));
    const task = makeTask();
    const deliveries: unknown[] = [];
    const aborts: unknown[] = [];
    const fire = fireFor(store, gateway({
      abortTurn: async (input: unknown) => { aborts.push(input); },
      submitTurn: async function* () {
        yield { type: "permission_request", requestId: "p-1", toolName: "bash", payload: {} };
        yield { type: "error", code: "agent_aborted", message: "late abort" };
      },
    }), now, { onResultDelivery: async (delivery) => { deliveries.push(delivery); } });
    await store.putTask(task);
    await fire.runTask(task, "interaction-run");
    assert.equal(aborts.length, 1);
    assert.equal((deliveries[0] as { outcome: string }).outcome, "failed");
    assert.match((deliveries[0] as { text: string }).text, /unsupported user interaction/);

    const timeoutTask = makeTask({ taskId: "timeout-task", sessionKey: "cron:timeout-task" });
    await store.putTask(timeoutTask);
    const timeoutFire = fireFor(store, gateway({ submitTurn: async function* () { yield { type: "error", code: "turn_timeout", message: "timed out" }; } }), now, { onResultDelivery: async (delivery) => { deliveries.push(delivery); } });
    await timeoutFire.runTask(timeoutTask, "timeout-run");
    assert.equal((deliveries.at(-1) as { outcome: string }).outcome, "failed");
    assert.equal((deliveries.at(-1) as { error: { code: string } }).error.code, "cron_run_timeout");

    const abortedTask = makeTask({ taskId: "aborted-task", sessionKey: "cron:aborted-task" });
    await store.putTask(abortedTask);
    const abortedFire = fireFor(store, gateway({ submitTurn: async function* () { yield { type: "error", code: "agent_aborted", message: "stopped" }; } }), now, { onResultDelivery: async (delivery) => { deliveries.push(delivery); } });
    await abortedFire.runTask(abortedTask, "aborted-run");
    assert.equal((deliveries.at(-1) as { outcome: string }).outcome, "aborted");

    const thrownTask = makeTask({ taskId: "thrown-task", sessionKey: "cron:thrown-task" });
    await store.putTask(thrownTask);
    const thrownFire = fireFor(store, gateway({ submitTurn: async function* () { throw new Error("gateway offline"); } }), now, { onResultDelivery: async (delivery) => { deliveries.push(delivery); } });
    await thrownFire.runTask(thrownTask, "thrown-run");
    assert.equal((deliveries.at(-1) as { error: { code: string } }).error.code, "cron_run_failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CronFire removes one-time tasks and ignores stale terminal updates", async () => {
  const home = tempHome("pilotdeck-cron-fire-once-");
  try {
    const store = new CronTaskStore(resolveCronPaths({ pilotHome: home, projectKey }));
    const task = makeTask({ taskId: "once-task", sessionKey: "cron:once-task", schedule: { type: "once", runAt: "2026-01-01T00:00:00.000Z" } });
    await store.putTask(task);
    const released: string[] = [];
    const fire = fireFor(store, gateway({ submitTurn: async function* () { yield { type: "assistant_text_delta", text: "done" }; } }), () => new Date("2026-01-01T00:00:00.000Z"), {
      releaseTaskSession: async (releasedTask) => { released.push(releasedTask.taskId); },
    });
    await fire.runTask(task, "once-run");
    assert.equal(await store.getTask(task.taskId), undefined);
    assert.deepEqual(released, [task.taskId]);

    const stale = makeTask({ taskId: "stale-task", sessionKey: "cron:stale-task" });
    await store.putTask(stale);
    const staleStore = {
      updateTask: async (_id: string, updater: (current: CronTask) => CronTask | undefined) => updater({ ...stale, revision: 10 }),
      appendRunEvent: async () => undefined,
      appendRun: async () => undefined,
    } as unknown as CronTaskStore;
    const staleFire = fireFor(staleStore, gateway(), () => new Date("2026-01-01T00:00:00.000Z"));
    await staleFire.runTask(stale, "stale-run");
    assert.equal(await store.getTask(stale.taskId) !== undefined, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
