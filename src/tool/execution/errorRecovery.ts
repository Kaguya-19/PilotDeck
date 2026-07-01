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

export function buildToolErrorRecovery(options: {
  code: PilotDeckToolErrorCode;
  toolName: string;
  message: string;
  cwd: string;
  permissionMode: string;
  details?: Record<string, unknown>;
}): ToolErrorRecoveryResult {
  const evidence = extractSalientEvidence(options.message, options.details);
  const advice: ToolErrorRecoveryAdvice = {
    summary: summarizeError(options.code, options.toolName, options.message, evidence),
    failureClass: classifyError(options.code, options.toolName, options.message, options.details),
    nextActions: baseNextActions(options.code, options.toolName, {
      cwd: options.cwd,
      permissionMode: options.permissionMode,
    }, options.details),
    salientEvidence: evidence,
  };
  const avoidRetryReason = defaultAvoidRetryReason(options.code);
  if (avoidRetryReason) {
    advice.avoidRetryReason = avoidRetryReason;
  }

  advice.nextActions = uniqueStrings(advice.nextActions).slice(0, 3);
  advice.salientEvidence = uniqueStrings(advice.salientEvidence ?? []).slice(0, 2);

  return {
    message: formatRecoveryMessage(options.code, options.toolName, advice),
    advice,
  };
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
  if (code === "ask_mode_violation") {
    return `The ${toolName} call is not allowed while the agent is in ask mode.`;
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
  if (toolName === "web_fetch") {
    const webFetchClass = classifyWebFetchError(code, rawMessage, details);
    if (webFetchClass) {
      return webFetchClass;
    }
  }

  if (code === "invalid_tool_input" || code === "file_not_found" || code === "file_conflict") {
    return "fix_input";
  }
  if (code === "result_too_large") {
    return "reduce_scope";
  }
  if (
    code === "tool_not_found" ||
    code === "unsupported_tool" ||
    code === "plan_mode_violation" ||
    code === "ask_mode_violation"
  ) {
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

function classifyWebFetchError(
  code: PilotDeckToolErrorCode,
  rawMessage: string,
  details?: Record<string, unknown>,
): ToolErrorFailureClass | undefined {
  if (code === "invalid_tool_input") {
    return "fix_input";
  }

  const stage = readString(details, "stage");
  const status = readNumber(details, "status");
  if (stage === "http_fetch") {
    if (status === 401 || status === 403) {
      return "ask_user";
    }
    if (status === 404 || status === 410) {
      return "fix_input";
    }
    if (
      status === 408 ||
      status === 429 ||
      (typeof status === "number" && status >= 500) ||
      /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT|network timeout/i.test(rawMessage)
    ) {
      return "retry_later";
    }
    return "environment_issue";
  }

  if (stage === "secondary_model") {
    return "retry_later";
  }

  return undefined;
}

function baseNextActions(
  code: PilotDeckToolErrorCode,
  toolName: string,
  context: { cwd: string; permissionMode: string },
  details?: Record<string, unknown>,
): string[] {
  if (toolName === "web_fetch") {
    const actions = webFetchNextActions(code, details);
    if (actions.length > 0) {
      return actions;
    }
  }

  switch (code) {
    case "invalid_tool_input":
      if (toolName === "write_file" || toolName === "edit_file") {
        return [
          "Fix the tool arguments to match the schema before calling the tool again.",
          "Create or edit a smaller valid chunk first, then continue with focused follow-up edits.",
        ];
      }
      return ["Fix the tool arguments to match the schema before calling the tool again."];
    case "tool_not_found":
      return ["Use a registered canonical tool name from the current tool list."];
    case "plan_mode_violation":
      return [
        "Do not retry this write/action tool while in plan mode.",
        "Use read-only tools or respond with a plan; request a mode change only if the user wants execution.",
      ];
    case "ask_mode_violation":
      return [
        "Do not retry this write/action tool while in ask mode.",
        "Use read-only tools or ask the user to change mode if they want execution.",
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
      return [`Inspect the evidence, change the approach, then retry only with corrected inputs. Current permission mode: ${context.permissionMode}.`];
  }
}

function webFetchNextActions(
  code: PilotDeckToolErrorCode,
  details?: Record<string, unknown>,
): string[] {
  if (code === "invalid_tool_input") {
    return [];
  }

  const stage = readString(details, "stage");
  const status = readNumber(details, "status");
  if (stage === "http_fetch") {
    if (status === 401 || status === 403) {
      return [
        "The site denied access or requires authorization; ask the user for credentials/permission or use a public source.",
        "Do not summarize the error page as if it were the requested content.",
      ];
    }
    if (status === 404 || status === 410) {
      return [
        "Verify the URL or search for an updated URL before retrying.",
        "Use another source if the original page has moved or was removed.",
      ];
    }
    if (status === 408 || status === 429 || (typeof status === "number" && status >= 500)) {
      return [
        "Retry later, reduce request frequency, or use another source.",
        "Do not treat the HTTP error page as page content.",
      ];
    }
    return [
      "Inspect the HTTP status and try a different source or access path before retrying.",
      "Do not treat the HTTP error page as page content.",
    ];
  }

  if (stage === "secondary_model") {
    return [
      'Retry with mode "raw" to inspect the fetched markdown without secondary model processing.',
      "Try the LLM fetch again later if the secondary model/provider was unavailable.",
    ];
  }

  return [];
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
    case "ask_mode_violation":
      return "Ask mode blocks this class of tool until execution mode is restored.";
    default:
      return undefined;
  }
}

function extractSalientEvidence(rawMessage: string, details?: Record<string, unknown>): string[] {
  const lines = rawMessage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^TOOL_ERROR\[/i.test(line));
  const evidence = lines.slice(0, 2);
  const status = readNumber(details, "status");
  if (typeof status === "number") {
    const statusText = readString(details, "statusText");
    evidence.push(statusText ? `HTTP status: ${status} ${statusText}` : `HTTP status: ${status}`);
  }
  const retryAfterMs = readNumber(details, "retryAfterMs");
  if (typeof retryAfterMs === "number") {
    evidence.push(`Retry-After: ${retryAfterMs}ms`);
  }
  const bodyPreview = readString(details, "bodyPreview");
  if (bodyPreview) {
    evidence.push(`Body preview: ${bodyPreview}`);
  }
  const userHint = readString(details, "userHint");
  if (userHint) {
    evidence.push(`Provider hint: ${userHint}`);
  }
  const stderr = readString(details, "stderr");
  if (stderr) {
    evidence.push(firstMeaningfulLine(stderr));
  }
  return uniqueStrings(evidence.filter(Boolean).map(trimSentence));
}

function errorHaystack(rawMessage: string, details?: Record<string, unknown>): string {
  return [
    rawMessage,
    readString(details, "stderr"),
    readString(details, "stdout"),
    readString(details, "message"),
  ].filter(Boolean).join("\n");
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function firstMeaningfulLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function trimSentence(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 220) {
    return compact;
  }
  return compact.slice(0, 217).trimEnd() + "...";
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}
