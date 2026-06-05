import type {
  CanonicalToolCall,
} from "../../model/index.js";
import type { PilotDeckToolResult } from "../../tool/index.js";

export type LargeFileRepairDecision =
  | { type: "continue"; prompt: string; purpose: string; strip?: "assistant" | "error_pair" }
  | { type: "stop"; reason: string };

export type LargeFileRepairToolContext = {
  outputTruncated: boolean;
  repairedToolCalls: boolean;
  finishReason?: string;
};

const MAX_PRE_DRAFT_REPAIR_ATTEMPTS = 5;
const MAX_POST_DRAFT_REPAIR_ATTEMPTS = 5;
const MAX_TRUNCATION_RECOVERIES = 10;
const LARGE_FILE_OUTPUT_RETRY_TOKENS = 16_384;
const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const FILE_READ_TOOLS = new Set(["read_file", "grep", "glob"]);

export class LargeFileRepair {
  private preDraftAttempts = 0;
  private postDraftAttempts = 0;
  private truncationRecoveries = 0;
  private wroteFile = false;
  private pendingLargeFileRepair = false;
  private recentFilePaths: string[] = [];

  get recommendedMaxOutputTokens(): number {
    return LARGE_FILE_OUTPUT_RETRY_TOKENS;
  }

  get hasPendingRepair(): boolean {
    return this.pendingLargeFileRepair;
  }

  onInvalidToolInput(): LargeFileRepairDecision | undefined {
    if (!this.pendingLargeFileRepair) {
      return undefined;
    }
    if (this.wroteFile) {
      return this.tryPostDraft("large_file_invalid_input_after_write");
    }
    return this.tryPreDraft("large_file_invalid_input", "error_pair");
  }

  onNoToolCalls(): LargeFileRepairDecision | undefined {
    if (!this.pendingLargeFileRepair || this.wroteFile) {
      return undefined;
    }
    return this.tryPreDraft("large_file_no_tool_call", "assistant");
  }

  analyzeToolResults(
    results: PilotDeckToolResult[],
    context: LargeFileRepairToolContext,
  ): LargeFileRepairDecision | undefined {
    this.recordWrites(results);

    if (this.wroteFile) {
      const risk = hasPostDraftRisk(results);
      if (!risk) {
        if (results.every((r) => r.type === "success")) {
          this.pendingLargeFileRepair = false;
        }
        return undefined;
      }
      return this.tryPostDraft("large_file_post_draft_repair");
    }

    if (hasPreDraftLargeFileRisk(results, context)) {
      this.pendingLargeFileRepair = true;
      return this.tryPreDraft("large_file_pre_draft_repair", "error_pair");
    }

    return undefined;
  }

  recoverFromRepairedTruncation(toolCalls: CanonicalToolCall[]): LargeFileRepairDecision | undefined {
    if (!toolCalls.some((call) => FILE_WRITE_TOOLS.has(call.name))) {
      return undefined;
    }
    if (this.truncationRecoveries >= MAX_TRUNCATION_RECOVERIES) {
      return undefined;
    }
    this.truncationRecoveries++;
    this.pendingLargeFileRepair = true;
    if (this.wroteFile) {
      return this.truncationRecovery("large_file_repaired_truncation_after_write", "post");
    }
    return this.truncationRecovery("large_file_repaired_truncation", "pre");
  }

  private truncationRecovery(
    purpose: string,
    phase: "pre" | "post",
  ): LargeFileRepairDecision {
    if (phase === "post") {
      return {
        type: "continue",
        purpose,
        strip: "assistant" as const,
        prompt: postDraftPrompt(this.recentFilePaths, this.postDraftAttempts),
      };
    }
    return {
      type: "continue",
      purpose,
      strip: "assistant" as const,
      prompt: preDraftPrompt(this.preDraftAttempts + 1),
    };
  }

  private tryPreDraft(purpose: string, strip: "assistant" | "error_pair"): LargeFileRepairDecision {
    if (this.preDraftAttempts >= MAX_PRE_DRAFT_REPAIR_ATTEMPTS) {
      return {
        type: "stop",
        reason:
          `Large file repair failed before any workspace file was created after ${this.preDraftAttempts} attempts.`,
      };
    }
    this.preDraftAttempts++;
    return {
      type: "continue",
      purpose,
      strip,
      prompt: preDraftPrompt(this.preDraftAttempts),
    };
  }

  private tryPostDraft(purpose: string): LargeFileRepairDecision {
    if (this.postDraftAttempts >= MAX_POST_DRAFT_REPAIR_ATTEMPTS) {
      return {
        type: "stop",
        reason:
          `Large file repair stopped after ${this.postDraftAttempts} post-draft attempts. A workspace file already exists; report the current file path and remaining gap.`,
      };
    }
    this.postDraftAttempts++;
    return {
      type: "continue",
      purpose,
      prompt: postDraftPrompt(this.recentFilePaths, this.postDraftAttempts),
    };
  }

  private recordWrites(results: PilotDeckToolResult[]): void {
    for (const result of results) {
      if (result.type !== "success" || !FILE_WRITE_TOOLS.has(result.toolName)) {
        continue;
      }
      this.wroteFile = true;
      const filePath = readResultFilePath(result.data);
      if (filePath) {
        this.recentFilePaths = [
          filePath,
          ...this.recentFilePaths.filter((path) => path !== filePath),
        ].slice(0, 5);
      }
    }
  }
}

function preDraftPrompt(attempt: number): string {
  const lastAttempt = attempt >= MAX_PRE_DRAFT_REPAIR_ATTEMPTS;
  const maxLines = attempt <= 2 ? 80 : attempt <= 4 ? 40 : 20;
  return [
    `[CRITICAL] Your previous ${attempt} attempt(s) to write a file FAILED because your output was too long and got truncated.`,
    `You MUST write a VERY SHORT file this time — absolutely no more than ${maxLines} lines of code.`,
    "",
    "MANDATORY RULES:",
    `1. The write_file content MUST be under ${maxLines} lines. This is a hard limit.`,
    "2. You MUST provide BOTH required parameters: file_path (string) and content (string).",
    "3. Write a minimal but structurally valid skeleton:",
    "   - For HTML: doctype + head + minimal style + body with ONE section + closing tags.",
    "   - For code: imports + ONE class/function stub + exports.",
    "   - For prose: title + first paragraph + a <!-- CONTINUE HERE --> marker.",
    "4. After the file is created, you will extend it incrementally in later turns using edit_file.",
    "5. Do NOT try to write the complete content. Write only a skeleton/stub now.",
    "",
    "EXACT TOOL CALL FORMAT — follow this precisely:",
    'write_file({ "file_path": "output.html", "content": "<!DOCTYPE html>\\n<html>\\n<head><title>Draft</title></head>\\n<body>\\n<h1>Draft</h1>\\n<!-- CONTINUE HERE -->\\n</body>\\n</html>" })',
    "",
    "Do not use shell commands, heredocs, or echo. Call write_file directly with a short content string.",
    lastAttempt ? "⚠️ FINAL ATTEMPT: Write the absolute minimum viable file — even just 10 lines is fine. Any valid file is better than no file." : "",
  ].filter(Boolean).join("\n");
}

function postDraftPrompt(filePaths: string[], attempt: number): string {
  const fileText = filePaths.length > 0
    ? `Known written file(s): ${filePaths.join(", ")}.`
    : "A workspace file has already been written.";
  const lastAttempt = attempt >= MAX_POST_DRAFT_REPAIR_ATTEMPTS;
  return [
    fileText,
    "",
    `[IMPORTANT] This is post-draft repair attempt ${attempt}/${MAX_POST_DRAFT_REPAIR_ATTEMPTS}. Add ONE small section at a time (under 60 lines per call).`,
    "",
    "Steps:",
    "1. First call read_file to see the current file content.",
    "2. Then use edit_file to insert or append ONE section (e.g. one component, one function, one CSS block).",
    "3. Do NOT rewrite the entire file. Only add the next missing piece.",
    "4. Keep each edit under 60 lines of new content.",
    "5. When the file meets the requirements, stop and report the file path.",
    "",
    "EXACT edit_file CALL FORMAT — follow this precisely:",
    'edit_file({ "file_path": "<path>", "old_string": "<!-- CONTINUE HERE -->", "new_string": "<nav>...</nav>\\n<!-- CONTINUE HERE -->" })',
    "",
    "Do not regenerate from scratch. Do not overwrite existing content unless you have just read it.",
    lastAttempt ? "⚠️ FINAL ATTEMPT: Make one focused edit or report the current file path and what remains to be done." : "",
  ].filter(Boolean).join("\n");
}

function hasPreDraftLargeFileRisk(
  results: PilotDeckToolResult[],
  context: LargeFileRepairToolContext,
): boolean {
  return results.some((result) => {
    if (result.type !== "error") {
      return false;
    }
    if (!FILE_WRITE_TOOLS.has(result.toolName)) {
      return false;
    }
    const issues = readIssues(result);
    if (
      result.toolName === "write_file" &&
      issues.some((issue) => issue.code === "required")
    ) {
      return true;
    }
    if (context.outputTruncated && issues.some((issue) => issue.code === "required")) {
      return true;
    }
    return looksLikeLargeFileError(result.error.message);
  });
}

function hasPostDraftRisk(results: PilotDeckToolResult[]): boolean {
  return results.some((result) => {
    if (result.type !== "error") {
      return false;
    }
    if (FILE_READ_TOOLS.has(result.toolName)) {
      return false;
    }
    if (result.error.code === "permission_denied" || result.error.code === "permission_required") {
      return false;
    }
    return FILE_WRITE_TOOLS.has(result.toolName) || looksLikeLargeFileError(result.error.message);
  });
}

function readIssues(result: PilotDeckToolResult): { path: string; code: string }[] {
  if (result.type !== "error") {
    return [];
  }
  const issues = result.error.details?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    if (!isRecord(issue)) {
      return [];
    }
    const path = typeof issue.path === "string" ? issue.path : "";
    const code = typeof issue.code === "string" ? issue.code : "";
    return [{ path, code }];
  });
}


function readResultFilePath(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const filePath = data.filePath;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function looksLikeLargeFileError(message: string): boolean {
  return /(?:output token|truncated|too large|large file|large artifact|max_output|missing required parameter `content`|required parameter `content` is missing)/iu.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
