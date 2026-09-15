import type { PilotDeckToolDefinition } from "../../../tool/index.js";
import type { PermissionDecisionPort } from "../../../permission/index.js";
import {
  createHostCapabilityToolPort,
  createPermissionAwareToolPort,
  createPermissionToolAuthorizationPort,
} from "../capability/hostToolPort.js";
import { createHostModelInvokerPort } from "../llm/hostModelInvokerPort.js";
import type {
  HostCapabilityModuleMethod,
  HostModelModuleMethod,
  ModelInvokerPort,
  ModuleCallRequest,
  ModuleResponse,
  ToolPort,
  ToolAuthorizationPort,
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
    authorization?: ToolAuthorizationPort;
    binding?: SidecarModuleBinding;
    uuid?: () => string;
    modelMethods?: readonly HostModelModuleMethod[];
    capabilityMethods?: readonly HostCapabilityModuleMethod[];
    onAbort?: (reason: string) => void;
  } = {},
): { model: ModelInvokerPort; tools: ToolPort; authorization?: ToolAuthorizationPort } {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  const capability = createHostCapabilityToolPort(callModule, {
    tools: options.tools,
    binding: options.binding,
    uuid,
    methods: options.capabilityMethods,
    onAbort: options.onAbort,
  });
  const authorization = options.authorization
    ?? (options.permission ? createPermissionToolAuthorizationPort({ tools: options.tools, permission: options.permission }) : undefined);
  return {
    model: createHostModelInvokerPort(callModule, { uuid, methods: options.modelMethods }),
    tools: createPermissionAwareToolPort(capability, {
      tools: options.tools,
      authorization,
    }),
    ...(authorization ? { authorization } : {}),
  };
}
