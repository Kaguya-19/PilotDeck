import type {
  PilotDeckPlanTodoStateHandle,
  PilotDeckPlanTodoStateSnapshot,
} from "../../../tool/protocol/types.js";
import { createPlanTodoSnapshot, parsePlanTodoSnapshot } from "../../../plan-todo/projection/PlanTodoProjection.js";
import type { PlanTodoPort } from "../../../plan-todo/runtime/PlanTodoPort.js";
import {
  buildPlanTodoPromptAddendum,
  clonePlanTodoSnapshot,
  planTodoBlockingMessageFor,
} from "../../../plan-todo/runtime/planTodoStateHelpers.js";
import type { ToolPort } from "../protocol.js";
import type { AgentExecutionContext, ModuleCallRequest, ModuleResponse } from "../protocol.js";

type PlanTodoModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
};

export type HostPlanTodoModuleClient = (request: PlanTodoModuleCall) => Promise<ModuleResponse>;

export type HostPlanTodoPortOptions = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
  uuid?: () => string;
};

/**
 * Session-bound plan/todo consumer backed by the host capability module.
 *
 * SessionRuntime remains the only durable owner. The sidecar only retains the
 * last validated projection so AgentLoop's synchronous capability view can
 * build prompts and gate tools without accessing host persistence directly.
 */
export type HostPlanTodoPort = PlanTodoPort & {
  initialize(sessionId: string, turnId: string): Promise<void>;
  refresh(sessionId: string, turnId: string): Promise<void>;
};

export function createHostPlanTodoPort(
  callModule: HostPlanTodoModuleClient,
  options: HostPlanTodoPortOptions,
): HostPlanTodoPort {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  const snapshots = new Map<string, PilotDeckPlanTodoStateSnapshot>();
  const handles = new Map<string, PilotDeckPlanTodoStateHandle>();
  let requestSequence = 0;

  const invoke = async (
    sessionId: string,
    turnId: string,
    method: string,
    payload: Record<string, unknown> = {},
  ): Promise<PilotDeckPlanTodoStateSnapshot> => {
    const response = await callModule({
      runId: options.runId,
      operationId: options.operationId,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      requestId: `plan-todo-${uuid()}-${++requestSequence}`,
      module: "capability",
      payload: {
        operation: "plan_todo",
        method,
        sessionId,
        turnId,
        ...payload,
      },
    });
    if (!response.ok) throw moduleFailure(response);
    const snapshot = parsePlanTodoSnapshot(response.payload?.snapshot);
    snapshots.set(sessionId, snapshot);
    return clonePlanTodoSnapshot(snapshot);
  };

  const handleFor = (sessionId: string): PilotDeckPlanTodoStateHandle => {
    const existing = handles.get(sessionId);
    if (existing) return existing;
    const snapshot = (): PilotDeckPlanTodoStateSnapshot => clonePlanTodoSnapshot(
      snapshots.get(sessionId) ?? createPlanTodoSnapshot(),
    );
    const handle: PilotDeckPlanTodoStateHandle = {
      getSnapshot: snapshot,
      async markPlanApproved(plan, mutation) {
        await invoke(sessionId, mutation.turnId, "mark_plan_approved", { plan });
      },
      async recordTodoWrite(markdown, todos, mutation) {
        const next = await invoke(sessionId, mutation.turnId, "record_todo_write", {
          markdown,
          todos,
          ...(mutation.reason ? { reason: mutation.reason } : {}),
        });
        return next.todos.map((todo) => ({ ...todo }));
      },
      async writeTodos(todos, mutation) {
        const next = await invoke(sessionId, mutation.turnId, "write_todos", {
          todos,
          ...(mutation.markdown !== undefined ? { markdown: mutation.markdown } : {}),
          ...(mutation.merge ? { merge: true } : {}),
          ...(mutation.reason ? { reason: mutation.reason } : {}),
        });
        return next.todos.map((todo) => ({ ...todo }));
      },
      async markToolProgressChanged(toolName, mutation) {
        await invoke(sessionId, mutation.turnId, "mark_tool_progress", { toolName });
      },
      buildPromptAddendum: () => buildPlanTodoPromptAddendum(snapshot()),
      blockingMessageFor: (toolName, isReadOnly) => planTodoBlockingMessageFor(snapshot(), toolName, isReadOnly),
    };
    handles.set(sessionId, handle);
    return handle;
  };

  return {
    forSession: handleFor,
    async initialize(sessionId, turnId) {
      await invoke(sessionId, turnId, "read");
    },
    async refresh(sessionId, turnId) {
      await invoke(sessionId, turnId, "read");
    },
  };
}

/** Refresh a sidecar plan/todo cache after the host has executed tools. */
export function createPlanTodoAwareToolPort(
  delegate: ToolPort,
  planTodo: Pick<HostPlanTodoPort, "refresh">,
): ToolPort {
  return {
    list: () => delegate.list(),
    async executeAll(calls, context, execution: AgentExecutionContext) {
      const results = await delegate.executeAll(calls, context, execution);
      await planTodo.refresh(context.sessionId, context.turnId);
      return results;
    },
  };
}

function moduleFailure(response: ModuleResponse): Error & { code?: string } {
  const error = new Error(String(response.error?.message ?? response.code ?? "Plan/todo module failed.")) as Error & { code?: string };
  error.code = response.code;
  return error;
}
