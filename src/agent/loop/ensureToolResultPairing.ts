import type { CanonicalToolCall } from "../../model/index.js";
import type { PilotDeckToolErrorResult, PilotDeckToolResult } from "../../tool/index.js";
import {
  createDefaultToolErrorEnricherRegistry,
  createToolErrorResult,
  type ToolErrorEnricherRegistry,
} from "../../tool/index.js";

export type ToolResultPairingErrorContext = {
  cwd?: string;
  permissionMode?: string;
  errorEnrichers?: ToolErrorEnricherRegistry;
};

export function ensureToolResultPairing(
  calls: CanonicalToolCall[],
  results: PilotDeckToolResult[],
  now: () => Date = () => new Date(),
  message = "Tool execution did not produce a result.",
  errorContext?: ToolResultPairingErrorContext,
): PilotDeckToolResult[] {
  const resultsByCallId = new Map(results.map((result) => [result.toolCallId, result]));
  const paired: PilotDeckToolResult[] = [];

  for (const call of calls) {
    paired.push(resultsByCallId.get(call.id) ?? createMissingToolResult(call, now, message, errorContext));
  }

  return paired;
}

export function createMissingToolResult(
  call: CanonicalToolCall,
  now: () => Date = () => new Date(),
  message = "Tool execution did not produce a result.",
  errorContext?: ToolResultPairingErrorContext,
): PilotDeckToolErrorResult {
  const startedAt = now().toISOString();
  return createToolErrorResult({
    toolCallId: call.id,
    toolName: call.name,
    code: "tool_execution_failed",
    message,
    startedAt,
    now,
    cwd: errorContext?.cwd ?? "",
    permissionMode: errorContext?.permissionMode ?? "default",
    toolInput: call.input,
    errorEnrichers: errorContext?.errorEnrichers ?? createDefaultToolErrorEnricherRegistry(),
  });
}
