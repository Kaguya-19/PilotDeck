import type { PilotDeckToolErrorCode } from "../protocol/errors.js";

export type ToolErrorEnrichmentContext = {
  cwd: string;
  permissionMode: string;
  toolName: string;
  toolInput?: unknown;
};

export type ToolErrorEnricher = {
  name: string;
  matches: (code: PilotDeckToolErrorCode, details?: Record<string, unknown>) => boolean;
  enrich: (
    code: PilotDeckToolErrorCode,
    rawMessage: string,
    context: ToolErrorEnrichmentContext,
    details?: Record<string, unknown>,
  ) => string | undefined;
};

export class ToolErrorEnricherRegistry {
  private enrichers: ToolErrorEnricher[] = [];

  register(enricher: ToolErrorEnricher): void {
    this.enrichers.push(enricher);
  }

  unregister(name: string): void {
    this.enrichers = this.enrichers.filter((e) => e.name !== name);
  }

  enrich(
    code: PilotDeckToolErrorCode,
    toolName: string,
    rawMessage: string,
    context: ToolErrorEnrichmentContext,
    details?: Record<string, unknown>,
  ): string {
    const hints: string[] = [];
    for (const enricher of this.enrichers) {
      if (enricher.matches(code, details)) {
        const hint = enricher.enrich(code, rawMessage, context, details);
        if (hint) {
          hints.push(hint);
        }
      }
    }
    if (hints.length === 0) {
      return rawMessage;
    }
    return `[ERROR: ${code}]\n${rawMessage}\n\nRecovery:\n${hints.join("\n")}`;
  }
}

// ---------------------------------------------------------------------------
// Built-in enrichers
// ---------------------------------------------------------------------------

const permissionDeniedEnricher: ToolErrorEnricher = {
  name: "builtin:permission_denied",
  matches: (code) => code === "permission_denied",
  enrich: (_code, _msg, ctx) => {
    const lines: string[] = [];
    lines.push(`- Current permission mode: "${ctx.permissionMode}". This operation was blocked by policy.`);
    lines.push("- Try an alternative approach that does not require elevated privileges.");
    lines.push("- If this operation is essential, explain to the user why it is needed and ask for confirmation.");
    return lines.join("\n");
  },
};

const permissionRequiredEnricher: ToolErrorEnricher = {
  name: "builtin:permission_required",
  matches: (code) => code === "permission_required",
  enrich: () => {
    const lines: string[] = [];
    lines.push("- This tool requires explicit user approval before execution.");
    lines.push("- Do NOT retry the same call immediately — wait for user confirmation.");
    lines.push("- Explain to the user what you need to do and why, then proceed only after approval.");
    return lines.join("\n");
  },
};

const permissionCancelledEnricher: ToolErrorEnricher = {
  name: "builtin:permission_cancelled",
  matches: (code) => code === "permission_cancelled",
  enrich: () => {
    const lines: string[] = [];
    lines.push("- The user explicitly cancelled/rejected this operation.");
    lines.push("- Do NOT retry the same operation. Respect the user's decision.");
    lines.push("- Consider an alternative approach or ask the user how they would like to proceed.");
    return lines.join("\n");
  },
};

const pathNotAllowedEnricher: ToolErrorEnricher = {
  name: "builtin:path_not_allowed",
  matches: (code) => code === "path_not_allowed",
  enrich: (_code, rawMessage, ctx) => {
    const lines: string[] = [];
    lines.push(`- Workspace root: ${ctx.cwd}`);
    if (rawMessage.includes("not allowed by default")) {
      lines.push("- Protected directories (.git, node_modules, dist) are write-restricted by default.");
      lines.push("- Use a different output path within the workspace, or ask the user to allow this path.");
    } else {
      lines.push("- All file operations must target paths within the workspace root.");
      lines.push("- Use relative paths or absolute paths under the workspace root.");
    }
    return lines.join("\n");
  },
};

const fileNotFoundEnricher: ToolErrorEnricher = {
  name: "builtin:file_not_found",
  matches: (code) => code === "file_not_found",
  enrich: () => {
    const lines: string[] = [];
    lines.push("- Verify the file path spelling and case sensitivity.");
    lines.push("- Use the glob tool to search for files matching a pattern if unsure of the exact path.");
    lines.push("- The file may have been moved, renamed, or not yet created.");
    return lines.join("\n");
  },
};

const toolTimeoutEnricher: ToolErrorEnricher = {
  name: "builtin:tool_timeout",
  matches: (code) => code === "tool_timeout",
  enrich: () => {
    const lines: string[] = [];
    lines.push("- The operation exceeded the time limit.");
    lines.push("- Try breaking it into smaller, faster operations.");
    lines.push("- For long-running commands, consider background execution or reducing scope.");
    return lines.join("\n");
  },
};

const resultTooLargeEnricher: ToolErrorEnricher = {
  name: "builtin:result_too_large",
  matches: (code) => code === "result_too_large",
  enrich: (_code, _msg, ctx) => {
    const lines: string[] = [];
    lines.push("- The output exceeded the size budget.");
    if (ctx.toolName === "read_file") {
      lines.push("- Use offset and limit parameters to read a smaller portion of the file.");
    } else if (ctx.toolName === "grep") {
      lines.push("- Use head_limit to cap results, or narrow the search with a more specific pattern or path.");
    } else {
      lines.push("- Try limiting the scope of the operation to produce smaller output.");
    }
    return lines.join("\n");
  },
};

const setupRequiredEnricher: ToolErrorEnricher = {
  name: "builtin:setup_required",
  matches: (code) => code === "setup_required",
  enrich: () => {
    const lines: string[] = [];
    lines.push("- This tool requires configuration that has not been completed.");
    lines.push("- Do NOT retry — the user must configure the required settings first.");
    lines.push("- Inform the user about the missing configuration and wait for them to set it up.");
    return lines.join("\n");
  },
};

const toolNotFoundEnricher: ToolErrorEnricher = {
  name: "builtin:tool_not_found",
  matches: (code) => code === "tool_not_found",
  enrich: () => {
    const lines: string[] = [];
    lines.push("- The specified tool does not exist. Check the tool name for typos.");
    lines.push("- Review the available tools in your tool list and use the correct name.");
    return lines.join("\n");
  },
};

const STDERR_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /Permission denied|EACCES|EPERM/i,
    hint: "- The command failed due to insufficient permissions. Try without sudo, use a different path, or ask the user to grant access.",
  },
  {
    pattern: /No such file or directory|ENOENT/i,
    hint: "- A referenced file or directory does not exist. Verify the path with glob or ls before retrying.",
  },
  {
    pattern: /command not found/i,
    hint: "- The command is not installed or not on PATH. Try an alternative tool or ask the user to install it.",
  },
  {
    pattern: /No space left on device|disk quota/i,
    hint: "- The disk is full or quota exceeded. Ask the user to free space before retrying.",
  },
  {
    pattern: /connection refused|ECONNREFUSED/i,
    hint: "- A network connection was refused. The target service may not be running. Verify the service status.",
  },
  {
    pattern: /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    hint: "- A network operation timed out. The service may be unreachable or slow. Retry with a longer timeout or check connectivity.",
  },
];

const stderrPatternEnricher: ToolErrorEnricher = {
  name: "builtin:stderr_pattern",
  matches: (code, details) =>
    code === "tool_execution_failed" && !!(details?.stderr || details?.details),
  enrich: (_code, rawMessage, _ctx, details) => {
    const stderr = String(details?.stderr ?? details?.details ?? rawMessage);
    const matched: string[] = [];
    for (const { pattern, hint } of STDERR_PATTERNS) {
      if (pattern.test(stderr)) {
        matched.push(hint);
      }
    }
    return matched.length > 0 ? matched.join("\n") : undefined;
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDefaultToolErrorEnricherRegistry(): ToolErrorEnricherRegistry {
  const registry = new ToolErrorEnricherRegistry();
  registry.register(permissionDeniedEnricher);
  registry.register(permissionRequiredEnricher);
  registry.register(permissionCancelledEnricher);
  registry.register(pathNotAllowedEnricher);
  registry.register(fileNotFoundEnricher);
  registry.register(toolTimeoutEnricher);
  registry.register(resultTooLargeEnricher);
  registry.register(setupRequiredEnricher);
  registry.register(toolNotFoundEnricher);
  registry.register(stderrPatternEnricher);
  return registry;
}
