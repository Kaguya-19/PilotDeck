import { PermissionRuntime } from "../../permission/index.js";
import type { LifecycleDispatchResult, LifecycleRuntime, PilotDeckHookEffect } from "../../lifecycle/index.js";
import type { PilotDeckToolErrorCode } from "../protocol/errors.js";
import { PLAN_MODE_ALLOWED_TOOLS, buildPlanModeViolationMessage } from "../planModeConstraints.js";
import {
  applyResultSizeLimit,
  type PilotDeckToolErrorResult,
  type PilotDeckToolResult,
  type PilotDeckToolSuccessResult,
} from "../protocol/result.js";
import type {
  PilotDeckCustomToolValidatorResult,
  PilotDeckToolCall,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import { validateToolInput } from "./validateToolInput.js";
import { formatValidationError } from "./formatValidationError.js";
import { normalizeToolError } from "../protocol/errors.js";
import type { AgentEventEmitter } from "../../agent/protocol/events.js";
import type { ToolErrorEnricherRegistry } from "./errorEnrichment.js";
import { createToolErrorResult } from "./createToolErrorResult.js";
import { repairToolName } from "../../model/streaming/repairToolName.js";

export class ToolRuntime {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionRuntime: PermissionRuntime,
    private readonly lifecycle?: LifecycleRuntime,
    private readonly eventEmitter?: AgentEventEmitter,
    private readonly errorEnrichers?: ToolErrorEnricherRegistry,
  ) {}

  async execute(call: PilotDeckToolCall, context: PilotDeckToolRuntimeContext): Promise<PilotDeckToolResult> {
    const startedAtDate = now(context);
    const startedAt = startedAtDate.toISOString();
    let tool = this.registry.get(call.name);
    if (!tool) {
      const repaired = repairToolName(
        call.name,
        new Set(this.registry.list().map((definition) => definition.name)),
        context.toolAliases,
      );
      if (repaired) {
        tool = this.registry.get(repaired.name);
      }
    }
    const toolName = tool?.name ?? call.name;

    if (context.abortSignal?.aborted) {
      return this.errorResult(call.id, toolName, "tool_aborted", "Tool execution was aborted.", startedAt, context, undefined, call.input);
    }

    if (!tool) {
      return this.errorResult(
        call.id,
        call.name,
        "tool_not_found",
        `Tool ${call.name} does not exist.`,
        startedAt,
        context,
        undefined,
        call.input,
      );
    }

    if (context.permissionMode === "plan" && !PLAN_MODE_ALLOWED_TOOLS.has(tool.name)) {
      return this.errorResult(
        call.id,
        tool.name,
        "plan_mode_violation",
        buildPlanModeViolationMessage(tool.name),
        startedAt,
        context,
        undefined,
        call.input,
      );
    }

    const validation = validateToolInput(call.input, tool.inputSchema);
    if (!validation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        formatValidationError(tool.name, validation.issues, {
          maxOutputTokens: context.maxOutputTokens,
          outputTruncated: context.outputTruncated,
        }),
        startedAt,
        context,
        { issues: validation.issues },
        call.input,
      );
    }

    let executeInput = call.input;
    const preToolResult = await this.dispatchLifecycle("PreToolUse", tool.name, call.id, executeInput, context);
    this.eventEmitter?.({ type: "pre_tool_execute", sessionId: context.sessionId, turnId: context.turnId, toolCallId: call.id, toolName: tool.name });
    const preBlock = findEffect(preToolResult.effects, "block");
    const prePermission = findEffect(preToolResult.effects, "permission_decision");
    const preDeny = prePermission?.behavior === "deny" ? prePermission : undefined;
    if (preBlock || preDeny) {
      return this.errorResult(
        call.id,
        tool.name,
        "permission_denied",
        preBlock?.reason ?? preDeny?.reason ?? `PreToolUse hook denied ${tool.name}.`,
        startedAt,
        context,
      );
    }
    const updatedInput = findEffect(preToolResult.effects, "updated_tool_input");
    if (updatedInput) {
      executeInput = updatedInput.input;
      const updatedValidation = validateToolInput(executeInput, tool.inputSchema);
      if (!updatedValidation.ok) {
        return this.errorResult(
          call.id,
          tool.name,
          "invalid_tool_input",
          `PreToolUse hook produced invalid input for ${tool.name}.`,
          startedAt,
          context,
          { issues: updatedValidation.issues },
          executeInput,
        );
      }
    }

    const customValidation = await this.runCustomValidators(call.id, tool.name, executeInput, tool, context, startedAt);
    if (customValidation.type === "error") {
      await this.recordToolAudit(customValidation.result, context, startedAtDate);
      return customValidation.result;
    }
    executeInput = customValidation.input;
    const validatorHints = customValidation.hints;

    const toolValidation = await tool.validateInput?.(executeInput, context);
    if (toolValidation && !toolValidation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        `Tool ${tool.name} rejected the input.`,
        startedAt,
        context,
        { issues: toolValidation.issues },
        executeInput,
        validatorHints,
      );
    }

    const todoGateMessage = context.planTodo?.blockingMessageFor(
      tool.name,
      tool.isReadOnly(executeInput),
    );
    if (todoGateMessage) {
      return this.errorResult(
        call.id,
        tool.name,
        "tool_execution_failed",
        todoGateMessage,
        startedAt,
        context,
        undefined,
        executeInput,
      );
    }

    let decision = await this.permissionRuntime.decide(tool, executeInput, context, call.id);
    if (decision.type === "ask") {
      const permissionHookResult = await this.dispatchLifecycle("PermissionRequest", tool.name, call.id, executeInput, context, {
        permissionSuggestions: decision.request.options,
      });
      this.eventEmitter?.({ type: "permission_requested", sessionId: context.sessionId, turnId: context.turnId, toolCallId: call.id, toolName: tool.name });
      const permissionRequestResult = findEffect(permissionHookResult.effects, "permission_request_result");
      if (permissionRequestResult?.result.behavior === "allow") {
        decision = {
          type: "allow",
          reason: { type: "runtime", message: `PermissionRequest hook allowed ${tool.name}.` },
          updatedInput: permissionRequestResult.result.updatedInput,
        };
      } else if (permissionRequestResult?.result.behavior === "deny") {
        decision = {
          type: "deny",
          reason: { type: "runtime", message: permissionRequestResult.result.message ?? `PermissionRequest hook denied ${tool.name}.` },
          message: permissionRequestResult.result.message ?? `PermissionRequest hook denied ${tool.name}.`,
        };
      }
    }
    await context.auditRecorder?.recordPermission({
      type: "permission",
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: call.id,
      toolName: tool.name,
      mode: context.permissionContext.mode,
      decision: decision.type,
      reason: decision.reason,
      createdAt: now(context).toISOString(),
    });

    if (decision.type === "deny") {
      await this.dispatchLifecycle("PermissionDenied", tool.name, call.id, executeInput, context, {
        reason: decision.message,
      });
      this.eventEmitter?.({ type: "permission_denied", sessionId: context.sessionId, turnId: context.turnId, toolName: tool.name, reason: decision.message });
      const code: PilotDeckToolErrorCode =
        decision.reason.type === "runtime" && decision.reason.message.includes("prompt") ?
          "permission_required" :
          "permission_denied";
      return this.errorResult(call.id, tool.name, code, decision.message, startedAt, context, undefined, executeInput);
    }

    if (decision.type === "cancel") {
      return this.errorResult(call.id, tool.name, "permission_cancelled", decision.message, startedAt, context, undefined, executeInput);
    }

    if (decision.type === "ask") {
      return this.errorResult(
        call.id,
        tool.name,
        "permission_required",
        `Permission is required to run ${tool.name}.`,
        startedAt,
        context,
        { request: decision.request },
        executeInput,
      );
    }

    executeInput = decision.updatedInput ?? executeInput;
    const baseContext: PilotDeckToolRuntimeContext = { ...context, currentToolCallId: call.id };
    const executeContext: PilotDeckToolRuntimeContext = baseContext.progress
      ? {
          ...baseContext,
          progress: (event) =>
            baseContext.progress!({
              ...event,
              toolCallId: event.toolCallId || call.id,
              toolName: event.toolName || tool.name,
            }),
        }
      : baseContext;
    try {
      const output = await tool.execute(executeInput, executeContext);
      const maxResultBytes = tool.maxResultBytes ?? context.maxResultBytes;
      const limited = applyResultSizeLimit(output.content, maxResultBytes);
      const completedAt = now(context).toISOString();
      const postToolLifecycle = await this.dispatchLifecycle(
        "PostToolUse",
        tool.name,
        call.id,
        executeInput,
        context,
        { toolResponse: output.data ?? output.content },
      );
      this.eventEmitter?.({ type: "post_tool_execute", sessionId: context.sessionId, turnId: context.turnId, toolCallId: call.id, toolName: tool.name, success: true });
      const result: PilotDeckToolSuccessResult = {
        type: "success",
        toolCallId: call.id,
        toolName: tool.name,
        content: limited.content,
        supplementalMessages: output.supplementalMessages,
        data: output.data,
        metadata: mergeMetadata(
          output.metadata,
          mergeMetadata(limited.metadata, lifecycleMetadata(postToolLifecycle)),
        ),
        startedAt,
        completedAt,
      };
      if (!tool.isReadOnly(executeInput) && tool.name !== "todo_write") {
        context.planTodo?.markToolProgressChanged(tool.name);
      }
      await this.recordToolAudit(result, context, startedAtDate);
      return result;
    } catch (error) {
      const normalized = normalizeToolError(error);
      const failureHookResult = await this.dispatchLifecycle("PostToolUseFailure", tool.name, call.id, executeInput, context, {
        error: normalized.message,
        errorCode: normalized.code,
        isInterrupt: normalized.code === "tool_aborted",
      });
      this.eventEmitter?.({ type: "post_tool_execute", sessionId: context.sessionId, turnId: context.turnId, toolCallId: call.id, toolName: tool.name, success: false });
      const hookAdditionalContext = failureHookResult.effects
        .filter(isAdditionalContextEffect)
        .map((e) => e.content);
      hookAdditionalContext.push(...validatorHints);
      const result = this.createErrorResult(
        call.id,
        tool.name,
        normalized.code,
        normalized.message,
        startedAt,
        context,
        normalized.details,
        executeInput,
        hookAdditionalContext,
      );
      await this.recordToolAudit(result, context, startedAtDate);
      return result;
    }
  }

  private async errorResult(
    toolCallId: string,
    toolName: string,
    code: PilotDeckToolErrorCode,
    message: string,
    startedAt: string,
    context: PilotDeckToolRuntimeContext,
    details?: Record<string, unknown>,
    toolInput?: unknown,
    hookAdditionalContext?: string[],
  ): Promise<PilotDeckToolErrorResult> {
    const startedAtDate = new Date(startedAt);
    const result = this.createErrorResult(toolCallId, toolName, code, message, startedAt, context, details, toolInput, hookAdditionalContext);
    await this.recordToolAudit(result, context, startedAtDate);
    return result;
  }

  private async runCustomValidators(
    toolCallId: string,
    toolName: string,
    initialInput: unknown,
    tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
    context: PilotDeckToolRuntimeContext,
    startedAt: string,
  ): Promise<
    | { type: "ok"; input: unknown; hints: string[] }
    | { type: "error"; result: PilotDeckToolErrorResult }
  > {
    let input = initialInput;
    const hints: string[] = [];
    for (const validator of context.customToolValidators ?? []) {
      let result: PilotDeckCustomToolValidatorResult;
      try {
        result = await validator({
          toolName,
          toolInput: input,
          toolCallId,
          context,
          isReadOnly: tool.isReadOnly(input),
          isConcurrencySafe: tool.isConcurrencySafe(input),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          type: "error",
          result: this.createErrorResult(
            toolCallId,
            toolName,
            "tool_execution_failed",
            `Custom tool validator failed: ${message}`,
            startedAt,
            context,
            { source: "custom_validator", message },
            input,
          ),
        };
      }

      if (!result || result.type === "allow" || result.type === undefined) {
        if (result?.hint) hints.push(result.hint);
        continue;
      }

      if (result.type === "hint") {
        hints.push(result.hint);
        continue;
      }

      if (result.hint) {
        hints.push(result.hint);
      }

      if (result.type === "deny") {
        const details = {
          source: "custom_validator",
          ...(result.validatorName ? { validatorName: result.validatorName } : {}),
        };
        return {
          type: "error",
          result: this.createErrorResult(
            toolCallId,
            toolName,
            "permission_denied",
            result.message,
            startedAt,
            context,
            details,
            input,
            hints,
          ),
        };
      }

      if (result.type === "updateInput") {
        input = result.input;
        const updatedValidation = validateToolInput(input, tool.inputSchema);
        if (!updatedValidation.ok) {
          const details = {
            issues: updatedValidation.issues,
            source: "custom_validator",
            ...(result.validatorName ? { validatorName: result.validatorName } : {}),
          };
          return {
            type: "error",
            result: this.createErrorResult(
              toolCallId,
              toolName,
              "invalid_tool_input",
              `Custom tool validator produced invalid input for ${toolName}.`,
              startedAt,
              context,
              details,
              input,
              hints,
            ),
          };
        }
      }
    }
    return { type: "ok", input, hints };
  }

  private createErrorResult(
    toolCallId: string,
    toolName: string,
    code: PilotDeckToolErrorCode,
    message: string,
    startedAt: string,
    context: PilotDeckToolRuntimeContext,
    details?: Record<string, unknown>,
    toolInput?: unknown,
    hookAdditionalContext?: string[],
  ): PilotDeckToolErrorResult {
    return createToolErrorResult({
      toolCallId,
      toolName,
      code,
      message,
      startedAt,
      now: () => now(context),
      cwd: context.cwd,
      permissionMode: context.permissionMode,
      details,
      toolInput,
      hookAdditionalContext,
      errorEnrichers: this.errorEnrichers,
    });
  }

  private async recordToolAudit(
    result: PilotDeckToolResult,
    context: PilotDeckToolRuntimeContext,
    startedAt: Date,
  ): Promise<void> {
    await context.auditRecorder?.recordTool({
      type: "tool",
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      status: result.type === "success" ? "success" : "error",
      errorCode: result.type === "error" ? result.error.code : undefined,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: new Date(result.completedAt).getTime() - startedAt.getTime(),
    });
  }

  private async dispatchLifecycle(
    event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest" | "PermissionDenied",
    toolName: string,
    toolCallId: string,
    toolInput: unknown,
    context: PilotDeckToolRuntimeContext,
    extraPayload: Record<string, unknown> = {},
  ): Promise<LifecycleDispatchResult> {
    return this.lifecycle?.dispatch({
      event,
      baseInput: {
        sessionId: context.sessionId,
        transcriptPath: "",
        cwd: context.cwd,
        permissionMode: context.permissionMode,
      },
      matchQuery: toolName,
      payload: {
        toolName,
        toolInput,
        toolUseId: toolCallId,
        ...extraPayload,
      },
      signal: context.abortSignal,
      env: context.env,
    }) ?? {
      effects: [],
      messages: [],
      events: [],
      blockingErrors: [],
      nonBlockingErrors: [],
    };
  }
}

function findEffect<Type extends PilotDeckHookEffect["type"]>(
  effects: PilotDeckHookEffect[],
  type: Type,
): Extract<PilotDeckHookEffect, { type: Type }> | undefined {
  return effects.find((effect): effect is Extract<PilotDeckHookEffect, { type: Type }> => effect.type === type);
}

function isAdditionalContextEffect(
  effect: PilotDeckHookEffect,
): effect is Extract<PilotDeckHookEffect, { type: "additional_context" }> {
  return effect.type === "additional_context";
}

function lifecycleMetadata(result: { effects: PilotDeckHookEffect[] }): Record<string, unknown> | undefined {
  const blocking = result.effects.find((effect) => effect.type === "block");
  const additionalContext = result.effects.filter((effect) => effect.type === "additional_context");
  const updatedMcpOutput = result.effects.find((effect) => effect.type === "updated_mcp_tool_output");
  if (!blocking && additionalContext.length === 0 && !updatedMcpOutput) {
    return undefined;
  }
  return {
    lifecycle: {
      blocked: blocking ? { reason: blocking.reason, stopReason: blocking.stopReason } : undefined,
      additionalContext: additionalContext.map((effect) => effect.content),
      updatedMcpToolOutput: updatedMcpOutput?.output,
    },
  };
}

function now(context: PilotDeckToolRuntimeContext): Date {
  return context.now?.() ?? new Date();
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
