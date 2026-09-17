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
  PreparedModelInvocation,
  ModuleCallRequest,
  ModuleResponse,
  ToolPort,
  ToolAuthorizationPort,
} from "../protocol.js";

export type SidecarExecutionPorts = Readonly<{
  model: ModelInvokerPort;
  toolExecution: ToolPort;
  toolAuthorization?: ToolAuthorizationPort;
}>;

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
    deserializeTools?: (value: unknown) => PilotDeckToolDefinition[];
    permission?: PermissionDecisionPort;
    authorization?: ToolAuthorizationPort;
    binding?: SidecarModuleBinding;
    uuid?: () => string;
    modelMethods?: readonly HostModelModuleMethod[];
    onPreparedMetadata?: (metadata: unknown, prepared: PreparedModelInvocation) => void;
    capabilityMethods?: readonly HostCapabilityModuleMethod[];
    onAbort?: (reason: string) => void;
  } = {},
): SidecarExecutionPorts {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  const capability = createHostCapabilityToolPort(callModule, {
    tools: options.tools,
    binding: options.binding,
    uuid,
    methods: options.capabilityMethods,
    deserializeTools: options.deserializeTools,
    onAbort: options.onAbort,
  });
  const authorization = options.authorization
    ?? (options.permission
      ? createPermissionToolAuthorizationPort({
          permission: options.permission,
          findTool: (name) => capability.list().find((tool) => tool.name === name),
        })
      : undefined);
  return {
    model: createHostModelInvokerPort(callModule, {
      uuid,
      methods: options.modelMethods,
      onPreparedMetadata: options.onPreparedMetadata,
    }),
    toolExecution: createPermissionAwareToolPort(capability, {
    tools: options.tools,
    authorization,
    preserveBatch: options.capabilityMethods?.includes("execute_batch") ?? false,
  }),
    ...(authorization ? { toolAuthorization: authorization } : {}),
  };
}
