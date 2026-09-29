import type {
  PilotDeckPlanTodoStateHandle,
  PilotDeckTodoItem,
  PilotDeckTodoUpdate,
} from "../../../tool/protocol/types.js";
import type { ModuleCallRequest } from "../protocol.js";

/** Host-side handler for the legacy capability.plan_todo wire operation. */
export function createHostPlanTodoModuleHandler(options: {
  sessionId: string;
  turnId: string;
  resolve: () => PilotDeckPlanTodoStateHandle | undefined;
}): (call: ModuleCallRequest) => Promise<Record<string, unknown>> {
  return async (call) => {
    const planTodo = options.resolve();
    if (!planTodo) throw new Error("Host did not provide a plan/todo capability.");
    const sessionId = stringField(call.payload, "sessionId");
    const turnId = stringField(call.payload, "turnId");
    if (sessionId !== options.sessionId || turnId !== options.turnId) {
      throw new Error("Plan/todo capability identity does not match the active host turn.");
    }
    const method = stringField(call.payload, "method");
    if (method === "read") return { snapshot: planTodo.getSnapshot() };
    if (method === "mark_plan_approved") {
      await planTodo.markPlanApproved(stringField(call.payload, "plan"), { turnId });
    } else if (method === "record_todo_write") {
      await planTodo.recordTodoWrite(
        stringField(call.payload, "markdown"),
        todoItems(call.payload.todos),
        { turnId, ...(optionalStringField(call.payload, "reason") ? { reason: optionalStringField(call.payload, "reason") } : {}) },
      );
    } else if (method === "write_todos") {
      await planTodo.writeTodos(todoUpdates(call.payload.todos), {
        turnId,
        ...(typeof call.payload.markdown === "string" ? { markdown: call.payload.markdown } : {}),
        ...(call.payload.merge === true ? { merge: true } : {}),
        ...(optionalStringField(call.payload, "reason") ? { reason: optionalStringField(call.payload, "reason") } : {}),
      });
    } else if (method === "mark_tool_progress") {
      await planTodo.markToolProgressChanged(stringField(call.payload, "toolName"), { turnId });
    } else {
      throw new Error(`Unsupported sidecar plan/todo method: ${method}`);
    }
    return { snapshot: planTodo.getSnapshot() };
  };
}

function stringField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== "string" || value[field]!.length === 0) throw new Error(`Missing ${field}.`);
  return value[field] as string;
}

function optionalStringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? value[field] as string : undefined;
}

function todoItems(value: unknown): PilotDeckTodoItem[] {
  if (!Array.isArray(value)) throw new Error("Plan/todo items must be an array.");
  return value.map((entry) => {
    const record = asRecord(entry);
    const content = optionalStringField(record, "content");
    const status = record.status;
    if (!content || !isTodoStatus(status)) throw new Error("Plan/todo item is invalid.");
    return {
      content,
      status,
      ...(optionalStringField(record, "id") ? { id: optionalStringField(record, "id") } : {}),
      ...(optionalStringField(record, "priority") ? { priority: optionalStringField(record, "priority") } : {}),
    };
  });
}

function todoUpdates(value: unknown): PilotDeckTodoUpdate[] {
  if (!Array.isArray(value)) throw new Error("Plan/todo updates must be an array.");
  return value.map((entry) => {
    const record = asRecord(entry);
    const status = record.status;
    if (status !== undefined && !isTodoStatus(status)) throw new Error("Plan/todo update status is invalid.");
    return {
      ...(optionalStringField(record, "id") ? { id: optionalStringField(record, "id") } : {}),
      ...(optionalStringField(record, "content") ? { content: optionalStringField(record, "content") } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(optionalStringField(record, "priority") ? { priority: optionalStringField(record, "priority") } : {}),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plan/todo entry must be an object.");
  return value as Record<string, unknown>;
}

function isTodoStatus(value: unknown): value is PilotDeckTodoItem["status"] {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}
