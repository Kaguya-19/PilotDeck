import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { TokenAccountingRuntime } from "../../context/index.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { ModelProtocol } from "../../model/index.js";
import type { PermissionDecisionPort } from "../../permission/index.js";
import type { AgentEvent, AgentEventEmitter } from "../protocol/events.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../runtime/AgentRuntimeDependencies.js";
import type { OneShotSubagentPort } from "../sub/OneShotSubagentPort.js";
import type {
  PilotDeckElicitationChannel,
  PilotDeckFileUpdateNotifier,
  PilotDeckToolAuditRecorder,
  PilotDeckToolFileHistorySink,
} from "../../tool/index.js";
import type { PlanFileManager } from "../../tool/builtin/planFile.js";
import type { PlanTodoPort } from "../../plan-todo/runtime/PlanTodoPort.js";
import type { GoalPort } from "../../goal/protocol/types.js";
import type { ModelInvokerPort, ToolPort } from "../modules/protocol.js";
import type { AgentLoopOperationLedger } from "../modules/transport/operationLedger.js";
import { createRouterModelInvokerPort, createToolSchedulerPort } from "../modules/adapters.js";

const AGENT_TURN_CAPABILITIES = Symbol("pilotdeck.agent-turn-capabilities");

export type AgentTurnRoutingPort = Pick<
  AgentRouterRuntime,
  "stream" | "materializeRequest" | "invalidateSticky"
>;

export type AgentTurnContextPort = Pick<
  AgentContextRuntime,
  | "prepareForModel"
  | "recoverFromModelError"
  | "applyToolResults"
  | "captureTurn"
  | "tryAutoCompact"
>;

export type LifecycleDispatchPort = Pick<LifecycleRuntime, "dispatch">;

export type AgentTurnModelCapabilities = {
  invoker: ModelInvokerPort;
  routing: AgentTurnRoutingPort;
  tokenAccounting?: TokenAccountingRuntime;
  getModelMaxContextTokens?: (provider: string, model: string) => number | undefined;
  getModelMaxOutputTokens?: (provider: string, model: string) => number | undefined;
  getModelTokenLimits?: (provider: string, model: string) => {
    maxContextTokens: number;
    maxOutputTokens?: number;
  } | undefined;
  getModelProtocol?: (provider: string) => ModelProtocol | undefined;
  getModelSupportsPromptCache?: (provider: string, model: string) => boolean | undefined;
};

export type AgentTurnToolCapabilities = {
  port: ToolPort;
  auditRecorder?: PilotDeckToolAuditRecorder;
  elicitation?: PilotDeckElicitationChannel;
  fileHistory?: PilotDeckToolFileHistorySink;
  fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
  planFileManager?: PlanFileManager;
  planTodoManager?: PlanTodoPort;
  goalManager?: GoalPort;
  permission?: PermissionDecisionPort;
  oneShotSubagentPort?: OneShotSubagentPort;
};

export type AgentTurnCapabilities = Readonly<{
  readonly [AGENT_TURN_CAPABILITIES]: true;
  readonly model: Readonly<AgentTurnModelCapabilities>;
  readonly tools: Readonly<AgentTurnToolCapabilities>;
  readonly context?: AgentTurnContextPort;
  readonly transport: Readonly<{ operationLedger?: AgentLoopOperationLedger }>;
  readonly hooks: Readonly<{ lifecycle?: LifecycleDispatchPort }>;
  readonly events: Readonly<{ emit?: AgentEventEmitter; drain?: () => AgentEvent[] }>;
  readonly clock: Readonly<{ now?: () => Date; uuid?: () => string }>;
}>;

/**
 * Native/direct compatibility provider for the capability view consumed by
 * AgentLoop. It selects adapters but does not own or dispose any service.
 */
export function createAgentTurnCapabilities(
  config: AgentRuntimeConfig,
  dependencies: AgentRuntimeDependencies,
): AgentTurnCapabilities {
  const model = dependencies.ports?.model ?? createRouterModelInvokerPort(dependencies.router, {
    isMainAgent: !config.isSubagent,
    projectPath: config.cwd,
  });
  const tools = dependencies.ports?.tools ?? createToolSchedulerPort(
    dependencies.tools.registry,
    dependencies.tools.scheduler,
  );
  return Object.freeze({
    [AGENT_TURN_CAPABILITIES]: true as const,
    model: Object.freeze({
      invoker: model,
      routing: dependencies.router,
      tokenAccounting: dependencies.tokenAccounting,
      getModelMaxContextTokens: dependencies.getModelMaxContextTokens,
      getModelMaxOutputTokens: dependencies.getModelMaxOutputTokens,
      getModelTokenLimits: dependencies.getModelTokenLimits,
      getModelProtocol: dependencies.getModelProtocol,
      getModelSupportsPromptCache: dependencies.getModelSupportsPromptCache,
    }),
    tools: Object.freeze({
      port: tools,
      auditRecorder: dependencies.auditRecorder,
      elicitation: dependencies.elicitation,
      fileHistory: dependencies.fileHistory,
      fileUpdateNotifier: dependencies.fileUpdateNotifier,
      planFileManager: dependencies.planFileManager,
      planTodoManager: dependencies.planTodoManager,
      goalManager: dependencies.goalManager,
      permission: dependencies.permission,
      oneShotSubagentPort: dependencies.oneShotSubagentPort,
    }),
    ...(dependencies.context ? { context: createAgentTurnContextPort(dependencies.context) } : {}),
    transport: Object.freeze({ operationLedger: dependencies.sidecarOperationLedger }),
    hooks: Object.freeze({
      lifecycle: dependencies.lifecycle
        ? createLifecycleDispatchPort(dependencies.lifecycle)
        : undefined,
    }),
    events: Object.freeze({ emit: dependencies.eventEmitter, drain: dependencies.drainEvents }),
    clock: Object.freeze({ now: dependencies.now, uuid: dependencies.uuid }),
  });
}

function createAgentTurnContextPort(runtime: AgentContextRuntime): AgentTurnContextPort {
  return Object.freeze({
    prepareForModel: (input) => runtime.prepareForModel.call(runtime, input),
    ...(runtime.recoverFromModelError
      ? { recoverFromModelError: (input: Parameters<NonNullable<AgentContextRuntime["recoverFromModelError"]>>[0]) => runtime.recoverFromModelError!.call(runtime, input) }
      : {}),
    ...(runtime.applyToolResults
      ? { applyToolResults: (input: Parameters<NonNullable<AgentContextRuntime["applyToolResults"]>>[0]) => runtime.applyToolResults!.call(runtime, input) }
      : {}),
    ...(runtime.captureTurn
      ? { captureTurn: (input: Parameters<NonNullable<AgentContextRuntime["captureTurn"]>>[0]) => runtime.captureTurn!.call(runtime, input) }
      : {}),
    ...(runtime.tryAutoCompact
      ? { tryAutoCompact: (input: Parameters<NonNullable<AgentContextRuntime["tryAutoCompact"]>>[0]) => runtime.tryAutoCompact!.call(runtime, input) }
      : {}),
  });
}

function createLifecycleDispatchPort(runtime: LifecycleRuntime): LifecycleDispatchPort {
  return Object.freeze({
    dispatch: (input) => runtime.dispatch.call(runtime, input),
  });
}

export function isAgentTurnCapabilities(value: unknown): value is AgentTurnCapabilities {
  return typeof value === "object"
    && value !== null
    && (value as Partial<AgentTurnCapabilities>)[AGENT_TURN_CAPABILITIES] === true;
}
