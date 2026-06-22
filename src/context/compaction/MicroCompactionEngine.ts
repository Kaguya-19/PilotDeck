import type {
  CanonicalMessage,
  CanonicalToolResultBlock,
} from "../../model/index.js";
import { flattenToolResultBlockText } from "../../model/index.js";
import {
  collectToolNamesByCallId,
  isProtectedToolCallId,
  protectedToolNameSet,
} from "./protectedContext.js";

export const MICROCOMPACT_CLEARED = "[Old tool result content compacted]";
export const MICROCOMPACT_FAILURES_FOLDED = "[Repeated tool failures compacted]";
export const MICROCOMPACT_RECOVERED_FAILURE_PREFIX = "[Recovered tool error compacted";

export type MicroCompactionInput = {
  messages: CanonicalMessage[];
  /** Now() epoch in ms used to determine `idle for X` time-based decisions. */
  nowMs?: number;
  /** Microcompact only kicks in after this many ms of idle (legacy default ~5min). */
  idleMs?: number;
  /** Max bytes per tool_result allowed to remain after rewrite (legacy default ~512). */
  trimToBytes?: number;
};

export type MicroCompactionEngineOptions = {
  keepLatest?: number;
  trimToBytes?: number;
  protectedToolNames?: Iterable<string>;
};

export type MicroCompactionResult = {
  messages: CanonicalMessage[];
  rewritten: number;
  rewrittenBytes: number;
  toolCallIds: string[];
  appliedTrigger: "time_based" | "skipped";
};

/**
 * Cheap micro compaction for auto-compact: directly rewrites old large
 * tool_result content so subsequent turns carry less context while preserving
 * protected tool results verbatim.
 */
export class MicroCompactionEngine {
  private readonly protectedToolNames: ReadonlySet<string>;

  constructor(private readonly options: MicroCompactionEngineOptions = {}) {
    this.protectedToolNames = protectedToolNameSet(options.protectedToolNames);
  }

  apply(input: MicroCompactionInput): MicroCompactionResult {
    const trimToBytes = input.trimToBytes ?? this.options.trimToBytes ?? 12_000;
    const keepLatest = this.options.keepLatest ?? 2;

    const toolNamesByCallId = collectToolNamesByCallId(input.messages);
    const keepResultIds = this.collectLatestToolResultIds(input.messages, toolNamesByCallId, keepLatest);
    const foldedFailureIds = this.collectFoldedFailureIds(input.messages, toolNamesByCallId);
    const recoveredFailureIds = this.collectRecoveredFailureIds(input.messages, toolNamesByCallId);

    const rewrittenIds: string[] = [];
    let rewrittenBytes = 0;

    const messages = input.messages.map((message) => {
      if (message.role !== "user") {
        return message;
      }
      let touched = false;
      const newContent = message.content.map((block) => {
        if (block.type !== "tool_result") {
          return block;
        }

        if (isProtectedToolCallId(block.toolCallId, toolNamesByCallId, this.protectedToolNames)) {
          return block;
        }

        const recoveredToolName = recoveredFailureIds.get(block.toolCallId);
        if (recoveredToolName) {
          touched = true;
          rewrittenIds.push(block.toolCallId);
          const size = this.estimateToolResultSize(block as CanonicalToolResultBlock);
          rewrittenBytes += size;
          return {
            ...block,
            content: [{ type: "text" as const, text: recoveredFailureText(recoveredToolName) }],
          };
        }

        if (foldedFailureIds.has(block.toolCallId)) {
          touched = true;
          rewrittenIds.push(block.toolCallId);
          const size = this.estimateToolResultSize(block as CanonicalToolResultBlock);
          rewrittenBytes += size;
          return {
            ...block,
            content: [{ type: "text" as const, text: MICROCOMPACT_FAILURES_FOLDED }],
          };
        }

        if (keepResultIds.has(block.toolCallId)) {
          return block;
        }

        const size = this.estimateToolResultSize(block as CanonicalToolResultBlock);
        if (size <= trimToBytes) {
          return block;
        }
        touched = true;
        rewrittenIds.push(block.toolCallId);
        rewrittenBytes += size;
        return {
          ...block,
          content: [
            {
              type: "text" as const,
              text: compactToolResultText(flattenToolResultBlockText(block as CanonicalToolResultBlock), trimToBytes),
            },
          ],
        };
      });
      return touched ? { ...message, content: newContent } : message;
    });

    return {
      messages,
      rewritten: rewrittenIds.length,
      rewrittenBytes,
      toolCallIds: rewrittenIds,
      appliedTrigger: rewrittenIds.length > 0 ? "time_based" : "skipped",
    };
  }

  private collectLatestToolResultIds(
    messages: CanonicalMessage[],
    toolNamesByCallId: Map<string, string>,
    keepLatest: number,
  ): Set<string> {
    const keep = new Set<string>();
    const countsByTool = new Map<string, number>();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "user") continue;
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const toolName = toolNamesByCallId.get(block.toolCallId) ?? "unknown";
        const count = countsByTool.get(toolName) ?? 0;
        if (count < keepLatest) {
          keep.add(block.toolCallId);
          countsByTool.set(toolName, count + 1);
        }
      }
    }
    return keep;
  }

  private collectFoldedFailureIds(
    messages: CanonicalMessage[],
    toolNamesByCallId: Map<string, string>,
  ): Set<string> {
    const folded = new Set<string>();
    let run: Array<{ id: string; fingerprint: string }> = [];
    const flush = () => {
      if (run.length > 2) {
        for (let fold = 1; fold < run.length - 1; fold++) {
          folded.add(run[fold]!.id);
        }
      }
      run = [];
    };

    for (const message of messages) {
      if (message.role !== "user") continue;
      for (const block of message.content) {
        if (block.type !== "tool_result" || !block.isError) {
          flush();
          continue;
        }
        if (isProtectedToolCallId(block.toolCallId, toolNamesByCallId, this.protectedToolNames)) {
          flush();
          continue;
        }
        const text = flattenToolResultBlockText(block as CanonicalToolResultBlock).trim();
        if (!isFoldableFailure(text)) {
          flush();
          continue;
        }
        const toolName = toolNamesByCallId.get(block.toolCallId) ?? "unknown";
        const fingerprint = `${toolName}\n${text}`;
        if (run.length > 0 && run[run.length - 1]!.fingerprint !== fingerprint) {
          flush();
        }
        run.push({ id: block.toolCallId, fingerprint });
      }
    }
    flush();
    return folded;
  }

  private collectRecoveredFailureIds(
    messages: CanonicalMessage[],
    toolNamesByCallId: Map<string, string>,
  ): Map<string, string> {
    const recovered = new Map<string, string>();
    const laterSuccessfulTools = new Set<string>();

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "user") continue;

      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = message.content[blockIndex];
        if (!block || block.type !== "tool_result") {
          continue;
        }

        const toolName = toolNamesByCallId.get(block.toolCallId);
        if (!toolName) {
          continue;
        }

        if (isProtectedToolCallId(block.toolCallId, toolNamesByCallId, this.protectedToolNames)) {
          continue;
        }

        if (!block.isError) {
          laterSuccessfulTools.add(toolName);
          continue;
        }

        if (!laterSuccessfulTools.has(toolName)) {
          continue;
        }

        if (isRecoverableFailure(block as CanonicalToolResultBlock)) {
          recovered.set(block.toolCallId, toolName);
        }
      }
    }

    return recovered;
  }

  private estimateToolResultSize(block: CanonicalToolResultBlock): number {
    let size = 0;
    for (const item of block.content) {
      if (item.type === "text") {
        size += item.text.length;
      } else if (item.type === "image" || item.type === "pdf") {
        size += item.data.length;
      }
    }
    return size;
  }
}

function isFoldableFailure(text: string): boolean {
  return isRecoverableFailureText(text);
}

function isRecoverableFailure(block: CanonicalToolResultBlock): boolean {
  const code = readRawToolErrorCode(block);
  if (code === "permission_denied" || code === "permission_required" || code === "unsupported_tool") {
    return false;
  }
  if (code === "invalid_tool_input" || code === "tool_execution_failed") {
    return true;
  }
  return isRecoverableFailureText(flattenToolResultBlockText(block).trim());
}

function isRecoverableFailureText(text: string): boolean {
  if (isExplicitlyNonRecoverableFailureText(text)) {
    return false;
  }
  return text.includes("invalid_tool_input")
    || text.includes("tool_execution_failed")
    || text.includes("Tool execution failed")
    || text.includes("Tool input validation failed");
}

function isExplicitlyNonRecoverableFailureText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("permission_denied")
    || normalized.includes("permission denied")
    || normalized.includes("permission_required")
    || normalized.includes("permission is required")
    || normalized.includes("unsupported_tool")
    || normalized.includes("unsupported tool");
}

function readRawToolErrorCode(block: CanonicalToolResultBlock): string | undefined {
  if (!block.raw || typeof block.raw !== "object") {
    return undefined;
  }
  const raw = block.raw as { error?: unknown };
  if (!raw.error || typeof raw.error !== "object") {
    return undefined;
  }
  const error = raw.error as { code?: unknown };
  return typeof error.code === "string" ? error.code : undefined;
}

function recoveredFailureText(toolName: string): string {
  return `${MICROCOMPACT_RECOVERED_FAILURE_PREFIX}: later call to ${toolName} succeeded]`;
}

function compactToolResultText(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) {
    return text;
  }
  const marker = `\n\n... [${text.length - budgetChars} chars omitted by auto micro-compaction] ...\n\n`;
  const half = Math.max(0, Math.floor((budgetChars - marker.length) / 2));
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  return `${MICROCOMPACT_CLEARED}\n${head}${marker}${tail}`;
}
