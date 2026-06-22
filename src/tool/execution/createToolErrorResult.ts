import { toolError } from "../protocol/errors.js";
import type { PilotDeckToolErrorCode } from "../protocol/errors.js";
import type { PilotDeckToolErrorResult } from "../protocol/result.js";
import type { ToolErrorEnricherRegistry, ToolErrorRecoveryAdvice } from "./errorEnrichment.js";

export type CreateToolErrorResultOptions = {
  toolCallId: string;
  toolName: string;
  code: PilotDeckToolErrorCode;
  message: string;
  startedAt: string;
  now: () => Date;
  cwd: string;
  permissionMode: string;
  details?: Record<string, unknown>;
  toolInput?: unknown;
  metadata?: Record<string, unknown>;
  hookAdditionalContext?: string[];
  errorEnrichers?: ToolErrorEnricherRegistry;
};

export function createToolErrorResult(options: CreateToolErrorResultOptions): PilotDeckToolErrorResult {
  const completedAt = options.now().toISOString();
  let modelMessage = options.message;
  let recoveryAdvice: ToolErrorRecoveryAdvice | undefined;

  if (options.errorEnrichers) {
    const recovery = options.errorEnrichers.recover(
      options.code,
      options.toolName,
      options.message,
      {
        cwd: options.cwd,
        permissionMode: options.permissionMode,
        toolName: options.toolName,
        toolInput: options.toolInput,
      },
      options.details,
    );
    modelMessage = recovery.message;
    recoveryAdvice = recovery.advice;
  }

  if (options.hookAdditionalContext && options.hookAdditionalContext.length > 0) {
    modelMessage += "\n\n" + options.hookAdditionalContext.map((c) => `[Hook hint]: ${c}`).join("\n");
  }

  return {
    type: "error",
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    error: toolError(options.code, options.message, options.details),
    content: [{ type: "text", text: modelMessage }],
    metadata: mergeMetadata(
      options.metadata,
      recoveryAdvice
        ? {
            recovery: recoveryAdvice,
          }
        : undefined,
    ),
    startedAt: options.startedAt,
    completedAt,
  };
}

function mergeMetadata(
  first: Record<string, unknown> | undefined,
  second: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!first && !second) {
    return undefined;
  }
  return {
    ...(first ?? {}),
    ...(second ?? {}),
  };
}
