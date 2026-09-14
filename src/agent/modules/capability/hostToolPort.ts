import type {
  PilotDeckToolCall,
  PilotDeckToolDefinition,
  PilotDeckToolErrorCode,
  PilotDeckToolResult,
  PilotDeckToolRuntimeContext,
} from "../../../tool/index.js";
import { createToolErrorResult } from "../../../tool/index.js";
import type { PermissionDecisionPort } from "../../../permission/index.js";
import type {
  AgentExecutionContext,
  HostCapabilityModuleMethod,
  ModuleCallRequest,
  ModuleResponse,
  ToolPort,
} from "../protocol.js";

type CapabilityModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
};

export type HostCapabilityModuleClient = (request: CapabilityModuleCall) => Promise<ModuleResponse>;

export type HostCapabilityToolPortOptions = {
  tools?: PilotDeckToolDefinition[];
  /** Optional host-owned decision provider that gates capability side effects. */
  permission?: PermissionDecisionPort;
  /** Immutable execution identity supplied by a sidecar composition. */
  binding?: {
    runId: string;
    operationId: string;
    idempotencyKey?: string;
  };
  uuid?: () => string;
  methods?: readonly HostCapabilityModuleMethod[];
  onAbort?: (reason: string) => void;
};

/** ToolPort consumer backed by a host-owned capability module. */
export function createHostCapabilityToolPort(
  callModule: HostCapabilityModuleClient,
  options: HostCapabilityToolPortOptions = {},
): ToolPort {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  return {
    list: () => options.tools ?? [],
    async executeAll(
      calls: PilotDeckToolCall[],
      context: PilotDeckToolRuntimeContext,
      execution: AgentExecutionContext,
    ): Promise<PilotDeckToolResult[]> {
      const toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
      const authorize = async (call: PilotDeckToolCall): Promise<
        { call: PilotDeckToolCall } | { result: PilotDeckToolResult }
      > => {
        const tool = toolsByName.get(call.name);
        if (!tool || !options.permission) return { call };

        const decision = await options.permission.decide(tool, call.input, context, call.id);
        if (decision.type !== "allow") {
          return { result: permissionDecisionResult(call, decision, context) };
        }
        return {
          call: {
            ...call,
            input: decision.updatedInput ?? call.input,
          },
        };
      };

      if (options.methods?.includes("execute_batch") && calls.length > 0) {
        const resultSlots = new Array<PilotDeckToolResult | undefined>(calls.length);
        const authorizedCalls = await Promise.all(calls.map(async (call, index) => ({ index, authorization: await authorize(call) })));
        const executable = authorizedCalls.flatMap(({ index, authorization }) =>
          "call" in authorization ? [{ index, call: authorization.call }] : [],
        );
        for (const { index, authorization } of authorizedCalls) {
          if ("result" in authorization) resultSlots[index] = authorization.result;
        }
        if (executable.length === 0) return resultSlots as PilotDeckToolResult[];
        const response = await callModule({
          runId: execution.runId,
          operationId: execution.operationId ?? options.binding?.operationId ?? execution.turnId,
          idempotencyKey: execution.idempotencyKey ?? options.binding?.idempotencyKey,
          requestId: `tool-batch-${uuid()}`,
          module: "capability",
          payload: {
            operation: "execute_batch",
            calls: executable.map(({ call }) => ({ name: call.name, arguments: call.input, toolCallId: call.id })),
            context: serializeToolContext(context),
            execution: serializeExecutionContext(execution),
          },
        });
        const results = response.payload?.results;
        if (!response.ok) {
          for (const { call, index } of executable) resultSlots[index] = moduleFailureResult(call, response);
          return resultSlots as PilotDeckToolResult[];
        }
        if (!Array.isArray(results) || results.length !== executable.length) {
          throw new Error("Capability batch response must contain one result for every executable call.");
        }
        for (const [index, entry] of executable.entries()) {
          resultSlots[entry.index] = validateBatchToolResult(results[index], entry.call, index);
        }
        return resultSlots as PilotDeckToolResult[];
      }

      const resultSlots = new Array<PilotDeckToolResult | undefined>(calls.length);
      const concurrent: Array<{ index: number; call: PilotDeckToolCall }> = [];
      const sequential: Array<{ index: number; call: PilotDeckToolCall }> = [];
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]!;
        const tool = toolsByName.get(call.name);
        if (tool?.isConcurrencySafe(call.input)) concurrent.push({ index, call });
        else sequential.push({ index, call });
      }

      const execute = async (call: PilotDeckToolCall): Promise<PilotDeckToolResult> => {
        const authorization = await authorize(call);
        if ("result" in authorization) return authorization.result;
        const executableCall = authorization.call;
        if (execution.abortSignal?.aborted) throw new Error("Tool execution cancelled.");
        const response = await callModule({
          runId: execution.runId,
          operationId: execution.operationId ?? options.binding?.operationId ?? execution.turnId,
          idempotencyKey: execution.idempotencyKey ?? options.binding?.idempotencyKey,
          requestId: `tool-${uuid()}`,
          module: "capability",
          payload: {
            name: executableCall.name,
            arguments: executableCall.input,
            toolCallId: executableCall.id,
            context: serializeToolContext(context),
            execution: serializeExecutionContext(execution),
          },
        });
        if (execution.abortSignal?.aborted) throw new Error("Tool execution cancelled.");

        const payload = response.payload;
        const responseError = response.error;
        const responseErrorCode = String(response.code ?? responseError?.code ?? "").toUpperCase();
        const responseErrorMessage = String(responseError?.message ?? "");
        if (
          !response.ok
          && (
            ["CANCELLED", "ABORTED", "TOOL_ABORTED"].includes(responseErrorCode)
            || /\bcancel(?:led|lation)?\b/i.test(`${responseErrorCode} ${responseErrorMessage}`)
          )
        ) {
          options.onAbort?.("tool_cancelled");
          throw new Error("Tool execution cancelled.");
        }
        if (
          response.ok
          && payload
          && typeof payload === "object"
          && payload.type === "error"
          && payload.error
          && typeof payload.error === "object"
          && (
            ["CANCELLED", "ABORTED", "TOOL_ABORTED"].includes(String((payload.error as Record<string, unknown>).code ?? "").toUpperCase())
            || /\bcancel(?:led|lation)?\b/i.test(String((payload.error as Record<string, unknown>).message ?? ""))
          )
        ) {
          options.onAbort?.("tool_cancelled");
          throw new Error("Tool execution cancelled.");
        }
        if (response.ok && payload && typeof payload === "object" && "type" in payload) {
          return payload as unknown as PilotDeckToolResult;
        }
        return moduleFailureResult(executableCall, response);
      };

      await Promise.all(concurrent.map(async ({ index, call }) => {
        resultSlots[index] = await execute(call);
      }));
      for (const { index, call } of sequential) resultSlots[index] = await execute(call);
      return resultSlots as PilotDeckToolResult[];
    },
  };
}

function permissionDecisionResult(
  call: PilotDeckToolCall,
  decision: Exclude<Awaited<ReturnType<PermissionDecisionPort["decide"]>>, { type: "allow" }>,
  context: PilotDeckToolRuntimeContext,
): PilotDeckToolResult {
  const code: PilotDeckToolErrorCode = decision.type === "deny"
    ? decision.reason.type === "runtime" && decision.reason.message.includes("prompt")
      ? "permission_required"
      : "permission_denied"
    : decision.type === "cancel"
      ? "permission_cancelled"
      : "permission_required";
  const message = decision.type === "ask"
    ? `Permission is required to run ${call.name}.`
    : decision.message;
  return createToolErrorResult({
    toolCallId: call.id,
    toolName: call.name,
    code,
    message,
    ...(decision.type === "ask" ? { details: { request: decision.request } } : {}),
    startedAt: (context.now?.() ?? new Date()).toISOString(),
    context,
  });
}

function validateBatchToolResult(result: unknown, call: PilotDeckToolCall, index: number): PilotDeckToolResult {
  if (!result || typeof result !== "object" || !("type" in result)) {
    throw new Error(`Capability batch result ${index} is invalid.`);
  }
  const toolResult = result as PilotDeckToolResult;
  if (toolResult.toolCallId !== call.id) {
    throw new Error(`Capability batch result ${index} does not match tool call ${call.id}.`);
  }
  return toolResult;
}

function moduleFailureResult(call: PilotDeckToolCall, response: ModuleResponse): PilotDeckToolResult {
  return {
    type: "error",
    toolCallId: call.id,
    toolName: call.name,
    error: {
      code: asToolErrorCode(response.code),
      message: String(response.error?.message ?? "Capability module failed."),
      ...(response.code || response.error ? {
        details: {
          ...(response.code ? { moduleCode: response.code } : {}),
          ...(response.error ? { moduleError: response.error } : {}),
        },
      } : {}),
    },
    content: [{ type: "text", text: String(response.error?.message ?? "Capability module failed.") }],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

function serializeToolContext(context: PilotDeckToolRuntimeContext): Record<string, unknown> {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    cwd: context.cwd,
    permissionMode: context.permissionMode,
    permissionContext: context.permissionContext,
    runMode: context.runMode,
    currentToolCallId: context.currentToolCallId,
    maxResultBytes: context.maxResultBytes,
  };
}

function serializeExecutionContext(execution: AgentExecutionContext): Record<string, unknown> {
  return {
    runId: execution.runId,
    turnId: execution.turnId,
    operationId: execution.operationId,
    idempotencyKey: execution.idempotencyKey,
    operationDeadline: execution.operationDeadline,
  };
}

function asToolErrorCode(value: unknown): PilotDeckToolErrorCode {
  const codes: PilotDeckToolErrorCode[] = [
    "tool_not_found",
    "tool_unavailable",
    "invalid_tool_input",
    "permission_denied",
    "permission_cancelled",
    "permission_required",
    "tool_execution_failed",
    "tool_aborted",
    "tool_timeout",
    "result_too_large",
    "path_not_allowed",
    "file_not_found",
    "file_conflict",
    "unsupported_tool",
    "setup_required",
    "plan_mode_violation",
    "ask_mode_violation",
  ];
  return typeof value === "string" && codes.includes(value as PilotDeckToolErrorCode)
    ? value as PilotDeckToolErrorCode
    : "tool_execution_failed";
}
