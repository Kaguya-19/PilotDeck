import type { PilotDeckToolErrorCode } from "../protocol/errors.js";

export type ToolErrorFailureClass =
  | "fix_input"
  | "reduce_scope"
  | "switch_tool"
  | "ask_user"
  | "environment_issue"
  | "retry_later";

export type ToolErrorRecoveryAdvice = {
  summary: string;
  failureClass: ToolErrorFailureClass;
  nextActions: string[];
  avoidRetryReason?: string;
  salientEvidence?: string[];
};

export type ToolErrorRecoveryResult = {
  message: string;
  advice: ToolErrorRecoveryAdvice;
};

export type ToolErrorEnrichmentContext = {
  cwd: string;
  permissionMode: string;
  toolName: string;
  toolInput?: unknown;
  repeatedFailure?: boolean;
  previousFailureCount?: number;
};

export type ToolErrorAdvicePatch = Partial<ToolErrorRecoveryAdvice> & {
  priorityNextActions?: string[];
};

export type PilotDeckCustomErrorHintInput = {
  code: PilotDeckToolErrorCode;
  toolName: string;
  message: string;
  details?: Record<string, unknown>;
  toolInput?: unknown;
};

export type PilotDeckCustomErrorHint = (
  input: PilotDeckCustomErrorHintInput,
) => string | ToolErrorAdvicePatch | undefined;

export type ToolErrorEnricher = {
  name: string;
  matches: (code: PilotDeckToolErrorCode, details?: Record<string, unknown>) => boolean;
  enrich: (
    code: PilotDeckToolErrorCode,
    rawMessage: string,
    context: ToolErrorEnrichmentContext,
    details?: Record<string, unknown>,
  ) => string | ToolErrorAdvicePatch | undefined;
};

export class ToolErrorEnricherRegistry {
  private enrichers: ToolErrorEnricher[] = [];

  register(enricher: ToolErrorEnricher): void {
    this.enrichers.push(enricher);
  }

  unregister(name: string): void {
    this.enrichers = this.enrichers.filter((e) => e.name !== name);
  }

  recover(
    code: PilotDeckToolErrorCode,
    toolName: string,
    rawMessage: string,
    context: ToolErrorEnrichmentContext,
    details?: Record<string, unknown>,
  ): ToolErrorRecoveryResult {
    const advice = this.buildAdvice(code, toolName, rawMessage, context, details);
    return {
      message: formatRecoveryMessage(code, toolName, advice),
      advice,
    };
  }

  enrich(
    code: PilotDeckToolErrorCode,
    toolName: string,
    rawMessage: string,
    context: ToolErrorEnrichmentContext,
    details?: Record<string, unknown>,
  ): string {
    return this.recover(code, toolName, rawMessage, context, details).message;
  }

  buildAdvice(
    code: PilotDeckToolErrorCode,
    toolName: string,
    rawMessage: string,
    context: ToolErrorEnrichmentContext,
    details?: Record<string, unknown>,
  ): ToolErrorRecoveryAdvice {
    let advice = createBaseAdvice(code, toolName, rawMessage, context, details);
    for (const enricher of this.enrichers) {
      if (!enricher.matches(code, details)) {
        continue;
      }
      const patch = enricher.enrich(code, rawMessage, context, details);
      advice = mergeAdvice(advice, patch);
    }

    if (context.repeatedFailure) {
      advice = mergeAdvice(advice, {
        avoidRetryReason: advice.avoidRetryReason
          ?? "The same tool failure pattern has repeated. Retrying unchanged is likely to fail again.",
        nextActions: [
          "Change at least one of: tool, path, parameters, scope, permission path, or explain the blocker in text.",
        ],
      });
    }

    return {
      ...advice,
      nextActions: uniqueStrings(advice.nextActions).slice(0, 3),
      salientEvidence: uniqueStrings(advice.salientEvidence ?? []).slice(0, 2),
    };
  }
}

function createBaseAdvice(
  code: PilotDeckToolErrorCode,
  toolName: string,
  rawMessage: string,
  context: ToolErrorEnrichmentContext,
  details?: Record<string, unknown>,
): ToolErrorRecoveryAdvice {
  const evidence = extractSalientEvidence(rawMessage, details);
  const summary = summarizeError(code, toolName, rawMessage, evidence);
  const failureClass = classifyError(code, toolName, rawMessage, details);
  const nextActions = baseNextActions(code, toolName, context);
  const advice: ToolErrorRecoveryAdvice = {
    summary,
    failureClass,
    nextActions,
    salientEvidence: evidence,
  };
  const avoidRetryReason = defaultAvoidRetryReason(code);
  if (avoidRetryReason) {
    advice.avoidRetryReason = avoidRetryReason;
  }
  return advice;
}

function formatRecoveryMessage(
  code: PilotDeckToolErrorCode,
  toolName: string,
  advice: ToolErrorRecoveryAdvice,
): string {
  const lines = [
    `TOOL_ERROR[${code}][${toolName}][${advice.failureClass}]`,
    `Summary: ${advice.summary}`,
  ];

  if (advice.salientEvidence && advice.salientEvidence.length > 0) {
    lines.push("Evidence:");
    for (const evidence of advice.salientEvidence) {
      lines.push(`- ${evidence}`);
    }
  }

  if (advice.avoidRetryReason) {
    lines.push(`Do not retry unchanged: ${advice.avoidRetryReason}`);
  }

  if (advice.nextActions.length > 0) {
    lines.push("Next actions:");
    advice.nextActions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action}`);
    });
  }

  return lines.join("\n");
}

function summarizeError(
  code: PilotDeckToolErrorCode,
  toolName: string,
  rawMessage: string,
  evidence: string[],
): string {
  if (code === "invalid_tool_input") {
    return `The ${toolName} input did not match the tool schema.`;
  }
  if (code === "tool_not_found") {
    return `The model emitted a tool name that is not registered: ${toolName}.`;
  }
  if (code === "plan_mode_violation") {
    return `The ${toolName} call is not allowed while the agent is in plan mode.`;
  }
  if (evidence.length > 0) {
    return trimSentence(evidence[0]);
  }
  return trimSentence(firstMeaningfulLine(rawMessage) || `${toolName} failed with ${code}.`);
}

function classifyError(
  code: PilotDeckToolErrorCode,
  toolName: string,
  rawMessage: string,
  details?: Record<string, unknown>,
): ToolErrorFailureClass {
  if (code === "invalid_tool_input" || code === "file_not_found" || code === "file_conflict") {
    return "fix_input";
  }
  if (code === "result_too_large") {
    return "reduce_scope";
  }
  if (code === "tool_not_found" || code === "unsupported_tool" || code === "plan_mode_violation") {
    return "switch_tool";
  }
  if (
    code === "permission_denied" ||
    code === "permission_required" ||
    code === "permission_cancelled" ||
    code === "path_not_allowed" ||
    code === "setup_required"
  ) {
    return "ask_user";
  }
  if (code === "tool_timeout" || code === "tool_aborted") {
    return "retry_later";
  }

  if (toolName === "bash" || code === "tool_execution_failed") {
    const haystack = errorHaystack(rawMessage, details);
    if (/Permission denied|EACCES|EPERM/i.test(haystack)) return "ask_user";
    if (/No such file or directory|ENOENT|NameError|ReferenceError|SyntaxError|TypeError|ModuleNotFoundError|Cannot find module/i.test(haystack)) {
      return "fix_input";
    }
    if (/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(haystack)) return "retry_later";
    if (/EADDRINUSE|address already in use|port .*already in use/i.test(haystack)) return "environment_issue";
    if (/command not found|ECONNREFUSED|connection refused|No space left on device|disk quota/i.test(haystack)) {
      return "environment_issue";
    }
  }

  return "environment_issue";
}

function baseNextActions(
  code: PilotDeckToolErrorCode,
  toolName: string,
  context: ToolErrorEnrichmentContext,
): string[] {
  switch (code) {
    case "invalid_tool_input":
      return ["Fix the tool arguments to match the schema before calling the tool again."];
    case "tool_not_found":
      return [
        "Use a registered canonical tool name from the current tool list.",
        "If this was intended as an alias, use the configured canonical tool instead.",
      ];
    case "plan_mode_violation":
      return [
        "Do not retry this write/action tool while in plan mode.",
        "Use read-only tools or respond with a plan; request a mode change only if the user wants execution.",
      ];
    case "permission_required":
      return ["Pause tool execution and ask the user for approval with a concise reason."];
    case "permission_denied":
    case "permission_cancelled":
      return ["Do not retry the same action. Choose a lower-privilege alternative or ask the user how to proceed."];
    case "path_not_allowed":
      return [
        `Use a path inside the workspace root: ${context.cwd}.`,
        "If the outside path is essential, explain why and ask the user for access.",
      ];
    case "file_not_found":
      return ["Verify the path with glob/grep/read-only inspection before retrying."];
    case "result_too_large":
      return ["Reduce the requested scope and fetch a smaller result."];
    case "tool_timeout":
      return ["Break the operation into smaller steps or retry with a narrower scope."];
    case "setup_required":
      return ["Tell the user what configuration is missing and wait for it to be provided."];
    case "unsupported_tool":
      return ["Switch to another available tool or explain that this capability is not configured."];
    default:
      return ["Inspect the evidence, change the approach, then retry only with corrected inputs."];
  }
}

function defaultAvoidRetryReason(code: PilotDeckToolErrorCode): string | undefined {
  switch (code) {
    case "permission_required":
      return "This tool requires user approval; repeated calls cannot grant approval.";
    case "permission_denied":
      return "The action was denied by policy or a hook.";
    case "permission_cancelled":
      return "The user cancelled this action.";
    case "path_not_allowed":
      return "The path policy will continue blocking this location.";
    case "setup_required":
      return "The missing setup must be completed outside this tool call.";
    case "plan_mode_violation":
      return "Plan mode blocks this class of tool until execution mode is restored.";
    default:
      return undefined;
  }
}

function mergeAdvice(
  advice: ToolErrorRecoveryAdvice,
  patch: string | ToolErrorAdvicePatch | undefined,
): ToolErrorRecoveryAdvice {
  if (!patch) {
    return advice;
  }
  if (typeof patch === "string") {
    return {
      ...advice,
      nextActions: [...advice.nextActions, ...actionsFromText(patch)],
    };
  }
  return {
    summary: patch.summary ?? advice.summary,
    failureClass: patch.failureClass ?? advice.failureClass,
    nextActions: [
      ...(patch.priorityNextActions ?? []),
      ...advice.nextActions,
      ...(patch.nextActions ?? []),
    ],
    avoidRetryReason: patch.avoidRetryReason ?? advice.avoidRetryReason,
    salientEvidence: [
      ...(advice.salientEvidence ?? []),
      ...(patch.salientEvidence ?? []),
    ],
  };
}

function actionsFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Built-in enrichers
// ---------------------------------------------------------------------------

const validationIssueEnricher: ToolErrorEnricher = {
  name: "builtin:validation_issues",
  matches: (code, details) => code === "invalid_tool_input" && Array.isArray(details?.issues),
  enrich: (_code, _msg, _ctx, details) => ({
    failureClass: "fix_input",
    nextActions: validationIssueActions(details?.issues),
  }),
};

const fileToolPlaybookEnricher: ToolErrorEnricher = {
  name: "builtin:file_tool_playbook",
  matches: (_code, _details) => true,
  enrich: (_code, rawMessage, ctx) => {
    if (ctx.toolName === "read_file") {
      return {
        nextActions: [
          "For large text files, retry with offset and limit to read a smaller range.",
          "For PDFs or notebooks, request only the needed pages or cells.",
          "If the file type is unsupported, use a more appropriate tool or ask the user for a different representation.",
        ],
      };
    }
    if (ctx.toolName === "write_file" || ctx.toolName === "edit_file" || ctx.toolName === "edit_notebook") {
      return {
        nextActions: [
          "Create or edit a smaller valid chunk first, then continue with focused follow-up edits.",
          "Preserve required fields such as path/content and keep each call comfortably below the output budget.",
          "Read the current file state before retrying if the previous write/edit may have partially changed context.",
        ],
      };
    }
    if (ctx.toolName === "grep") {
      return {
        failureClass: rawMessage.includes("too large") ? "reduce_scope" : undefined,
        nextActions: [
          "Narrow the path or pattern before searching again.",
          "Use head_limit to cap results when exploring broad matches.",
        ],
      };
    }
    if (ctx.toolName === "glob") {
      return {
        nextActions: [
          "Narrow the glob pattern or search path before retrying.",
          "Use grep only after identifying likely files.",
        ],
      };
    }
    return undefined;
  },
};

const permissionEnricher: ToolErrorEnricher = {
  name: "builtin:permission",
  matches: (code) =>
    code === "permission_denied" ||
    code === "permission_required" ||
    code === "permission_cancelled",
  enrich: (code, _msg, ctx) => {
    if (code === "permission_required") {
      return {
        failureClass: "ask_user",
        avoidRetryReason: "The runtime is waiting for user approval; another identical tool call cannot approve itself.",
        nextActions: [
          "Explain the intended action and wait for user confirmation.",
          `Current permission mode is "${ctx.permissionMode}".`,
        ],
      };
    }
    return {
      failureClass: "ask_user",
      avoidRetryReason: "The action was rejected or cancelled.",
      nextActions: [
        "Respect the denial and do not retry unchanged.",
        "Use a safer alternative or ask the user for a different path forward.",
      ],
    };
  },
};

const pathNotAllowedEnricher: ToolErrorEnricher = {
  name: "builtin:path_not_allowed",
  matches: (code) => code === "path_not_allowed",
  enrich: (_code, rawMessage, ctx) => {
    const actions = rawMessage.includes("not allowed by default")
      ? [
          "Protected directories such as .git, node_modules, and dist are write-restricted by default.",
          "Use a different workspace path, or ask the user to explicitly allow this path.",
        ]
      : [
          "All file operations must target paths within the workspace root.",
          "Use relative paths or absolute paths under the workspace root.",
        ];
    return {
      failureClass: "ask_user",
      avoidRetryReason: "The path policy will continue blocking this location.",
      nextActions: [`Workspace root: ${ctx.cwd}.`, ...actions],
    };
  },
};

const resultTooLargeEnricher: ToolErrorEnricher = {
  name: "builtin:result_too_large",
  matches: (code) => code === "result_too_large",
  enrich: (_code, _msg, ctx) => {
    if (ctx.toolName === "read_file") {
      return {
        failureClass: "reduce_scope",
        nextActions: [
          "Use offset and limit to read a smaller portion of the file.",
          "If you need structure first, read a small header or targeted range.",
        ],
      };
    }
    if (ctx.toolName === "grep") {
      return {
        failureClass: "reduce_scope",
        nextActions: [
          "Use head_limit to cap results.",
          "Narrow the search with a more specific pattern or path.",
        ],
      };
    }
    return {
      failureClass: "reduce_scope",
      nextActions: ["Limit the scope of the operation before retrying."],
    };
  },
};

const setupRequiredEnricher: ToolErrorEnricher = {
  name: "builtin:setup_required",
  matches: (code) => code === "setup_required",
  enrich: () => ({
    failureClass: "ask_user",
    avoidRetryReason: "The missing setup must be completed before this tool can work.",
    nextActions: [
      "Do not retry immediately.",
      "Tell the user which setting or credential is missing.",
    ],
  }),
};

const toolNotFoundEnricher: ToolErrorEnricher = {
  name: "builtin:tool_not_found",
  matches: (code) => code === "tool_not_found",
  enrich: () => ({
    failureClass: "switch_tool",
    avoidRetryReason: "The emitted tool name is not registered.",
    nextActions: [
      "Use a canonical tool name from the current tool list.",
      "If you meant a similar tool, call that registered tool directly.",
    ],
  }),
};

const bashPatternEnricher: ToolErrorEnricher = {
  name: "builtin:bash_patterns",
  matches: (code, details) =>
    code === "tool_execution_failed" && hasExecutionText(details),
  enrich: (_code, rawMessage, ctx, details) => {
    const haystack = errorHaystack(rawMessage, details);
    if (/Permission denied|EACCES|EPERM/i.test(haystack)) {
      return {
        failureClass: "ask_user",
        nextActions: [
          "Try a path or command that does not require elevated privileges.",
          "If elevated access is essential, explain why and ask the user.",
        ],
      };
    }
    if (/command not found/i.test(haystack)) {
      return {
        failureClass: "environment_issue",
        nextActions: [
          "Use an installed alternative or inspect the project scripts for the intended command.",
          "Ask the user to install the missing command if no alternative exists.",
        ],
      };
    }
    if (/No such file or directory|ENOENT/i.test(haystack)) {
      return {
        failureClass: "fix_input",
        nextActions: [
          "Verify the path with glob/read_file/ls before retrying.",
          "Retry only after correcting the missing file or directory path.",
        ],
      };
    }
    if (/ModuleNotFoundError|Cannot find module/i.test(haystack)) {
      return {
        failureClass: "environment_issue",
        nextActions: [
          "Inspect project dependencies and package scripts before rerunning.",
          "Use the existing package manager workflow, or ask the user before installing new dependencies.",
        ],
      };
    }
    if (/NameError|ReferenceError|SyntaxError|TypeError/i.test(haystack)) {
      return {
        failureClass: "fix_input",
        nextActions: [
          "Edit the code or script named in the traceback before rerunning the command.",
          "Use the traceback line numbers as the next inspection targets.",
        ],
      };
    }
    if (/EADDRINUSE|address already in use|port .*already in use/i.test(haystack)) {
      return {
        failureClass: "environment_issue",
        nextActions: [
          "Choose a different port or stop the existing process before retrying.",
          "Inspect running processes only if needed.",
        ],
      };
    }
    if (/AssertionError|expected .* actual|tests? failed|FAIL|(?:^|\s)x\s/i.test(haystack)) {
      return {
        failureClass: "fix_input",
        nextActions: [
          "Use the failing assertion or test name to inspect the relevant code.",
          "Change the implementation or test setup before rerunning the same test.",
        ],
      };
    }
    if (/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(haystack)) {
      return {
        failureClass: "retry_later",
        nextActions: [
          "Reduce the command scope or split it into smaller commands.",
          "If this is an external service, verify connectivity before retrying.",
        ],
      };
    }
    if (/ECONNREFUSED|connection refused/i.test(haystack)) {
      return {
        failureClass: "environment_issue",
        nextActions: [
          "Verify the target service is running and the host/port are correct.",
          "Start the service only if that is part of the user's request.",
        ],
      };
    }
    if (/No space left on device|disk quota/i.test(haystack)) {
      return {
        failureClass: "environment_issue",
        avoidRetryReason: "The filesystem lacks enough free space for the same operation.",
        nextActions: [
          "Ask the user to free space or choose a smaller output.",
          "Avoid generating additional large files until space is available.",
        ],
      };
    }
    if (ctx.toolName === "bash") {
      return {
        nextActions: [
          "Do not rerun the same command blindly.",
          "Use the command output to adjust the command, environment, or target file first.",
        ],
      };
    }
    return undefined;
  },
};

function createCustomHintEnricher(hints: PilotDeckCustomErrorHint[]): ToolErrorEnricher {
  return {
    name: "custom:error_hints",
    matches: () => hints.length > 0,
    enrich: (code, rawMessage, ctx, details) => {
      let patch: string | ToolErrorAdvicePatch | undefined;
      for (const hint of hints) {
        let next: string | ToolErrorAdvicePatch | undefined;
        try {
          next = hint({
            code,
            toolName: ctx.toolName,
            message: rawMessage,
            details,
            toolInput: ctx.toolInput,
          });
        } catch {
          next = undefined;
        }
        patch = mergeAdvicePatch(patch, next);
      }
      return prioritizeCustomHintActions(patch);
    },
  };
}

export function createDefaultToolErrorEnricherRegistry(
  customHints: PilotDeckCustomErrorHint[] = [],
): ToolErrorEnricherRegistry {
  const registry = new ToolErrorEnricherRegistry();
  registry.register(validationIssueEnricher);
  registry.register(fileToolPlaybookEnricher);
  registry.register(permissionEnricher);
  registry.register(pathNotAllowedEnricher);
  registry.register(resultTooLargeEnricher);
  registry.register(setupRequiredEnricher);
  registry.register(toolNotFoundEnricher);
  registry.register(bashPatternEnricher);
  if (customHints.length > 0) {
    registry.register(createCustomHintEnricher(customHints));
  }
  return registry;
}

function mergeAdvicePatch(
  current: string | ToolErrorAdvicePatch | undefined,
  next: string | ToolErrorAdvicePatch | undefined,
): string | ToolErrorAdvicePatch | undefined {
  if (!current) return next;
  if (!next) return current;
  const currentPatch = typeof current === "string" ? { nextActions: actionsFromText(current) } : current;
  const nextPatch = typeof next === "string" ? { nextActions: actionsFromText(next) } : next;
  return {
    summary: nextPatch.summary ?? currentPatch.summary,
    failureClass: nextPatch.failureClass ?? currentPatch.failureClass,
    nextActions: [
      ...(currentPatch.nextActions ?? []),
      ...(nextPatch.nextActions ?? []),
    ],
    priorityNextActions: [
      ...(currentPatch.priorityNextActions ?? []),
      ...(nextPatch.priorityNextActions ?? []),
    ],
    avoidRetryReason: nextPatch.avoidRetryReason ?? currentPatch.avoidRetryReason,
    salientEvidence: [
      ...(currentPatch.salientEvidence ?? []),
      ...(nextPatch.salientEvidence ?? []),
    ],
  };
}

function prioritizeCustomHintActions(
  patch: string | ToolErrorAdvicePatch | undefined,
): string | ToolErrorAdvicePatch | undefined {
  if (!patch) {
    return undefined;
  }
  if (typeof patch === "string") {
    return { priorityNextActions: actionsFromText(patch) };
  }
  if (!patch.nextActions || patch.nextActions.length === 0) {
    return patch;
  }
  return {
    ...patch,
    nextActions: undefined,
    priorityNextActions: [
      ...(patch.priorityNextActions ?? []),
      ...patch.nextActions,
    ],
  };
}

function validationIssueActions(issues: unknown): string[] {
  if (!Array.isArray(issues)) {
    return [];
  }
  const actions: string[] = [];
  for (const issue of issues) {
    if (!isRecord(issue)) continue;
    const path = typeof issue.path === "string" ? issue.path.replace(/^\$\.?/, "") : "input";
    const code = issue.code;
    if (code === "required") {
      actions.push(`Provide the required parameter \`${path}\`.`);
    } else if (code === "unknown_property") {
      actions.push(`Remove the unexpected parameter \`${path}\`.`);
    } else if (code === "invalid_type") {
      actions.push(`Change \`${path}\` to the schema's expected type.`);
    } else if (code === "invalid_enum") {
      actions.push(`Use one of the allowed values for \`${path}\`.`);
    }
  }
  return actions;
}

function extractSalientEvidence(
  rawMessage: string,
  details?: Record<string, unknown>,
): string[] {
  const haystack = errorHaystack(rawMessage, details);
  const lines = haystack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const priority = lines.filter((line) =>
    /Traceback|Error:|NameError|ReferenceError|SyntaxError|TypeError|ModuleNotFoundError|Cannot find module|command not found|No such file|Permission denied|ENOENT|EACCES|EPERM|EADDRINUSE|ECONNREFUSED|timed? ?out|AssertionError|FAIL/i
      .test(line),
  );
  const source = priority.length > 0 ? priority : lines;
  return uniqueStrings(source.map(trimEvidenceLine)).slice(-2);
}

function errorHaystack(rawMessage: string, details?: Record<string, unknown>): string {
  const pieces = [rawMessage];
  const nested = details && isRecord(details.details) ? details.details : undefined;
  for (const source of [details, nested]) {
    if (!source) continue;
    for (const key of ["stderr", "stdout", "message", "command", "exitCode"]) {
      const value = source[key];
      if (typeof value === "string" || typeof value === "number") {
        pieces.push(String(value));
      }
    }
  }
  return pieces.filter(Boolean).join("\n");
}

function hasExecutionText(details?: Record<string, unknown>): boolean {
  if (!details) return true;
  const nested = isRecord(details.details) ? details.details : undefined;
  return Boolean(
    details.stderr ||
    details.stdout ||
    details.details ||
    nested?.stderr ||
    nested?.stdout,
  );
}

function firstMeaningfulLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function trimSentence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 220) {
    return trimmed;
  }
  return `${trimmed.slice(0, 217).trimEnd()}...`;
}

function trimEvidenceLine(value: string): string {
  return trimSentence(value.replace(/\s+/g, " "));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
