import assert from "node:assert/strict";
import test from "node:test";

import { createNativePlanTodoRuntime } from "../../src/plan-todo/runtime/NativePlanTodoRuntime.js";
import { PLAN_TODO_PROJECTION_NAME } from "../../src/plan-todo/projection/PlanTodoProjection.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import { InMemorySessionEventStore } from "../../src/session/events/InMemorySessionEventStore.js";
import { createDefaultSessionProjectionRegistry } from "../../src/session/projection/BuiltinSessionProjections.js";
import { SessionProjectionDriver } from "../../src/session/projection/SessionProjectionDriver.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";
import { createTodoWriteTool } from "../../src/tool/builtin/todoWrite.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

const SESSION_ID = "plan-todo-session";
const TURN_ID = "plan-todo-turn";

test("native plan/todo provider writes through the session projection and restores from checkpoint", async () => {
  const events = new InMemorySessionEventStore({
    now: () => new Date("2026-09-09T00:00:00.000Z"),
    uuid: (() => {
      let sequence = 0;
      return () => `entry-${++sequence}`;
    })(),
  });
  const projections = new SessionProjectionDriver({
    runtime: events,
    registry: createDefaultSessionProjectionRegistry(),
  });
  const transcript = new InMemoryTranscriptWriter({ eventStore: events });
  await events.append(SESSION_ID, TURN_ID, { type: "turn_started" });

  const port = createNativePlanTodoRuntime({
    sessionId: SESSION_ID,
    transcript,
    projections,
  });
  const handle = port.forSession(SESSION_ID);
  await handle.markPlanApproved("# Durable plan\nImplement the session capability.", { turnId: TURN_ID });

  const output = await createTodoWriteTool().execute({
    todos: [
      { id: "inspect", content: "Inspect the session state", status: "in_progress" },
      { id: "verify", content: "Verify resume", status: "pending", priority: "high" },
    ],
  }, {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    cwd: "/workspace",
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd: "/workspace",
      rules: { allow: [], deny: [], ask: [] },
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
    },
    planTodo: handle,
  });

  assert.equal(output.data?.mode, "structured");
  assert.deepEqual(handle.getSnapshot().todos.map((todo) => todo.id), ["inspect", "verify"]);
  assert.equal(handle.getSnapshot().requiresInitialization, false);
  assert.equal(handle.getSnapshot().todoDiagnostics.writeCount, 1);

  await handle.markToolProgressChanged("write_file", { turnId: TURN_ID });
  assert.equal(handle.getSnapshot().toolCallsSinceLastTodoWrite, 1);

  const registry = new ToolRegistry();
  registry.register({
    name: "write_artifact",
    description: "Writes a generated artifact.",
    kind: "custom",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [{ type: "text", text: "written" }] }),
  });
  const sideEffect = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    { id: "write-artifact-call", name: "write_artifact", input: {} },
    {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      cwd: "/workspace",
      permissionMode: "bypassPermissions",
      permissionContext: {
        mode: "bypassPermissions",
        cwd: "/workspace",
        rules: { allow: [], deny: [], ask: [] },
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: true,
      },
      planTodo: handle,
    },
  );
  assert.equal(sideEffect.type, "success");
  assert.equal(handle.getSnapshot().toolCallsSinceLastTodoWrite, 2);

  const { entries } = await events.read();
  assert.deepEqual(entries.map((entry) => entry.type), [
    "turn_started",
    "plan_todo_plan_changed",
    "plan_todo_written",
    "plan_todo_progressed",
    "plan_todo_progressed",
  ]);
  assert.deepEqual(
    projections.snapshot([PLAN_TODO_PROJECTION_NAME]).values[PLAN_TODO_PROJECTION_NAME],
    handle.getSnapshot(),
  );

  const restoredEvents = new InMemorySessionEventStore();
  restoredEvents.restore(entries);
  const restoredProjections = new SessionProjectionDriver({
    runtime: restoredEvents,
    registry: createDefaultSessionProjectionRegistry(),
    entries,
    checkpoint: projections.checkpoint(),
  });
  const restored = createNativePlanTodoRuntime({
    sessionId: SESSION_ID,
    transcript: new InMemoryTranscriptWriter({ eventStore: restoredEvents }),
    projections: restoredProjections,
  }).forSession(SESSION_ID);

  assert.deepEqual(restored.getSnapshot(), handle.getSnapshot());
  projections.dispose();
  restoredProjections.dispose();
});

test("plan/todo events require a valid active-turn todo snapshot", async () => {
  const events = new InMemorySessionEventStore();
  await events.append(SESSION_ID, TURN_ID, { type: "turn_started" });

  await assert.rejects(
    events.append(SESSION_ID, TURN_ID, {
      type: "plan_todo_written",
      mode: "structured",
      merge: false,
      todos: [{ id: "", content: "missing id", status: "pending" }],
    }),
    (error: unknown) => error instanceof Error && error.name === "SessionDomainValidationError",
  );

  await assert.rejects(
    events.append(SESSION_ID, TURN_ID, {
      type: "plan_todo_progressed",
      toolName: "",
    }),
    (error: unknown) => error instanceof Error && error.name === "SessionDomainValidationError",
  );
});
