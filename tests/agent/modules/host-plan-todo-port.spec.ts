import assert from "node:assert/strict";
import test from "node:test";

import { createHostPlanTodoPort } from "../../../src/agent/modules/capability/index.js";
import { createPlanTodoSnapshot } from "../../../src/plan-todo/projection/PlanTodoProjection.js";
import type { PilotDeckPlanTodoStateSnapshot, PilotDeckTodoItem } from "../../../src/tool/protocol/types.js";

const sessionId = "sidecar-plan-session";
const turnId = "sidecar-plan-turn";

test("host plan/todo port keeps a validated host snapshot for prompt and tool gating", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let snapshot = approvedPlanSnapshot();
  const port = createHostPlanTodoPort(async (request) => {
    calls.push(request as unknown as Record<string, unknown>);
    const payload = request.payload;
    if (payload.method === "write_todos") {
      snapshot = initializedSnapshot(payload.todos as PilotDeckTodoItem[]);
    }
    return response(snapshot);
  }, {
    runId: "run-1",
    operationId: "operation-1",
    uuid: (() => {
      let sequence = 0;
      return () => String(++sequence);
    })(),
  });

  await port.initialize(sessionId, turnId);
  const handle = port.forSession(sessionId);
  assert.match(handle.buildPromptAddendum() ?? "", /Before using any non-read-only tool/);
  assert.match(handle.blockingMessageFor("write_file", false) ?? "", /`todo_write` first/);

  await handle.writeTodos([
    { id: "inspect", content: "Inspect host state", status: "in_progress" },
  ], { turnId, markdown: "- [ ] Inspect host state" });

  assert.equal(handle.buildPromptAddendum(), undefined);
  assert.equal(handle.blockingMessageFor("write_file", false), undefined);
  assert.deepEqual(handle.getSnapshot().todos, [
    { id: "inspect", content: "Inspect host state", status: "in_progress" },
  ]);
  const firstPayload = calls[0]?.payload as Record<string, unknown>;
  const writePayload = calls[1]?.payload as Record<string, unknown>;
  assert.deepEqual(firstPayload, {
    operation: "plan_todo",
    method: "read",
    sessionId,
    turnId,
  });
  assert.equal(writePayload.operation, "plan_todo");
  assert.equal(writePayload.method, "write_todos");
  assert.equal(writePayload.sessionId, sessionId);
  assert.equal(writePayload.turnId, turnId);
});

test("host plan/todo port rejects invalid host projections", async () => {
  const port = createHostPlanTodoPort(async () => ({
    kind: "response",
    messageId: "invalid",
    inReplyTo: "request",
    ok: true,
    payload: { snapshot: {} },
  }), {
    runId: "run-1",
    operationId: "operation-1",
  });

  await assert.rejects(() => port.initialize(sessionId, turnId), /plan\/todo checkpoint is invalid/);
});

function response(snapshot: PilotDeckPlanTodoStateSnapshot) {
  return {
    kind: "response" as const,
    messageId: "snapshot",
    inReplyTo: "request",
    ok: true,
    payload: { snapshot },
  };
}

function approvedPlanSnapshot(): PilotDeckPlanTodoStateSnapshot {
  return {
    ...createPlanTodoSnapshot(),
    approvedPlan: "# Approved plan\nImplement host-owned todos.",
    requiresInitialization: true,
  };
}

function initializedSnapshot(todos: PilotDeckTodoItem[]): PilotDeckPlanTodoStateSnapshot {
  const activeTodos = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
  const diagnostics = {
    writeCount: 1,
    todoCount: todos.length,
    activeCount: activeTodos.length,
    completedCount: todos.filter((todo) => todo.status === "completed").length,
    cancelledCount: todos.filter((todo) => todo.status === "cancelled").length,
    largeRewriteCount: 0,
    deletedOpenItemCount: 0,
    completedWithoutActiveCount: 0,
    lastWrite: {
      mode: "structured" as const,
      merge: false,
      addedCount: todos.length,
      removedCount: 0,
      changedCount: 0,
      deletedOpenItemCount: 0,
      largeRewrite: false,
      allCompleted: activeTodos.length === 0,
    },
  };
  return {
    approvedPlan: "# Approved plan\nImplement host-owned todos.",
    requiresInitialization: false,
    toolCallsSinceLastTodoWrite: 0,
    lastMarkdown: "- [ ] Inspect host state",
    todos,
    activeTodos,
    todoHistory: [{
      createdAt: "2026-09-10T00:00:00.000Z",
      mode: "structured",
      merge: false,
      markdown: "- [ ] Inspect host state",
      todos,
      diagnostics,
    }],
    todoDiagnostics: diagnostics,
  };
}
