import type { AgentEventEmitter } from "../../protocol/events.js";
import type {
  AgentTurnCapabilities,
  AgentTurnContextPort,
  AuxiliaryModelPort,
  InteractionPort,
  LifecycleDispatchPort,
  PermissionPort,
  PlanModePort,
  SubagentPort,
  ToolExecutionPort,
  ToolResultObserver,
  ModelExecutionPort,
} from "../../loop/AgentTurnCapabilities.js";
import { isNoopAgentTurnContextPort } from "../../loop/AgentTurnCapabilities.js";
import type { GoalPort } from "../../../goal/protocol/types.js";
import type { PermissionContext } from "../../../permission/index.js";
import type { PilotDeckPlanTodoStateHandle } from "../../../tool/protocol/types.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../../tool/index.js";
import type { AgentExecutionContext, ModuleCallRequest } from "../protocol.js";
import type { AgentLoopInput } from "../../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import type { HostToolCheckpoint } from "../checkpoint/hostToolCheckpoint.js";
import type { AgentLoopOperationLedger } from "./operationLedger.js";
import type { AgentLoopSidecarTransportObserver } from "./sidecarTransportObserver.js";
import {
  createSidecarContextRequestIdentityServices,
  createSidecarPermissionRequestContextServices,
  createSidecarToolRuntimeServices,
} from "./sidecarToolContext.js";

export type SidecarModelModulePort = Readonly<{
  execution: ModelExecutionPort;
}>;

export type SidecarCapabilityModulePort = Readonly<{
  execution: ToolExecutionPort;
  resultObserver?: ToolResultObserver;
  runtimeContext: SidecarToolRuntimeServicesPort;
}>;

export type SidecarPermissionModulePort = Readonly<{
  decision: PermissionPort;
  catalog: ToolCatalogPort;
  requestContext: PermissionRequestContextServicesPort;
}>;

export type SidecarPlanTodoModulePort = Readonly<{
  forSession(sessionId: string): PilotDeckPlanTodoStateHandle | undefined;
}>;

export type ToolCatalogPort = Readonly<{
  list(): readonly PilotDeckToolDefinition[];
}>;

/** Opaque tool-runtime builder consumed by capability dispatch only. */
export type ToolRuntimeContextFactoryPort = Readonly<{
  permissionContext(): PermissionContext;
  toolRuntimeContext(
    value: unknown,
    planTodo?: PilotDeckPlanTodoStateHandle,
    includeOneShotSubagent?: boolean,
  ): PilotDeckToolRuntimeContext;
  executionContext(call: ModuleCallRequest): AgentExecutionContext;
  contextIdentity(source: Record<string, unknown> | undefined): Record<string, unknown>;
}>;

export type SidecarTurnContextBinding = Readonly<{
  config: AgentRuntimeConfig;
  input: AgentLoopInput;
  checkpoint: HostToolCheckpoint;
}>;

/** Turn-bound context construction service. Raw tool services stay private. */
export type SidecarToolRuntimeServicesPort = Readonly<{
  bindTurn(binding: SidecarTurnContextBinding): ToolRuntimeContextFactoryPort;
}>;

/** Narrow permission consumer view; it cannot inspect capability execution. */
export type PermissionRequestContextPort = Readonly<{
  toolRuntimeContext(value: unknown): PilotDeckToolRuntimeContext;
}>;

export type PermissionRequestContextServicesPort = Readonly<{
  bindTurn(binding: SidecarTurnContextBinding): PermissionRequestContextPort;
}>;

export type ContextRequestIdentityPort = Readonly<{
  contextIdentity(source: Record<string, unknown> | undefined): Record<string, unknown>;
}>;

export type ContextRequestIdentityServicesPort = Readonly<{
  bindTurn(binding: SidecarTurnContextBinding): ContextRequestIdentityPort;
}>;

export type SidecarContextModulePort = Readonly<{
  execution: AgentTurnContextPort;
  requestIdentity: ContextRequestIdentityServicesPort;
}>;
export type SidecarLifecycleModulePort = LifecycleDispatchPort;
export type SidecarEventModulePort = Readonly<{ emit: AgentEventEmitter }>;

export type SidecarToolContextPorts = Readonly<{
  model?: AuxiliaryModelPort;
  interaction?: InteractionPort;
  planMode?: PlanModePort;
  subagent?: SubagentPort;
  goal?: GoalPort;
  toolExecution?: Pick<ToolExecutionPort, "auditRecorder" | "fileHistory" | "fileUpdateNotifier">;
  clock?: Readonly<{ now?: () => Date }>;
}>;

/** The only domain composition shape consumed by a sidecar turn. */
export type SidecarModuleComposition = Readonly<{
  model: SidecarModelModulePort;
  capability: SidecarCapabilityModulePort;
  permission?: SidecarPermissionModulePort;
  planTodo?: SidecarPlanTodoModulePort;
  context?: SidecarContextModulePort;
  lifecycle?: SidecarLifecycleModulePort;
  event?: SidecarEventModulePort;
}>;

/**
 * Narrow host capability view consumed by one sidecar protocol turn.
 *
 * The sidecar transport never receives AgentTurnCapabilities directly. This
 * adapter is the sole compatibility boundary for native/session composition.
 */
export type SidecarHostModulePorts = Readonly<{
  model: ModelExecutionPort;
  toolExecution: ToolExecutionPort;
  toolResultObserver?: ToolResultObserver;
  permission?: PermissionPort;
  context?: AgentTurnContextPort;
  lifecycle?: LifecycleDispatchPort;
  eventEmitter?: AgentEventEmitter;
  auxiliaryModel?: AuxiliaryModelPort;
  interaction?: InteractionPort;
  planMode?: PlanModePort;
  subagent?: SubagentPort;
  goal?: GoalPort;
  toolRuntimeServices?: Pick<ToolExecutionPort, "auditRecorder" | "fileHistory" | "fileUpdateNotifier">;
  clock?: Readonly<{ now?: () => Date }>;
}>;

/** Immutable transport-only identity. It deliberately excludes domain ports and messages. */
export type SidecarTransportTurn = Readonly<{
  sessionId: string;
  turnId: string;
  runId: string;
  operationId: string;
  idempotencyKey?: string;
  operationDeadline?: string;
}>;

/** Transport/session-owned facts; never part of a domain capability view. */
export type SidecarTransportContext = Readonly<{
  operationLedger?: AgentLoopOperationLedger;
  transportObserver?: AgentLoopSidecarTransportObserver;
}>;

/** Project a legacy/native capability facade once, outside sidecar transport. */
export function createSidecarModuleComposition(
  ports: SidecarHostModulePorts,
): SidecarModuleComposition {
  const toolContext = Object.freeze({
    model: ports.auxiliaryModel,
    interaction: ports.interaction,
    planMode: ports.planMode,
    subagent: ports.subagent,
    goal: ports.goal,
    toolExecution: ports.toolRuntimeServices,
    clock: ports.clock,
  });
  const runtimeContext = createSidecarToolRuntimeServices(toolContext);
  const permissionContext = createSidecarPermissionRequestContextServices(toolContext);
  const contextIdentity = createSidecarContextRequestIdentityServices(toolContext);
  return Object.freeze({
    model: Object.freeze({ execution: ports.model }),
    capability: Object.freeze({
      execution: ports.toolExecution,
      resultObserver: ports.toolResultObserver,
      runtimeContext,
    }),
    ...(ports.permission
      ? {
          permission: Object.freeze({
            decision: ports.permission,
            catalog: Object.freeze({ list: () => ports.toolExecution.list() }),
            requestContext: permissionContext,
          }),
        }
      : {}),
    ...(ports.context ? { context: Object.freeze({ execution: ports.context, requestIdentity: contextIdentity }) } : {}),
    ...(ports.planMode?.planTodoManager ? {
      planTodo: Object.freeze({
        forSession: (sessionId: string) => ports.planMode?.planTodoManager?.forSession(sessionId),
      }),
    } : {}),
    ...(ports.lifecycle ? { lifecycle: ports.lifecycle } : {}),
    ...(ports.eventEmitter ? { event: Object.freeze({ emit: ports.eventEmitter }) } : {}),
  });
}

/** @deprecated Native compatibility projection; compose SidecarHostModulePorts directly for new sidecars. */
export function createSidecarHostModulePorts(
  capabilities: AgentTurnCapabilities,
): SidecarHostModulePorts {
  return Object.freeze({
    model: capabilities.model.execution,
    toolExecution: capabilities.toolExecution,
    toolResultObserver: capabilities.toolResultObserver,
    permission: capabilities.permission,
    ...(isNoopAgentTurnContextPort(capabilities.context) ? {} : { context: capabilities.context }),
    lifecycle: capabilities.hooks.lifecycle,
    eventEmitter: capabilities.events.emit,
    auxiliaryModel: capabilities.model.auxiliary,
    interaction: capabilities.interaction,
    planMode: capabilities.planMode,
    subagent: capabilities.subagent,
    goal: capabilities.goal,
    toolRuntimeServices: capabilities.toolExecution,
    clock: capabilities.clock,
  });
}
