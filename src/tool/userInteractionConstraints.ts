import type { PilotDeckToolDefinition } from "./protocol/types.js";

const PROMPT_DEPENDENT_TOOL_NAMES = new Set([
  "enter_plan_mode",
]);

export function requiresPromptCapability(
  tool: PilotDeckToolDefinition,
  input: unknown,
): boolean {
  if (PROMPT_DEPENDENT_TOOL_NAMES.has(tool.name)) {
    return true;
  }
  try {
    return tool.requiresUserInteraction?.(input as never) === true;
  } catch {
    return false;
  }
}
