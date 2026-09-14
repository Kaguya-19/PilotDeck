import type {
  AgentContextPrepareInput,
  AgentPreparedContext,
  AgentContextRecoveryInput,
  AgentContextToolResultInput,
  AgentContextToolResultResult,
  AgentContextCaptureTurnInput,
} from "../../context/ContextRuntime.js";
import { NullContextRuntime } from "../../context/NullContextRuntime.js";
import type { TokenAccountingRuntime } from "../../context/index.js";
import type { AutoCompactResult, CompactionAutoCompactInput } from "../../context/compaction/CompactionPort.js";
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
  {
    prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext>;
    recoverFromModelError?(input: AgentContextRecoveryInput): Promise<import("../../context/index.js").ContextRecoveryDecision>;
    applyToolResults?(input: AgentContextToolResultInput): Promise<AgentContextToolResultResult>;
    captureTurn?(input: AgentContextCaptureTurnInput): Promise<void>;
    tryAutoCompact?(input: CompactionAutoCompactInput): Promise<AutoCompactResult>;
  },
  "prepareForModel" | "recoverFromModelError" | "applyToolResults" | "captureTurn" | "tryAutoCompact"
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

export type ToolExecutionPort = ToolPort & {
  auditRecorder?: PilotDeckToolAuditRecorder;
  fileHistory?: PilotDeckToolFileHistorySink;
  fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
};

export type PermissionPort = PermissionDecisionPort;

export type InteractionPort = Readonly<{
  elicitation?: PilotDeckElicitationChannel;
}>;

export type PlanModePort = Readonly<{
  planFileManager?: PlanFileManager;
  planTodoManager?: PlanTodoPort;
}>;

export type SubagentPort = Readonly<{
  oneShot?: OneShotSubagentPort;
}>;

/** @deprecated Use the consumer-specific AgentTurnCapabilities ports. */
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

const NOOP_CONTEXT = Symbol("pilotdeck.agent-turn-noop-context");

type InternalAgentTurnContextPort = AgentTurnContextPort & { readonly [NOOP_CONTEXT]?: true };

export type AgentTurnCapabilities = Readonly<{
  readonly [AGENT_TURN_CAPABILITIES]: true;
  readonly model: Readonly<AgentTurnModelCapabilities>;
  readonly toolExecution: Readonly<ToolExecutionPort>;
  readonly permission?: PermissionPort;
  readonly interaction: InteractionPort;
  readonly planMode: PlanModePort;
  readonly subagent: SubagentPort;
  readonly goal?: GoalPort;
  readonly context: AgentTurnContextPort;
  /** @deprecated Use toolExecution, permission, interaction, planMode, subagent, and goal. */
  readonly tools: Readonly<AgentTurnToolCapabilities>;
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
  const toolExecution = dependencies.ports?.tools ?? createToolSchedulerPort(
    dependencies.tools.registry,
    dependencies.tools.scheduler,
  );
  const context = dependencies.context
    ? createAgentTurnContextPort(dependencies.context)
    : createNoopAgentTurnContextPort();
  const toolExecutionView = createToolExecutionPort(toolExecution, {
    auditRecorder: dependencies.auditRecorder,
    fileHistory: dependencies.fileHistory,
    fileUpdateNotifier: dependencies.fileUpdateNotifier,
  });
  const interaction = Object.freeze({ elicitation: dependencies.elicitation });
  const planMode = Object.freeze({
    planFileManager: dependencies.planFileManager,
    planTodoManager: dependencies.planTodoManager,
  });
  const subagent = Object.freeze({ oneShot: dependencies.oneShotSubagentPort });
  const legacyTools = Object.freeze({
    port: toolExecutionView,
    auditRecorder: dependencies.auditRecorder,
    elicitation: dependencies.elicitation,
    fileHistory: dependencies.fileHistory,
    fileUpdateNotifier: dependencies.fileUpdateNotifier,
    planFileManager: dependencies.planFileManager,
    planTodoManager: dependencies.planTodoManager,
    goalManager: dependencies.goalManager,
    permission: dependencies.permission,
    oneShotSubagentPort: dependencies.oneShotSubagentPort,
  });
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
    toolExecution: toolExecutionView,
    permission: dependencies.permission,
    interaction,
    planMode,
    subagent,
    goal: dependencies.goalManager,
    context,
    tools: legacyTools,
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

function createToolExecutionPort(
  port: ToolPort,
  extensions: Omit<ToolExecutionPort, keyof ToolPort>,
): Readonly<ToolExecutionPort> {
  // Do not spread the injected port: implementations can keep methods on a
  // prototype or rely on `this`. The narrow frozen view preserves both cases.
  return Object.freeze({
    list: () => port.list.call(port),
    executeAll: (calls, context, execution) => port.executeAll.call(port, calls, context, execution),
    ...extensions,
  });
}

function createAgentTurnContextPort(runtime: {
  prepareForModel: AgentTurnContextPort["prepareForModel"];
  recoverFromModelError?: NonNullable<AgentTurnContextPort["recoverFromModelError"]>;
  applyToolResults?: NonNullable<AgentTurnContextPort["applyToolResults"]>;
  captureTurn?: NonNullable<AgentTurnContextPort["captureTurn"]>;
  tryAutoCompact?: NonNullable<AgentTurnContextPort["tryAutoCompact"]>;
}): AgentTurnContextPort {
  return Object.freeze({
    prepareForModel: (input) => runtime.prepareForModel.call(runtime, input),
    ...(runtime.recoverFromModelError
      ? { recoverFromModelError: (input: AgentContextRecoveryInput) => runtime.recoverFromModelError!.call(runtime, input) }
      : {}),
    ...(runtime.applyToolResults
      ? { applyToolResults: (input: AgentContextToolResultInput) => runtime.applyToolResults!.call(runtime, input) }
      : {}),
    ...(runtime.captureTurn
      ? { captureTurn: (input: AgentContextCaptureTurnInput) => runtime.captureTurn!.call(runtime, input) }
      : {}),
    ...(runtime.tryAutoCompact
      ? { tryAutoCompact: (input: CompactionAutoCompactInput) => runtime.tryAutoCompact!.call(runtime, input) }
      : {}),
  });
}

function createNoopAgentTurnContextPort(): AgentTurnContextPort {
  // Keep the established fallback semantics in composition. AgentLoop sees
  // only the narrow port, while direct/native runs without a session context
  // still receive NullContextRuntime's tool-pair-safe max-message handling.
  const runtime = new NullContextRuntime();
  const port: InternalAgentTurnContextPort = {
    [NOOP_CONTEXT]: true,
    prepareForModel: (input) => runtime.prepareForModel(input),
  };
  return Object.freeze(port);
}

export function isNoopAgentTurnContextPort(value: AgentTurnContextPort): boolean {
  return (value as InternalAgentTurnContextPort)[NOOP_CONTEXT] === true;
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
