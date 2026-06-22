/**
 * Plan-mode tool constraints shared by AgentLoop (schema filtering) and
 * ToolRuntime (runtime interception). Keeping them in the tool layer avoids
 * a circular dependency between tool → agent.
 */

/**
 * Tools the model is allowed to see (and invoke) while plan mode is active.
 * Everything else is stripped from the model request and blocked at runtime.
 */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "ask_user_question",
  "todo_write",
  "exit_plan_mode",
  "read_skill",
  "structured_output",
  "agent",
  "bash",
  "write_file",
  "edit_file",
]);

/**
 * Description suffixes appended to restricted-but-visible tools so the model
 * understands the plan-mode constraints directly in the tool schema.
 */
export const PLAN_MODE_DESCRIPTION_SUFFIX: Record<string, string> = {
  bash: "\n\n[PLAN MODE] READ-ONLY commands only. Write/modify/delete commands will be rejected.",
  write_file: "\n\n[PLAN MODE] ONLY for .md files under .pilotdeck/plans/. All other writes will be rejected.",
  edit_file: "\n\n[PLAN MODE] ONLY for .md files under .pilotdeck/plans/. All other edits will be rejected.",
};

const PLAN_MODE_VIOLATION_HEADER = "[PLAN_MODE_VIOLATION]";

export function buildPlanModeViolationMessage(toolName: string): string {
  return [
    `${PLAN_MODE_VIOLATION_HEADER} Tool "${toolName}" is BLOCKED in plan mode.`,
    "",
    "You are in READ-ONLY plan mode. This tool cannot be executed.",
    "",
    "What you should do instead:",
    "1. Use read-only tools (read_file, grep, glob, bash with read-only commands) to explore",
    "2. Write your plan as markdown under .pilotdeck/plans/",
    "3. Call exit_plan_mode when your plan is ready",
    "",
    "Do NOT retry this tool. It will fail again.",
  ].join("\n");
}

export function buildPlanModeBashViolationMessage(command: string): string {
  const truncated = command.length > 120 ? command.slice(0, 120) + "…" : command;
  return [
    `${PLAN_MODE_VIOLATION_HEADER} bash command "${truncated}" is BLOCKED — write/modify commands are not allowed in plan mode.`,
    "",
    "In plan mode, bash is restricted to READ-ONLY commands only (ls, cat, git status, git log, git diff, pwd, find, head, wc, etc.).",
    "",
    "Rewrite your command as a read-only operation, or use read_file/grep/glob instead.",
  ].join("\n");
}

export function isPlanModeViolationText(text: unknown): boolean {
  return typeof text === "string" && text.includes(PLAN_MODE_VIOLATION_HEADER);
}
