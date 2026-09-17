import type { AgentEvent, AgentEventEmitter } from "../../protocol/events.js";
import type {
  AgentTurnCapabilities,
  AgentTurnContextPort,
  AuxiliaryModelPort,
  InteractionPort,
  LifecycleDispatchPort,
  ModelBudgetPort,
  ModelMetadataPort,
  PermissionPort,
  PlanModePort,
  SubagentPort,
  ToolExecutionPort,
  ToolResultObserver,
  ModelExecutionPort,
  AgentTurnRoutingPort,
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
  metadata?: ModelMetadataPort;
  /** Resolves host-owned routing state once for an active sidecar turn. */
  bindTurn?(input: Readonly<{ sessionId: string; turnId: string }>): SidecarModelModulePort;
}>;

export type SidecarBudgetModulePort = ModelBudgetPort;

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
export type SidecarEventModulePort = Readonly<{
  emit: AgentEventEmitter;
  drain?: () => AgentEvent[];
}>;

export type SidecarToolContextPorts = Readonly<{
  model?: AuxiliaryModelPort;
  interaction?: InteractionPort;
  planMode?: PlanModePort;
  subagent?: SubagentPort;
  goal?: GoalPort;
  toolExecution?: Pick<ToolExecutionPort, "auditRecorder" | "fileHistory" | "fileUpdateNotifier">;
  /** Host event sink used for transient tool progress. */
  eventEmitter?: AgentEventEmitter;
  clock?: Readonly<{ now?: () => Date }>;
}>;

/** The only domain composition shape consumed by a sidecar turn. */
export type SidecarModuleComposition = Readonly<{
  model: SidecarModelModulePort;
  budget?: SidecarBudgetModulePort;
  interaction?: Readonly<{ elicitationAvailable: boolean }>;
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
  /** Host-only routing view used to bind model execution per turn. */
  routing?: Pick<AgentTurnRoutingPort, "invalidateSticky">;
  metadata?: ModelMetadataPort;
  budget?: ModelBudgetPort;
  toolExecution: ToolExecutionPort;
  toolResultObserver?: ToolResultObserver;
  permission?: PermissionPort;
  context?: AgentTurnContextPort;
  lifecycle?: LifecycleDispatchPort;
  eventEmitter?: AgentEventEmitter;
  drainEvents?: () => AgentEvent[];
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
    eventEmitter: ports.eventEmitter,
    clock: ports.clock,
  });
  const runtimeContext = createSidecarToolRuntimeServices(toolContext);
  const permissionContext = createSidecarPermissionRequestContextServices(toolContext);
  const contextIdentity = createSidecarContextRequestIdentityServices(toolContext);
  return Object.freeze({
    model: createSidecarModelModulePort(ports),
    ...(ports.budget ? { budget: ports.budget } : {}),
    ...(ports.interaction?.elicitationAvailable === true || ports.interaction?.elicitation
      ? { interaction: Object.freeze({ elicitationAvailable: true }) }
      : {}),
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
    ...(ports.eventEmitter ? {
      event: Object.freeze({
        emit: ports.eventEmitter,
        ...(ports.drainEvents ? { drain: ports.drainEvents } : {}),
      }),
    } : {}),
  });
}

/** @deprecated Native compatibility projection; compose SidecarHostModulePorts directly for new sidecars. */
export function createSidecarHostModulePorts(
  capabilities: AgentTurnCapabilities,
): SidecarHostModulePorts {
  return Object.freeze({
    model: capabilities.model.execution,
    ...(capabilities.model.routing ? { routing: capabilities.model.routing } : {}),
    ...(hasModelMetadata(capabilities.model.metadata) ? { metadata: capabilities.model.metadata } : {}),
    budget: capabilities.model.budget,
    toolExecution: capabilities.toolExecution,
    toolResultObserver: capabilities.toolResultObserver,
    permission: capabilities.permission,
    ...(isNoopAgentTurnContextPort(capabilities.context) ? {} : { context: capabilities.context }),
    lifecycle: capabilities.hooks.lifecycle,
    eventEmitter: capabilities.events.emit,
    drainEvents: capabilities.events.drain,
    auxiliaryModel: capabilities.model.auxiliary,
    interaction: capabilities.interaction,
    planMode: capabilities.planMode,
    subagent: capabilities.subagent,
    goal: capabilities.goal,
    toolRuntimeServices: capabilities.toolExecution,
    clock: capabilities.clock,
  });
}

function createSidecarModelModulePort(ports: SidecarHostModulePorts): SidecarModelModulePort {
  const metadata = hasModelMetadata(ports.metadata) ? { metadata: ports.metadata } : {};
  if (!ports.routing?.invalidateSticky) {
    return Object.freeze({ execution: ports.model, ...metadata });
  }
  return Object.freeze({
    execution: ports.model,
    ...metadata,
    bindTurn: ({ sessionId }) => {
      const sticky = ports.routing!.invalidateSticky!(sessionId);
      let previousTier = sticky?.previousTier;
      const routeMetadata = (): Record<string, unknown> | undefined => {
        if (sticky) {
          return {
            ...(previousTier ? { previousTier } : {}),
            ...(sticky.previousProvider ? { previousProvider: sticky.previousProvider } : {}),
            ...(sticky.previousModel ? { previousModel: sticky.previousModel } : {}),
          };
        }
        return previousTier ? { previousTier } : undefined;
      };
      const execution: ModelExecutionPort = Object.freeze({
        prepare: ({ request, context }) => ports.model.prepare.call(ports.model, {
          request,
          context: {
            ...context,
            ...(routeMetadata()
              ? { metadata: { ...context.metadata, ...routeMetadata() } }
              : {}),
          },
        }),
        async *stream(input) {
          try {
            yield* ports.model.stream.call(ports.model, input);
          } finally {
            if (!sticky?.orchestrating) previousTier = undefined;
          }
        },
      });
      return Object.freeze({ execution, ...metadata });
    },
  });
}

function hasModelMetadata(metadata: ModelMetadataPort | undefined): metadata is ModelMetadataPort {
  return metadata?.getModelMaxContextTokens !== undefined
    || metadata?.getModelMaxOutputTokens !== undefined
    || metadata?.getModelTokenLimits !== undefined
    || metadata?.getModelProtocol !== undefined
    || metadata?.getModelSupportsPromptCache !== undefined;
}
