import type {
  PilotDeckPlanTodoStateSnapshot,
  PilotDeckTodoDiagnostics,
  PilotDeckTodoItem,
  PilotDeckTodoUpdate,
  PilotDeckTodoWriteHistoryEntry,
} from "../../tool/protocol/types.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { checkpointJsonSnapshot } from "../../session/projection/SessionProjectionCheckpointCodec.js";
import type { SessionProjectionDefinition } from "../../session/projection/SessionProjection.js";

export const PLAN_TODO_PROJECTION_NAME = "plan-todo.state";

const TODO_WRITE_TOOL_NAME = "todo_write";
const VALID_TODO_STATUSES = new Set<PilotDeckTodoItem["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

export function createPlanTodoSnapshot(): PilotDeckPlanTodoStateSnapshot {
  return {
    requiresInitialization: false,
    toolCallsSinceLastTodoWrite: 0,
    todos: [],
    activeTodos: [],
    todoHistory: [],
    todoDiagnostics: {
      writeCount: 0,
      todoCount: 0,
      activeCount: 0,
      completedCount: 0,
      cancelledCount: 0,
      largeRewriteCount: 0,
      deletedOpenItemCount: 0,
      completedWithoutActiveCount: 0,
    },
  };
}

export function replacePlanTodos(todos: PilotDeckTodoUpdate[]): PilotDeckTodoItem[] {
  return dedupeById(todos).map((todo, index) => normalizeTodoItem(todo, index));
}

export function mergePlanTodos(
  existingTodos: PilotDeckTodoItem[],
  updates: PilotDeckTodoUpdate[],
): PilotDeckTodoItem[] {
  const existingById = new Map<string, PilotDeckTodoItem>();
  for (const [index, todo] of existingTodos.entries()) {
    const normalized = normalizeTodoItem(todo, index);
    existingById.set(normalized.id!, normalized);
  }

  const append: PilotDeckTodoUpdate[] = [];
  for (const update of dedupeById(updates)) {
    const id = update.id?.trim();
    if (id && existingById.has(id)) {
      const current = existingById.get(id)!;
      existingById.set(id, {
        ...current,
        ...(update.content?.trim() ? { content: update.content.trim() } : {}),
        ...(update.status && VALID_TODO_STATUSES.has(update.status) ? { status: update.status } : {}),
        ...(update.priority?.trim() ? { priority: update.priority.trim() } : {}),
      });
      continue;
    }
    append.push(update);
  }

  const merged: PilotDeckTodoItem[] = [];
  const seen = new Set<string>();
  for (const [index, todo] of existingTodos.entries()) {
    const id = todo.id?.trim() || `todo-${index + 1}`;
    const current = existingById.get(id) ?? normalizeTodoItem(todo, index);
    if (!seen.has(current.id!)) {
      merged.push(current);
      seen.add(current.id!);
    }
  }
  const firstNewIndex = merged.length;
  append.forEach((todo, index) => {
    const normalized = normalizeTodoItem(todo, firstNewIndex + index);
    if (!seen.has(normalized.id!)) {
      merged.push(normalized);
      seen.add(normalized.id!);
    }
  });
  return merged;
}

export function createPlanTodoProjectionDefinition(): SessionProjectionDefinition<PilotDeckPlanTodoStateSnapshot> {
  return {
    name: PLAN_TODO_PROJECTION_NAME,
    version: 1,
    create: () => createPlanTodoSnapshot(),
    reduce(state, entry) {
      switch (entry.type) {
        case "plan_todo_plan_changed":
          return createSnapshotForPlan(entry.plan);
        case "plan_todo_written":
          return applyTodoWrite(state, entry);
        case "plan_todo_progressed":
          return applyToolProgress(state, entry.toolName);
        default:
          return state;
      }
    },
    checkpoint: {
      encode: (state) => checkpointJsonSnapshot(state, "plan/todo"),
      decode: (value) => parsePlanTodoSnapshot(value),
    },
  };
}

function createSnapshotForPlan(plan: string | null): PilotDeckPlanTodoStateSnapshot {
  const snapshot = createPlanTodoSnapshot();
  const approvedPlan = plan?.trim();
  return {
    ...snapshot,
    ...(approvedPlan ? { approvedPlan } : {}),
    requiresInitialization: Boolean(approvedPlan),
  };
}

function applyTodoWrite(
  state: PilotDeckPlanTodoStateSnapshot,
  entry: Extract<AgentTranscriptEntry, { type: "plan_todo_written" }>,
): PilotDeckPlanTodoStateSnapshot {
  const nextTodos = cloneTodos(entry.todos);
  const previousById = new Map(state.todos.map((todo) => [todo.id ?? todo.content, todo]));
  const nextById = new Map(nextTodos.map((todo) => [todo.id ?? todo.content, todo]));
  const removed = state.todos.filter((todo) => !nextById.has(todo.id ?? todo.content));
  const added = nextTodos.filter((todo) => !previousById.has(todo.id ?? todo.content));
  const changed = nextTodos.filter((todo) => {
    const previous = previousById.get(todo.id ?? todo.content);
    return Boolean(previous) && (
      previous!.content !== todo.content
      || previous!.status !== todo.status
      || previous!.priority !== todo.priority
    );
  });
  const deletedOpenItemCount = removed.filter(isActiveTodo).length;
  const previousActiveCount = state.activeTodos.length;
  const preservedCount = nextTodos.filter((todo) => previousById.has(todo.id ?? todo.content)).length;
  const largeRewrite = state.todos.length > 0
    && nextTodos.length > 0
    && preservedCount < Math.ceil(state.todos.length / 2);
  const allCompleted = nextTodos.length > 0
    && activeTodos(nextTodos).length === 0
    && nextTodos.every((todo) => todo.status === "completed" || todo.status === "cancelled");
  const lastWrite: PilotDeckTodoDiagnostics["lastWrite"] = {
    mode: entry.mode,
    merge: entry.merge,
    ...(entry.reason?.trim() ? { reason: entry.reason.trim() } : {}),
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    deletedOpenItemCount,
    largeRewrite,
    allCompleted,
  };
  const base: PilotDeckPlanTodoStateSnapshot = {
    ...(state.approvedPlan ? { approvedPlan: state.approvedPlan } : {}),
    requiresInitialization: false,
    toolCallsSinceLastTodoWrite: 0,
    ...(entry.markdown !== undefined ? { lastMarkdown: entry.markdown } : {}),
    todos: nextTodos,
    activeTodos: activeTodos(nextTodos),
    todoHistory: state.todoHistory,
    todoDiagnostics: {
      writeCount: state.todoHistory.length + 1,
      todoCount: nextTodos.length,
      activeCount: activeTodos(nextTodos).length,
      completedCount: nextTodos.filter((todo) => todo.status === "completed").length,
      cancelledCount: nextTodos.filter((todo) => todo.status === "cancelled").length,
      largeRewriteCount: state.todoDiagnostics.largeRewriteCount + (largeRewrite ? 1 : 0),
      deletedOpenItemCount: state.todoDiagnostics.deletedOpenItemCount + deletedOpenItemCount,
      completedWithoutActiveCount: state.todoDiagnostics.completedWithoutActiveCount
        + (allCompleted && previousActiveCount > 0 ? 1 : 0),
      lastWrite,
    },
  };
  const historyEntry: PilotDeckTodoWriteHistoryEntry = {
    createdAt: entry.createdAt,
    mode: entry.mode,
    merge: entry.merge,
    ...(entry.reason?.trim() ? { reason: entry.reason.trim() } : {}),
    ...(entry.markdown !== undefined ? { markdown: entry.markdown } : {}),
    todos: cloneTodos(nextTodos),
    diagnostics: cloneDiagnostics(base.todoDiagnostics),
  };
  return {
    ...base,
    todoHistory: [...state.todoHistory, historyEntry],
  };
}

function applyToolProgress(
  state: PilotDeckPlanTodoStateSnapshot,
  toolName: string,
): PilotDeckPlanTodoStateSnapshot {
  if (!state.approvedPlan || state.requiresInitialization || toolName === TODO_WRITE_TOOL_NAME) {
    return state;
  }
  return withDiagnostics({
    ...state,
    toolCallsSinceLastTodoWrite: state.toolCallsSinceLastTodoWrite + 1,
  });
}

function withDiagnostics(state: PilotDeckPlanTodoStateSnapshot): PilotDeckPlanTodoStateSnapshot {
  return {
    ...state,
    todoDiagnostics: {
      ...state.todoDiagnostics,
      writeCount: state.todoHistory.length,
      todoCount: state.todos.length,
      activeCount: state.activeTodos.length,
      completedCount: state.todos.filter((todo) => todo.status === "completed").length,
      cancelledCount: state.todos.filter((todo) => todo.status === "cancelled").length,
      ...(state.todoDiagnostics.lastWrite ? { lastWrite: { ...state.todoDiagnostics.lastWrite } } : {}),
    },
  };
}

export function parsePlanTodoSnapshot(value: unknown): PilotDeckPlanTodoStateSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("plan/todo checkpoint must be an object.");
  }
  const snapshot = value as Partial<PilotDeckPlanTodoStateSnapshot>;
  const requiresInitialization = snapshot.requiresInitialization;
  const toolCallsSinceLastTodoWrite = snapshot.toolCallsSinceLastTodoWrite;
  if (
    typeof requiresInitialization !== "boolean"
    || typeof toolCallsSinceLastTodoWrite !== "number"
    || !Number.isSafeInteger(toolCallsSinceLastTodoWrite)
    || toolCallsSinceLastTodoWrite < 0
    || !Array.isArray(snapshot.todos)
    || !Array.isArray(snapshot.activeTodos)
    || !Array.isArray(snapshot.todoHistory)
    || typeof snapshot.todoDiagnostics !== "object"
    || snapshot.todoDiagnostics === null
  ) {
    throw new TypeError("plan/todo checkpoint is invalid.");
  }
  const replayed = createPlanTodoSnapshot();
  let state = snapshot.approvedPlan ? createSnapshotForPlan(snapshot.approvedPlan) : replayed;
  for (const history of snapshot.todoHistory) {
    if (typeof history !== "object" || history === null) throw new TypeError("plan/todo checkpoint history is invalid.");
    const item = history as PilotDeckTodoWriteHistoryEntry;
    if (!Array.isArray(item.todos) || (item.mode !== "markdown" && item.mode !== "structured")) {
      throw new TypeError("plan/todo checkpoint history is invalid.");
    }
    state = applyTodoWrite(state, {
      type: "plan_todo_written",
      sessionId: "checkpoint",
      turnId: "checkpoint",
      sequence: 1,
      createdAt: item.createdAt,
      mode: item.mode,
      merge: item.merge,
      ...(item.markdown !== undefined ? { markdown: item.markdown } : {}),
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
      todos: item.todos,
    });
  }
  return {
    ...state,
    requiresInitialization,
    toolCallsSinceLastTodoWrite,
    ...(snapshot.lastMarkdown !== undefined ? { lastMarkdown: snapshot.lastMarkdown } : {}),
    todoDiagnostics: cloneDiagnostics(snapshot.todoDiagnostics as PilotDeckTodoDiagnostics),
  };
}

function normalizeTodoItem(item: PilotDeckTodoUpdate, index: number): PilotDeckTodoItem {
  const content = item.content?.trim() || "(no description)";
  const status = item.status && VALID_TODO_STATUSES.has(item.status) ? item.status : "pending";
  return {
    id: item.id?.trim() || `todo-${index + 1}`,
    content,
    status,
    ...(item.priority?.trim() ? { priority: item.priority.trim() } : {}),
  };
}

function dedupeById<T extends PilotDeckTodoUpdate>(todos: T[]): T[] {
  const lastIndex = new Map<string, number>();
  todos.forEach((todo, index) => {
    lastIndex.set(todo.id?.trim() || `todo-${index + 1}`, index);
  });
  return [...lastIndex.values()].sort((left, right) => left - right).map((index) => todos[index]!);
}

function activeTodos(todos: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  return todos.filter(isActiveTodo).map((todo) => ({ ...todo }));
}

function isActiveTodo(todo: PilotDeckTodoItem): boolean {
  return todo.status === "pending" || todo.status === "in_progress";
}

function cloneTodos(todos: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function cloneDiagnostics(diagnostics: PilotDeckTodoDiagnostics): PilotDeckTodoDiagnostics {
  return {
    ...diagnostics,
    ...(diagnostics.lastWrite ? { lastWrite: { ...diagnostics.lastWrite } } : {}),
  };
}
