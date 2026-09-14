import type { PilotDeckToolDefinition } from "../../../tool/index.js";
import type { PermissionDecisionPort } from "../../../permission/index.js";
import { createHostCapabilityToolPort } from "../capability/hostToolPort.js";
import { createHostModelInvokerPort } from "../llm/hostModelInvokerPort.js";
import type {
  HostCapabilityModuleMethod,
  HostModelModuleMethod,
  ModelInvokerPort,
  ModuleCallRequest,
  ModuleResponse,
  ToolPort,
} from "../protocol.js";

export type SidecarModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  /** Internal aggregation hint; it is not serialized into Module Protocol. */
  recordFailure?: boolean;
};

export type SidecarModuleCallClient = (request: SidecarModuleCall) => Promise<ModuleResponse>;

export type SidecarModuleBinding = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

/** Compose AgentLoop ports backed by host-owned modules. */
export function createSidecarPorts(
  callModule: SidecarModuleCallClient,
  options: {
    tools?: PilotDeckToolDefinition[];
    permission?: PermissionDecisionPort;
    binding?: SidecarModuleBinding;
    uuid?: () => string;
    modelMethods?: readonly HostModelModuleMethod[];
    capabilityMethods?: readonly HostCapabilityModuleMethod[];
    onAbort?: (reason: string) => void;
  } = {},
): { model: ModelInvokerPort; tools: ToolPort } {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  return {
    model: createHostModelInvokerPort(callModule, { uuid, methods: options.modelMethods }),
    tools: createHostCapabilityToolPort(callModule, {
      tools: options.tools,
      permission: options.permission,
      binding: options.binding,
      uuid,
      methods: options.capabilityMethods,
      onAbort: options.onAbort,
    }),
  };
}
