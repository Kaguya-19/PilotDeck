import type { SessionProjectionDriver } from "../../session/projection/SessionProjectionDriver.js";
import { requireSessionProjectionValue } from "../../session/projection/SessionProjection.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import type {
  PilotDeckPlanTodoMutationOptions,
  PilotDeckPlanTodoStateHandle,
  PilotDeckPlanTodoStateSnapshot,
  PilotDeckTodoItem,
  PilotDeckTodoUpdate,
} from "../../tool/protocol/types.js";
import {
  PLAN_TODO_PROJECTION_NAME,
  mergePlanTodos,
  replacePlanTodos,
} from "../projection/PlanTodoProjection.js";
import type { PlanTodoPort } from "./PlanTodoPort.js";
import {
  buildPlanTodoPromptAddendum,
  planTodoBlockingMessageFor,
} from "./planTodoStateHelpers.js";

export type NativePlanTodoRuntimeOptions = {
  sessionId: string;
  transcript: AgentTranscriptWriter;
  projections: SessionProjectionDriver;
};

/** Native provider backed exclusively by the SessionRuntime event projection. */
export class NativePlanTodoRuntime implements PlanTodoPort {
  private readonly handle: PilotDeckPlanTodoStateHandle;

  constructor(private readonly options: NativePlanTodoRuntimeOptions) {
    this.handle = {
      getSnapshot: () => this.snapshot(),
      markPlanApproved: (plan, mutation) => this.markPlanApproved(plan, mutation),
      recordTodoWrite: (markdown, todos, mutation) => this.recordTodoWrite(markdown, todos, mutation),
      writeTodos: (todos, mutation) => this.writeTodos(todos, mutation),
      markToolProgressChanged: (toolName, mutation) => this.markToolProgressChanged(toolName, mutation),
      buildPromptAddendum: () => buildPlanTodoPromptAddendum(this.snapshot()),
      blockingMessageFor: (toolName, isReadOnly) => planTodoBlockingMessageFor(this.snapshot(), toolName, isReadOnly),
    };
  }

  forSession(sessionId: string): PilotDeckPlanTodoStateHandle {
    if (sessionId !== this.options.sessionId) {
      throw new Error(`Plan/todo runtime belongs to ${this.options.sessionId}, not ${sessionId}.`);
    }
    return this.handle;
  }

  private snapshot(): PilotDeckPlanTodoStateSnapshot {
    return requireSessionProjectionValue<PilotDeckPlanTodoStateSnapshot>(
      this.options.projections.snapshot([PLAN_TODO_PROJECTION_NAME]),
      PLAN_TODO_PROJECTION_NAME,
    );
  }

  private async markPlanApproved(plan: string, mutation: PilotDeckPlanTodoMutationOptions): Promise<void> {
    await this.options.transcript.recordSessionEvent(this.options.sessionId, requireTurnId(mutation), {
      type: "plan_todo_plan_changed",
      plan: plan.trim() || null,
    });
  }

  private async recordTodoWrite(
    markdown: string,
    todos: PilotDeckTodoItem[],
    mutation: PilotDeckPlanTodoMutationOptions & { reason?: string },
  ): Promise<PilotDeckTodoItem[]> {
    const normalized = replacePlanTodos(todos);
    await this.recordTodoWriteEvent(normalized, {
      turnId: requireTurnId(mutation),
      mode: "markdown",
      merge: false,
      markdown,
      reason: mutation.reason,
    });
    return normalized;
  }

  private async writeTodos(
    todos: PilotDeckTodoUpdate[],
    mutation: PilotDeckPlanTodoMutationOptions & { markdown?: string; merge?: boolean; reason?: string },
  ): Promise<PilotDeckTodoItem[]> {
    const nextTodos = mutation.merge ? mergePlanTodos(this.snapshot().todos, todos) : replacePlanTodos(todos);
    await this.recordTodoWriteEvent(nextTodos, {
      turnId: requireTurnId(mutation),
      mode: "structured",
      merge: Boolean(mutation.merge),
      markdown: mutation.markdown,
      reason: mutation.reason,
    });
    return nextTodos;
  }

  private async markToolProgressChanged(
    toolName: string,
    mutation: PilotDeckPlanTodoMutationOptions,
  ): Promise<void> {
    const state = this.snapshot();
    if (!state.approvedPlan || state.requiresInitialization || toolName === "todo_write") return;
    await this.options.transcript.recordSessionEvent(this.options.sessionId, requireTurnId(mutation), {
      type: "plan_todo_progressed",
      toolName,
    });
  }

  private async recordTodoWriteEvent(
    todos: PilotDeckTodoItem[],
    input: {
      turnId: string;
      mode: "markdown" | "structured";
      merge: boolean;
      markdown?: string;
      reason?: string;
    },
  ): Promise<void> {
    await this.options.transcript.recordSessionEvent(this.options.sessionId, input.turnId, {
      type: "plan_todo_written",
      mode: input.mode,
      merge: input.merge,
      ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      todos: todos.map((todo) => ({ ...todo })),
    });
  }
}

export function createNativePlanTodoRuntime(options: NativePlanTodoRuntimeOptions): NativePlanTodoRuntime {
  return new NativePlanTodoRuntime(options);
}

function requireTurnId(mutation: PilotDeckPlanTodoMutationOptions): string {
  if (!mutation.turnId.trim()) throw new Error("Plan/todo mutation requires a turn id.");
  return mutation.turnId;
}
