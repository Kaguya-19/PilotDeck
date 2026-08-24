import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { Gateway } from "../../src/gateway/index.js";
import { defaultCronConfig } from "../../src/cron/config/parseCronConfig.js";
import {
  createCronManager,
  type CronTask,
} from "../../src/cron/index.js";
import { cronRunEventsPath, resolveCronPaths } from "../../src/cron/storage/CronPaths.js";
import { migrateCronStores } from "../../src/cron/storage/CronStoreMigration.js";

const PROJECT_A = "/workspace/project-a";
const PROJECT_B = "/workspace/project-b";

function task(taskId: string, projectKey: string, overrides: Partial<CronTask> = {}): CronTask {
  return {
    schemaVersion: 1,
    taskId,
    message: `message-${taskId}`,
    schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
    status: "scheduled",
    sessionKey: `legacy:${taskId}`,
    channelKey: "feishu",
    projectKey,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: "2026-01-01T01:00:00.000Z",
    revision: 0,
    ...overrides,
  };
}

function gateway(calls: Array<{ method: string; input: unknown }>): Gateway {
  return {
    closeSession: async (input: unknown) => calls.push({ method: "closeSession", input }),
    abortTurn: async (input: unknown) => calls.push({ method: "abortTurn", input }),
    submitTurn: async function* () {
      yield { type: "turn_completed", usage: {}, finishReason: "completed" };
    },
  } as unknown as Gateway;
}

async function home(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("CronManager exposes tools, validates gateway, discovers projects and routes tasks", async (t) => {
  const pilotHome = await home("pilotdeck-cron-manager-");
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(pilotHome, { recursive: true, force: true }));
  });

  const disabled = createCronManager({ pilotHome, config: { ...defaultCronConfig(), enabled: false } });
  assert.deepEqual(disabled.getTools(), []);
  await disabled.start();

  const manager = createCronManager({
    pilotHome,
    config: defaultCronConfig(),
    uuid: () => "manager-task",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  await assert.rejects(manager.start(), /before bindGateway/);
  manager.bindGateway(gateway([]));
  assert.equal(manager.getTools().length, 4);
  assert.throws(() => manager.bindGateway(gateway([])), /already called/, "second bind must fail");
});

test("CronManager starts discovered projects, aggregates history and resolves ambiguous ids", async (t) => {
  const pilotHome = await home("pilotdeck-cron-manager-start-");
  const calls: Array<{ method: string; input: unknown }> = [];
  t.after(() => rm(pilotHome, { recursive: true, force: true }));

  const first = resolveCronPaths({ pilotHome, projectKey: PROJECT_A });
  const second = resolveCronPaths({ pilotHome, projectKey: PROJECT_B });
  await writeJson(first.tasksFile, { schemaVersion: 1, tasks: [task("same", PROJECT_A)] });
  await writeJson(second.tasksFile, { schemaVersion: 1, tasks: [task("same", PROJECT_B)] });
  await writeFile(first.runHistoryFile, `${JSON.stringify({ schemaVersion: 1, runId: "a-run", taskId: "same", sessionKey: "cron:same", projectKey: PROJECT_A, startedAt: "2026-01-01T00:00:00.000Z" })}\n`, "utf8");
  await writeFile(second.runHistoryFile, `${JSON.stringify({ schemaVersion: 1, runId: "b-run", taskId: "same", sessionKey: "cron:same", projectKey: PROJECT_B, startedAt: "2026-01-02T00:00:00.000Z" })}\n`, "utf8");

  const manager = createCronManager({
    pilotHome,
    config: defaultCronConfig(),
    uuid: () => "new-task",
    now: () => new Date("2025-01-01T00:00:00.000Z"),
  });
  manager.bindGateway(gateway(calls));
  await manager.start();
  const all = await manager.listTasks({ includeHistory: true, limit: 1 });
  assert.equal(all.tasks.length, 2);
  assert.deepEqual(all.recentRuns?.map((run) => run.runId), ["b-run"]);
  await assert.rejects(manager.updateTask({ taskId: "same", projectKey: "", expectedRevision: 0, message: "x", schedule: { type: "once", runAt: "2026-01-02T00:00:00.000Z" } }), /not_found|project/i);
  await assert.rejects(manager.deleteTask({ taskId: "same" }), /ambiguous/);
  await assert.rejects(manager.stopTask({ taskId: "same" }), /ambiguous/);
  await manager.stop();
  assert.ok(calls.some((call) => call.method === "closeSession"));
});

test("CronManager creates lazy runtimes, supports project-scoped operations and cleans up", async (t) => {
  const pilotHome = await home("pilotdeck-cron-manager-lazy-");
  const calls: Array<{ method: string; input: unknown }> = [];
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const manager = createCronManager({
    pilotHome,
    config: defaultCronConfig(),
    uuid: () => "lazy-task",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  manager.bindGateway(gateway(calls));
  const created = await manager.createTask({ projectKey: PROJECT_A, message: "hello", schedule: { type: "delay", amount: 1, unit: "minute" } });
  assert.equal(created.task.taskId, "lazy-task");
  assert.equal((await manager.listTasks({ projectKey: PROJECT_A })).tasks.length, 1);
  assert.deepEqual(await manager.updateTask({ taskId: "lazy-task", projectKey: PROJECT_B, expectedRevision: 0, message: "no", schedule: { type: "once", runAt: "2026-01-02T00:00:00.000Z" } }), { updated: false, reason: "not_found" });
  assert.deepEqual(await manager.runTaskNow({ taskId: "missing", projectKey: PROJECT_A }), { started: false, reason: "not_found" });
  assert.deepEqual(await manager.stopTask({ taskId: "missing", projectKey: PROJECT_B }), { stopped: false, taskId: "missing", runId: undefined });
  await assert.rejects(manager.createTask({ message: "missing project", schedule: { type: "once", runAt: "2026-01-02T00:00:00.000Z" } }), /projectKey/);
  await manager.stop();
  assert.ok((await readJson(resolveCronPaths({ pilotHome, projectKey: PROJECT_A }).tasksFile) as { tasks: unknown[] }).tasks.length === 1);
});

test("migrateCronStores merges project snapshots, deduplicates records and preserves invalid lines", async (t) => {
  const pilotHome = await home("pilotdeck-cron-migration-");
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const source = resolve(pilotHome, "cron", "projects", "legacy-source");
  const targetA = resolveCronPaths({ pilotHome, projectKey: PROJECT_A });
  const targetB = resolveCronPaths({ pilotHome, projectKey: PROJECT_B });
  const old = task("move-me", PROJECT_A, { updatedAt: "2026-01-01T00:00:00.000Z" });
  const newer = task("move-me", PROJECT_A, { message: "newer", updatedAt: "2026-01-02T00:00:00.000Z" });
  const runStarted = { schemaVersion: 1, runId: "run-1", taskId: "move-me", sessionKey: "cron:move-me", startedAt: "2026-01-01T00:00:00.000Z" };
  const runFinished = { ...runStarted, finishedAt: "2026-01-01T00:01:00.000Z", outcome: "completed" };
  await writeJson(join(source, "tasks.json"), { schemaVersion: 1, tasks: [old, newer, { malformed: true }, { message: "anonymous" }] });
  await writeFile(join(source, "run-history.jsonl"), `${JSON.stringify(runStarted)}\n${JSON.stringify(runFinished)}\nnot-json\n[]\n`, "utf8");
  await mkdir(join(source, "runs"), { recursive: true });
  await writeFile(join(source, "runs", "run-1.events.jsonl"), '{"seq":1}\n', "utf8");
  await writeJson(targetA.tasksFile, { schemaVersion: 1, tasks: [task("keep", PROJECT_A)] });
  await writeJson(targetB.tasksFile, { schemaVersion: 1, tasks: [] });
  await migrateCronStores({ pilotHome });

  const migratedTasks = (await readJson(targetA.tasksFile) as { tasks: CronTask[] }).tasks;
  assert.deepEqual(migratedTasks.map((item) => item.taskId).sort(), ["keep", "move-me"]);
  assert.equal(migratedTasks.find((item) => item.taskId === "move-me")?.message, "newer");
  const migratedRuns = (await readFile(targetA.runHistoryFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(migratedRuns.length, 1);
  assert.ok(migratedRuns.some((run) => run.finishedAt === "2026-01-01T00:01:00.000Z"));
  assert.match(await readFile(join(source, "run-history.jsonl"), "utf8"), /not-json/);
  assert.match(await readFile(resolve(pilotHome, "cron", "store-migration-v1.json"), "utf8"), /"version": 1/);
  assert.match(await readFile(cronRunEventsPath(targetA, "run-1"), "utf8"), /"seq":1/);
});

test("migrateCronStores keeps unreadable stores isolated and removes stale locks", async (t) => {
  const pilotHome = await home("pilotdeck-cron-migration-errors-");
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const root = resolve(pilotHome, "cron");
  const source = resolve(root, "projects", "blocked");
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, "tasks.json"), "{\"tasks\": \"broken\"}\n", "utf8");
  await writeFile(resolve(source, "run-history.jsonl"), "{\"runId\":\"orphan\",\"startedAt\":\"x\"}\n", "utf8");
  const lockPath = resolve(root, ".store-migration.lock");
  await writeFile(lockPath, "stale\n", "utf8");
  const old = new Date(Date.now() - 11 * 60_000);
  await utimes(lockPath, old, old);
  const warnings: unknown[] = [];
  await migrateCronStores({ pilotHome, logger: { info: () => undefined, warn: (_message, data) => warnings.push(data) } });
  assert.equal(await readFile(resolve(source, "tasks.json"), "utf8"), "{\"tasks\": \"broken\"}\n");
  assert.ok(warnings.length >= 1);
});
