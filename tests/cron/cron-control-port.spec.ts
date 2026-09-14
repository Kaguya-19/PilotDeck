import assert from "node:assert/strict";
import test from "node:test";

import {
  createCronManager,
  defaultCronConfig,
  resolveCronPaths,
  type CronProjectStorageProvider,
  type CronTask,
  type CronTaskStorePort,
} from "../../src/cron/index.js";
import { createCronToolDefinitions } from "../../src/cron/tool/createCronToolDefinitions.js";
import type { CronControlPort } from "../../src/cron/runtime/CronControlPort.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

function context(): PilotDeckToolRuntimeContext {
  return {
    sessionId: "cli:cron-control-session",
    turnId: "cron-control-turn",
    cwd: "/workspace/project",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: "/workspace/project",
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

test("cron tools consume CronControlPort and preserve project-scoped control calls", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const port: CronControlPort = {
    async createTask(input) {
      calls.push({ method: "create", input });
      return { task: { taskId: "task-create" } as never };
    },
    async listTasks(input) {
      calls.push({ method: "list", input });
      return { tasks: [] };
    },
    async updateTask(input) {
      calls.push({ method: "update", input });
      return { updated: false, reason: "conflict" };
    },
    async deleteTask(input) {
      calls.push({ method: "delete", input });
      return { deleted: true };
    },
    async stopTask(input) {
      calls.push({ method: "stop", input });
      return { stopped: true, taskId: input.taskId };
    },
    async runTaskNow(input) {
      calls.push({ method: "run_now", input });
      return { started: true, taskId: input.taskId };
    },
  };
  const tools = new Map(createCronToolDefinitions(port).map((tool) => [tool.name, tool]));
  const toolContext = context();

  const create = tools.get("cron_create");
  const list = tools.get("cron_list");
  const update = tools.get("cron_update");
  const remove = tools.get("cron_delete");
  const stop = tools.get("cron_stop");
  const runNow = tools.get("cron_run_now");
  assert.ok(create && list && update && remove && stop && runNow);

  const createResult = await create.execute({
    message: "Review the implementation",
    schedule: { type: "delay", amount: 10, unit: "minute" },
  }, toolContext);
  const listResult = await list.execute({ includeHistory: true, limit: 3 }, toolContext);
  const updateResult = await update.execute({
    taskId: "task-update",
    expectedRevision: 4,
    message: "Review the revised implementation",
    schedule: { type: "cron", expression: "0 9 * * 1", timezone: "UTC" },
    timezone: "UTC",
  }, toolContext);
  const deleteResult = await remove.execute({ taskId: "task-delete", stopRunning: true }, toolContext);
  const stopResult = await stop.execute({ taskId: "task-stop" }, toolContext);
  const runNowResult = await runNow.execute({ taskId: "task-run" }, toolContext);

  assert.deepEqual(createResult.data, { task: { taskId: "task-create" } });
  assert.deepEqual(listResult.data, { tasks: [] });
  assert.deepEqual(updateResult.data, { updated: false, reason: "conflict" });
  assert.deepEqual(deleteResult.data, { deleted: true });
  assert.deepEqual(stopResult.data, { stopped: true, taskId: "task-stop" });
  assert.deepEqual(runNowResult.data, { started: true, taskId: "task-run" });
  assert.deepEqual(calls, [
    {
      method: "create",
      input: {
        message: "Review the implementation",
        schedule: { type: "delay", amount: 10, unit: "minute" },
        sessionKey: "cli:cron-control-session",
        channelKey: "cli",
        projectKey: "/workspace/project",
      },
    },
    { method: "list", input: { includeHistory: true, limit: 3, projectKey: "/workspace/project" } },
    {
      method: "update",
      input: {
        taskId: "task-update",
        expectedRevision: 4,
        message: "Review the revised implementation",
        schedule: { type: "cron", expression: "0 9 * * 1", timezone: "UTC" },
        timezone: "UTC",
        projectKey: "/workspace/project",
      },
    },
    { method: "delete", input: { taskId: "task-delete", stopRunning: true, projectKey: "/workspace/project" } },
    { method: "stop", input: { taskId: "task-stop", projectKey: "/workspace/project" } },
    { method: "run_now", input: { taskId: "task-run", projectKey: "/workspace/project" } },
  ]);
});

test("CronControlPort composition exposes each schedule operation once", () => {
  const port = {} as CronControlPort;
  assert.deepEqual(
    createCronToolDefinitions(port).map((tool) => tool.name),
    ["cron_create", "cron_list", "cron_update", "cron_delete", "cron_stop", "cron_run_now"],
  );
});

test("native CronManager publishes the port-composed update and run-now tools", () => {
  const manager = createCronManager({
    config: defaultCronConfig(),
    pilotHome: "/tmp/pilotdeck-cron-control-port",
  });

  assert.deepEqual(
    manager.getTools().map((tool) => tool.name),
    ["cron_create", "cron_list", "cron_update", "cron_delete", "cron_stop", "cron_run_now"],
  );
});

test("CronManager consumes a structural project storage provider for startup and task control", async () => {
  const projectKey = "/workspace/cron-provider-project";
  const calls: string[] = [];
  const tasks: CronTask[] = [];
  const runs: never[] = [];
  const taskStore: CronTaskStorePort = {
    async listTasks() {
      calls.push("listTasks");
      return tasks.map((task) => ({ ...task }));
    },
    async putTask(task) {
      calls.push("putTask");
      const index = tasks.findIndex((entry) => entry.taskId === task.taskId);
      if (index >= 0) tasks[index] = { ...task };
      else tasks.push({ ...task });
    },
    async updateTask(taskId, update) {
      calls.push("updateTask");
      const index = tasks.findIndex((entry) => entry.taskId === taskId);
      if (index < 0) return undefined;
      const updated = update({ ...tasks[index] });
      if (updated) tasks[index] = { ...updated };
      return updated;
    },
    async deleteTask(taskId) {
      calls.push("deleteTask");
      const index = tasks.findIndex((entry) => entry.taskId === taskId);
      if (index < 0) return false;
      tasks.splice(index, 1);
      return true;
    },
    async appendRun() {
      calls.push("appendRun");
    },
    async listRuns() {
      calls.push("listRuns");
      return runs;
    },
    async appendRunEvent() {
      calls.push("appendRunEvent");
    },
  };
  const provider: CronProjectStorageProvider = {
    create(input) {
      calls.push(`create:${input.projectKey}`);
      return { paths: resolveCronPaths(input), taskStore };
    },
    async migrateLegacy() {
      calls.push("migrateLegacy");
    },
    async listProjectKeys() {
      calls.push("listProjectKeys");
      return [];
    },
    async recordProjectKey(input) {
      calls.push(`recordProjectKey:${input.projectKey}`);
    },
  };
  const manager = createCronManager({
    config: defaultCronConfig(),
    pilotHome: "/tmp/pilotdeck-cron-provider",
    cronStorageProvider: provider,
  });
  manager.bindAgentGateway({
    async *submitTurn() {},
    async abortTurn() {},
    async closeSession() {},
  });

  await manager.start();
  const created = await manager.createTask({
    projectKey,
    message: "Use the selected Cron provider",
    schedule: { type: "delay", amount: 5, unit: "minute" },
  });
  const listed = await manager.listTasks({ projectKey });
  await manager.stop();

  assert.equal(created.task.projectKey, projectKey);
  assert.deepEqual(listed.tasks.map((task) => task.taskId), [created.task.taskId]);
  assert.deepEqual(calls.slice(0, 4), [
    "migrateLegacy",
    "listProjectKeys",
    `create:${projectKey}`,
    `recordProjectKey:${projectKey}`,
  ]);
  assert.ok(calls.includes("putTask"));
  assert.ok(calls.includes("listTasks"));
});
