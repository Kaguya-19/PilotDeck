import type { PermissionDecision, PermissionDecisionPort } from "../../../permission/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../../tool/index.js";
import type { ModuleCallRequest, ModuleResponse } from "../protocol.js";

type PermissionModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
};

export type HostPermissionModuleClient = (request: PermissionModuleCall) => Promise<ModuleResponse>;

export type HostPermissionModuleBinding = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

export type HostPermissionDecisionPortOptions = {
  uuid?: () => string;
};

/** PermissionDecisionPort consumer backed by a host-owned permission module. */
export function createHostPermissionDecisionPort(
  callModule: HostPermissionModuleClient,
  binding: HostPermissionModuleBinding,
  options: HostPermissionDecisionPortOptions = {},
): PermissionDecisionPort {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  return {
    async decide(tool, input, context, toolCallId) {
      const response = await callModule({
        ...binding,
        requestId: `permission-decide-${uuid()}`,
        module: "permission",
        payload: {
          operation: "decide",
          tool: serializeToolDescriptor(tool, input),
          input,
          context: serializePermissionContext(context),
          toolCallId,
        },
      });
      if (!response.ok) {
        const failure = new Error(
          String(response.error?.message ?? response.code ?? "Permission module failed."),
        ) as Error & { code?: string };
        failure.code = response.code;
        throw failure;
      }
      const decision = response.payload?.decision;
      if (!isPermissionDecision(decision)) {
        const failure = new Error("Permission module response must contain a valid decision.") as Error & { code?: string };
        failure.code = "INVALID_PERMISSION_RESPONSE";
        throw failure;
      }
      return decision;
    },
  };
}

function serializeToolDescriptor(tool: PilotDeckToolDefinition, input: unknown): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
    ...(tool.requiredRuntimeCapabilities
      ? { requiredRuntimeCapabilities: [...tool.requiredRuntimeCapabilities] }
      : {}),
    inputSchema: tool.inputSchema,
    readOnly: tool.isReadOnly(input),
    requiresUserInteraction: tool.requiresUserInteraction?.(input) ?? false,
  };
}

function serializePermissionContext(context: PilotDeckToolRuntimeContext): Record<string, unknown> {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    cwd: context.cwd,
    permissionMode: context.permissionMode,
    permissionContext: context.permissionContext,
    runMode: context.runMode,
    currentToolCallId: context.currentToolCallId,
  };
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Record<string, unknown>;
  if (!decision.reason || typeof decision.reason !== "object") return false;
  if (decision.type === "allow") return true;
  if (decision.type === "deny" || decision.type === "cancel") return typeof decision.message === "string";
  if (decision.type === "ask") return Boolean(decision.request && typeof decision.request === "object");
  return false;
}
