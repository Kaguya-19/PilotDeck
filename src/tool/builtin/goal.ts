import { GoalConflictError } from "../../goal/protocol/errors.js";
import type { GoalSessionPort, GoalSnapshot } from "../../goal/protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition, PilotDeckToolExecutionOutput } from "../protocol/types.js";

export type GetGoalInput = Record<string, never>;
export type CreateGoalInput = { objective: string; max_goal_rounds?: number; id?: string };
export type UpdateGoalInput = {
  action?: "edit" | "pause" | "resume" | "complete" | "block" | "clear";
  expected_revision?: number;
  objective?: string;
  blocked_reason?: string;
  max_goal_rounds?: number;
};

function requireGoal(context: { goal?: GoalSessionPort }): GoalSessionPort {
  if (!context.goal) throw new PilotDeckToolRuntimeError("unsupported_tool", "Goal tools require a session-scoped goal provider.");
  return context.goal;
}

function output(goal: GoalSnapshot | null, label: string): PilotDeckToolExecutionOutput {
  return { content: [{ type: "json", value: goal }], data: goal, metadata: { operation: label, revision: goal?.revision ?? null } };
}

function mapGoalError(error: unknown): never {
  if (error instanceof GoalConflictError) {
    throw new PilotDeckToolRuntimeError("tool_execution_failed", error.message, {
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision,
    });
  }
  throw error;
}

export function createGetGoalTool(): PilotDeckToolDefinition<GetGoalInput> {
  return {
    name: "get_goal",
    description: "Read the current durable goal for this session.",
    kind: "session",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (_input, context) => output(requireGoal(context).getSnapshot().goal, "get"),
  };
}

export function createCreateGoalTool(): PilotDeckToolDefinition<CreateGoalInput> {
  return {
    name: "create_goal",
    description: "Create the session's durable goal. Only one goal can exist at a time.",
    kind: "session",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The outcome this session is pursuing." },
        max_goal_rounds: { type: "number", description: "Optional maximum number of continuation rounds." },
        id: { type: "string", description: "Optional stable goal identifier." },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      try {
        return output(await requireGoal(context).create(input.objective, {
          ...(input.max_goal_rounds !== undefined ? { maxGoalRounds: input.max_goal_rounds } : {}),
          ...(input.id !== undefined ? { id: input.id } : {}),
          turnId: context.turnId,
        }), "create");
      } catch (error) { return mapGoalError(error); }
    },
  };
}

export function createUpdateGoalTool(): PilotDeckToolDefinition<UpdateGoalInput> {
  return {
    name: "update_goal",
    description: "Edit or transition the session's durable goal using an optional expected revision for CAS safety.",
    kind: "session",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["edit", "pause", "resume", "complete", "block", "clear"] },
        expected_revision: { type: "number" },
        objective: { type: "string" },
        blocked_reason: { type: "string" },
        max_goal_rounds: { type: "number" },
      },
      additionalProperties: false,
    },
    isReadOnly: (input) => input.action === "edit" && input.objective === undefined && input.blocked_reason === undefined && input.max_goal_rounds === undefined,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      try {
        return output(await requireGoal(context).update({
          turnId: context.turnId,
          ...(input.action !== undefined ? { action: input.action } : {}),
          ...(input.expected_revision !== undefined ? { expectedRevision: input.expected_revision } : {}),
          ...(input.objective !== undefined ? { objective: input.objective } : {}),
          ...(input.blocked_reason !== undefined ? { blockedReason: input.blocked_reason } : {}),
          ...(input.max_goal_rounds !== undefined ? { maxGoalRounds: input.max_goal_rounds } : {}),
        }), "update");
      } catch (error) { return mapGoalError(error); }
    },
  };
}

export function createGoalTools() {
  return [createGetGoalTool(), createCreateGoalTool(), createUpdateGoalTool()];
}
