import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaskCreateTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskWaitTool,
} from "../../../src/tool/builtin/taskTools.js";
import type {
  BackgroundTaskPort,
  BackgroundTaskAccess,
  StartTaskSpec,
  StopTaskOptions,
  WaitTaskOptions,
} from "../../../src/task/runtime/BackgroundTaskPort.js";
import type {
  PilotDeckBackgroundBashTask,
  PilotDeckBackgroundTaskListFilter,
  PilotDeckTaskOutputSlice,
} from "../../../src/task/protocol/types.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

class FakeBackgroundTaskPort implements BackgroundTaskPort {
  readonly starts: StartTaskSpec[] = [];
  readonly stops: Array<{ taskId: string; options: StopTaskOptions | undefined }> = [];
  readonly accesses: {
    list: Array<BackgroundTaskAccess | undefined>;
    get: Array<BackgroundTaskAccess | undefined>;
    output: Array<BackgroundTaskAccess | undefined>;
    wait: Array<BackgroundTaskAccess | undefined>;
    stop: Array<BackgroundTaskAccess | undefined>;
  } = { list: [], get: [], output: [], wait: [], stop: [] };
  lastWait?: {
    taskId: string;
    options: WaitTaskOptions | undefined;
    access: BackgroundTaskAccess | undefined;
  };
  waitOutcome: "completed" | "timeout" | "aborted" | "unknown" = "completed";
  private readonly tasks = new Map<string, PilotDeckBackgroundBashTask>();

  async start(spec: StartTaskSpec): Promise<PilotDeckBackgroundBashTask> {
    this.starts.push({ ...spec, ...(spec.env ? { env: { ...spec.env } } : {}) });
    const task = makeTask({
      taskId: `task-${this.tasks.size + 1}`,
      command: spec.command,
      cwd: spec.cwd,
      sessionId: spec.sessionId,
      agentId: spec.agentId,
      kind: spec.kind ?? "bash",
    });
    this.tasks.set(task.taskId, task);
    return task;
  }

  list(
    filter: PilotDeckBackgroundTaskListFilter = {},
    access?: BackgroundTaskAccess,
  ): readonly PilotDeckBackgroundBashTask[] {
    this.accesses.list.push(access);
    return [...this.tasks.values()].filter((task) => {
      if (filter.agentId && task.agentId !== filter.agentId) return false;
      if (filter.kind && task.kind !== filter.kind) return false;
      if (!filter.status) return true;
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      return statuses.includes(task.status);
    });
  }

  get(taskId: string, access?: BackgroundTaskAccess): PilotDeckBackgroundBashTask | undefined {
    this.accesses.get.push(access);
    return this.tasks.get(taskId);
  }

  getOutput(
    taskId: string,
    offset: number,
    maxBytes?: number,
    access?: BackgroundTaskAccess,
  ): PilotDeckTaskOutputSlice {
    this.accesses.output.push(access);
    if (!this.tasks.has(taskId)) throw new Error(`Unknown taskId: ${taskId}`);
    const content = "task output\n";
    const start = Math.min(offset, content.length);
    const end = maxBytes === undefined ? content.length : Math.min(content.length, start + maxBytes);
    return {
      content: content.slice(start, end),
      nextOffset: end,
      totalBytes: content.length,
      truncated: false,
    };
  }

  async wait(taskId: string, options?: WaitTaskOptions, access?: BackgroundTaskAccess) {
    this.accesses.wait.push(access);
    this.lastWait = { taskId, options, access };
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return {
      task,
      timedOut: this.waitOutcome === "timeout" || this.waitOutcome === "aborted",
      outcome: this.waitOutcome,
      waitedMs: 17,
    };
  }

  async stop(taskId: string, options?: StopTaskOptions, access?: BackgroundTaskAccess): Promise<void> {
    this.accesses.stop.push(access);
    this.stops.push({ taskId, options });
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown taskId: ${taskId}`);
    task.status = "cancelled";
    task.interrupted = true;
    task.endedAt = new Date("2026-09-09T00:00:01.000Z");
  }
}

function makeTask(overrides: Partial<PilotDeckBackgroundBashTask> = {}): PilotDeckBackgroundBashTask {
  return {
    taskId: "task-1",
    type: "local_bash",
    kind: "bash",
    command: "echo task",
    cwd: "/workspace",
    status: "running",
    completionStatusSentInAttachment: false,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    interrupted: false,
    startedAt: new Date("2026-09-09T00:00:00.000Z"),
    outputBytes: 12,
    ...overrides,
  };
}

function context(signal?: AbortSignal): PilotDeckToolRuntimeContext {
  return {
    sessionId: "task-session",
    turnId: "task-turn",
    cwd: "/workspace",
    env: { TASK_TEST: "1" },
    ...(signal ? { abortSignal: signal } : {}),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: "/workspace",
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

test("task tools consume a provider-neutral task port and preserve their output contract", async () => {
  const tasks: BackgroundTaskPort = new FakeBackgroundTaskPort();
  const fake = tasks as FakeBackgroundTaskPort;

  const created = await createTaskCreateTool(tasks).execute(
    { command: "npm test", agentId: "agent-1", kind: "monitor" },
    context(),
  );
  assert.deepEqual(fake.starts, [{
    command: "npm test",
    cwd: "/workspace",
    env: { TASK_TEST: "1" },
    sessionId: "task-session",
    agentId: "agent-1",
    kind: "monitor",
  }]);
  assert.deepEqual(created.data, { taskId: "task-1", status: "running", pid: undefined });

  const listed = await createTaskListTool(tasks).execute({ agentId: "agent-1" }, context());
  assert.equal(listed.data?.tasks.length, 1);
  assert.match(listed.content[0]?.type === "text" ? listed.content[0].text : "", /task_list count=1/);

  const output = await createTaskOutputTool(tasks).execute({ taskId: "task-1", offset: 5, maxBytes: 4 }, context());
  assert.deepEqual(output.data, {
    taskId: "task-1",
    content: "outp",
    nextOffset: 9,
    totalBytes: 12,
    truncated: false,
    status: "running",
    exitCode: undefined,
  });

  fake.waitOutcome = "timeout";
  const waited = await createTaskWaitTool(tasks).execute(
    { taskId: "task-1", timeoutMs: 31, offset: 0, maxBytes: 4 },
    context(),
  );
  assert.equal(fake.lastWait?.taskId, "task-1");
  assert.equal(fake.lastWait?.options?.timeoutMs, 31);
  assert.equal(waited.data?.timedOut, true);
  assert.equal(waited.data?.waitedMs, 17);
  assert.equal(waited.data?.content, "task");

  const stopped = await createTaskStopTool(tasks).execute({ taskId: "task-1", graceMs: 7 }, context());
  assert.deepEqual(fake.stops, [{ taskId: "task-1", options: { graceMs: 7 } }]);
  assert.deepEqual(stopped.data, { taskId: "task-1", status: "cancelled" });
  const expectedAccess = { sessionId: "task-session" };
  for (const accesses of Object.values(fake.accesses)) {
    assert.ok(accesses.length > 0);
    assert.deepEqual(accesses, accesses.map(() => expectedAccess));
  }

  const registry = createBuiltinRegistry({
    backgroundTasks: { runtime: tasks },
    webSearch: false,
    webFetch: false,
  });
  for (const name of ["task_create", "task_list", "task_output", "task_wait", "task_stop"]) {
    assert.equal(registry.has(name), true, `${name} should be composed from BackgroundTaskPort`);
  }
});

test("task port preserves unsupported, unknown-task, and aborted wait behavior", async () => {
  const tasks: BackgroundTaskPort = new FakeBackgroundTaskPort();
  const fake = tasks as FakeBackgroundTaskPort;

  await assert.rejects(
    createTaskCreateTool().execute({ command: "echo unavailable" }, context()),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "unsupported_tool",
  );
  await assert.rejects(
    createTaskOutputTool(tasks).execute({ taskId: "missing" }, context()),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "invalid_tool_input",
  );

  await fake.start({ command: "sleep 1", cwd: "/workspace" });
  fake.waitOutcome = "aborted";
  const controller = new AbortController();
  await assert.rejects(
    createTaskWaitTool(tasks).execute({ taskId: "task-1", timeoutMs: 10 }, context(controller.signal)),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "tool_aborted",
  );
  assert.equal(fake.lastWait?.options?.abortSignal, controller.signal);
});

test("task tools surface a restored unknown task without waiting or stopping it", async () => {
  const tasks: BackgroundTaskPort = new FakeBackgroundTaskPort();
  const fake = tasks as FakeBackgroundTaskPort;
  const task = await fake.start({ command: "sleep 1", cwd: "/workspace" });
  task.status = "unknown";
  fake.waitOutcome = "unknown";

  const waited = await createTaskWaitTool(tasks).execute({ taskId: task.taskId }, context());
  assert.equal(waited.data?.status, "unknown");
  assert.equal(waited.data?.outcome, "unknown");
  assert.match(waited.content[0]?.type === "text" ? waited.content[0].text : "", /cannot be waited or stopped/);

  await assert.rejects(
    createTaskStopTool(tasks).execute({ taskId: task.taskId }, context()),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError
      && error.code === "invalid_tool_input"
      && /unknown restored state/.test(error.message),
  );
});
