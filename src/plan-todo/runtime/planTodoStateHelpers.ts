import type { PilotDeckPlanTodoStateSnapshot } from "../../tool/protocol/types.js";

export function clonePlanTodoSnapshot(
  snapshot: PilotDeckPlanTodoStateSnapshot,
): PilotDeckPlanTodoStateSnapshot {
  return structuredClone(snapshot);
}

export function buildPlanTodoPromptAddendum(
  state: PilotDeckPlanTodoStateSnapshot,
): string | undefined {
  if (!state.approvedPlan) return undefined;
  if (state.requiresInitialization) {
    return [
      "You are executing an approved plan.",
      "Before using any non-read-only tool, you MUST call `todo_write` with a markdown checklist derived from the approved plan.",
      "Represent completed items as `- [x]` and remaining items as `- [ ]`.",
    ].join("\n");
  }
  if (state.toolCallsSinceLastTodoWrite >= 10) {
    return [
      `You haven't updated the todo list in a while (${state.toolCallsSinceLastTodoWrite} tool calls since last update).`,
      "Consider calling `todo_write` to reflect your current progress.",
      "This is a gentle reminder - ignore if not applicable.",
    ].join(" ");
  }
  return undefined;
}

export function planTodoBlockingMessageFor(
  state: PilotDeckPlanTodoStateSnapshot,
  toolName: string,
  isReadOnly: boolean,
): string | undefined {
  if (toolName === "todo_write" || isReadOnly || !state.requiresInitialization) return undefined;
  return "An approved plan is active, but the todo list has not been initialized yet. Call `todo_write` first with a markdown checklist based on the approved plan, then retry this tool.";
}
