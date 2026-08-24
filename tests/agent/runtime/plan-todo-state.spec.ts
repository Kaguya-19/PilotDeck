import assert from "node:assert/strict";
import test from "node:test";

import { createPlanTodoStateManager } from "../../../src/agent/runtime/PlanTodoState.js";
import type { PilotDeckTodoItem, PilotDeckTodoUpdate } from "../../../src/tool/protocol/types.js";

function item(id: string, status: PilotDeckTodoItem["status"] = "pending", content = id): PilotDeckTodoItem {
  return { id, status, content };
}

function update(id: string, status?: PilotDeckTodoUpdate["status"], content = id): PilotDeckTodoUpdate {
  return { id, ...(status ? { status } : {}), content };
}

test("PlanTodoState starts isolated per session and exposes empty diagnostics", () => {
  const manager = createPlanTodoStateManager();
  const first = manager.forSession("session-a");
  const second = manager.forSession("session-b");
  assert.deepEqual(first.getSnapshot().todoDiagnostics, {
    writeCount: 0,
    todoCount: 0,
    activeCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    largeRewriteCount: 0,
    deletedOpenItemCount: 0,
    completedWithoutActiveCount: 0,
  });
  first.markPlanApproved("  plan text  ");
  assert.equal(first.getSnapshot().approvedPlan, "plan text");
  assert.equal(second.getSnapshot().approvedPlan, undefined);
});

test("PlanTodoState blocks non-read-only tools until an approved plan is initialized", () => {
  const handle = createPlanTodoStateManager().forSession("session");
  assert.equal(handle.buildPromptAddendum(), undefined);
  assert.equal(handle.blockingMessageFor("bash", false), undefined);

  handle.markPlanApproved("plan");
  assert.match(handle.buildPromptAddendum() ?? "", /approved plan/);
  assert.match(handle.blockingMessageFor("bash", false) ?? "", /todo_write/);
  assert.equal(handle.blockingMessageFor("read_file", true), undefined);
  assert.equal(handle.blockingMessageFor("todo_write", false), undefined);

  handle.markToolProgressChanged("bash");
  assert.equal(handle.getSnapshot().toolCallsSinceLastTodoWrite, 0);
  handle.recordTodoWrite("- [ ] item", [item("item")]);
  assert.equal(handle.buildPromptAddendum(), undefined);
  handle.markToolProgressChanged("todo_write");
  handle.markToolProgressChanged("bash");
  assert.equal(handle.getSnapshot().toolCallsSinceLastTodoWrite, 1);
});

test("PlanTodoState normalizes markdown writes, deduplicates ids and records diagnostics", () => {
  const handle = createPlanTodoStateManager().forSession("session");
  const result = handle.recordTodoWrite("markdown", [
    { id: " a ", content: " first ", status: "invalid" as never, priority: " high " },
    { id: "a", content: "replacement", status: "completed" },
    { content: "second", status: "cancelled" },
  ]);
  assert.deepEqual(result, [
    { id: "a", content: "replacement", status: "completed" },
    { id: "todo-2", content: "second", status: "cancelled" },
  ]);
  const snapshot = handle.getSnapshot();
  assert.deepEqual(snapshot.activeTodos, []);
  assert.equal(snapshot.lastMarkdown, "markdown");
  assert.deepEqual(snapshot.todoDiagnostics, {
    writeCount: 1,
    todoCount: 2,
    activeCount: 0,
    completedCount: 1,
    cancelledCount: 1,
    largeRewriteCount: 0,
    deletedOpenItemCount: 0,
    completedWithoutActiveCount: 0,
    lastWrite: {
      mode: "markdown",
      merge: false,
      addedCount: 2,
      removedCount: 0,
      changedCount: 0,
      deletedOpenItemCount: 0,
      largeRewrite: false,
      allCompleted: true,
    },
  });
});

test("PlanTodoState merges structured updates and preserves order", () => {
  const handle = createPlanTodoStateManager().forSession("session");
  handle.writeTodos([
    update("first", "pending", "First"),
    update("second", "in_progress", "Second"),
  ]);
  const merged = handle.writeTodos([
    { id: "second", status: "completed", priority: "p1" },
    { id: "new", content: " New item " },
    { id: "new", content: "last value", status: "cancelled" },
  ], { merge: true, markdown: "merged", reason: "progress" });
  assert.deepEqual(merged, [
    { id: "first", status: "pending", content: "First" },
    { id: "second", status: "completed", content: "Second", priority: "p1" },
    { id: "new", status: "cancelled", content: "last value" },
  ]);
  const snapshot = handle.getSnapshot();
  assert.equal(snapshot.lastMarkdown, "merged");
  assert.equal(snapshot.todoHistory.length, 2);
  assert.equal(snapshot.todoHistory[1]?.reason, "progress");
  assert.equal(snapshot.todoDiagnostics.completedCount, 1);
  assert.equal(snapshot.todoDiagnostics.activeCount, 1);
});

test("PlanTodoState records deleted open items, large rewrites and completion transitions", () => {
  const handle = createPlanTodoStateManager().forSession("session");
  handle.writeTodos([item("one"), item("two", "in_progress"), item("three")]);
  handle.writeTodos([item("replacement", "completed")], { reason: "rewrite" });
  let diagnostics = handle.getSnapshot().todoDiagnostics;
  assert.equal(diagnostics.largeRewriteCount, 1);
  assert.equal(diagnostics.deletedOpenItemCount, 3);
  assert.equal(diagnostics.completedWithoutActiveCount, 1);
  assert.equal(diagnostics.lastWrite?.largeRewrite, true);
  assert.equal(diagnostics.lastWrite?.allCompleted, true);
});

test("PlanTodoState emits a reminder after ten tool calls and resets it after a write", () => {
  const handle = createPlanTodoStateManager().forSession("session");
  handle.markPlanApproved("plan");
  handle.recordTodoWrite("- [ ] item", [item("item")]);
  for (let index = 0; index < 9; index += 1) handle.markToolProgressChanged("bash");
  assert.equal(handle.buildPromptAddendum(), undefined);
  handle.markToolProgressChanged("bash");
  assert.match(handle.buildPromptAddendum() ?? "", /10 tool calls/);
  handle.writeTodos([update("item", "in_progress")]);
  assert.equal(handle.getSnapshot().toolCallsSinceLastTodoWrite, 0);
  assert.equal(handle.buildPromptAddendum(), undefined);
});

test("PlanTodoState clears approved plan and history when an empty plan is approved", () => {
  const handle = createPlanTodoStateManager().forSession("session");
  handle.markPlanApproved("plan");
  handle.recordTodoWrite("todo", [item("item")]);
  handle.markPlanApproved("   ");
  const snapshot = handle.getSnapshot();
  assert.equal(snapshot.approvedPlan, undefined);
  assert.equal(snapshot.requiresInitialization, false);
  assert.deepEqual(snapshot.todos, []);
  assert.deepEqual(snapshot.todoHistory, []);
  assert.equal(snapshot.todoDiagnostics.writeCount, 0);
});
