import type {
  AgentContextPrepareInput,
  AgentPreparedContext,
  AgentContextRecoveryInput,
  AgentContextToolResultInput,
  AgentContextToolResultResult,
  AgentContextCaptureTurnInput,
} from "../../context/ContextRuntime.js";
import { NullContextRuntime } from "../../context/NullContextRuntime.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { TokenAccountingRuntime } from "../../context/index.js";
import type { AutoCompactResult, CompactionAutoCompactInput } from "../../context/compaction/CompactionPort.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { ModelProtocol } from "../../model/index.js";
import type { PermissionDecisionPort } from "../../permission/index.js";
import type { AgentEvent, AgentEventEmitter } from "../protocol/events.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { OneShotSubagentPort } from "../sub/OneShotSubagentPort.js";
import type {
  PilotDeckElicitationChannel,
  PilotDeckFileUpdateNotifier,
  PilotDeckToolAuditRecorder,
  PilotDeckToolFileHistorySink,
  PilotDeckToolDefinition,
  PilotDeckUserDialogChannel,
} from "../../tool/index.js";
import type { PlanFileManager } from "../../tool/builtin/planFile.js";
import type { PlanTodoPort } from "../../plan-todo/runtime/PlanTodoPort.js";
import type { GoalPort } from "../../goal/protocol/types.js";
import type { ModelInvokerPort, PreparedModelInvocation, ToolAuthorizationPort, ToolPort } from "../modules/protocol.js";
import type { CanonicalModelEvent, CanonicalModelRequest, CanonicalUsage } from "../../model/index.js";
import type { AgentLoopOperationLedger } from "../modules/transport/operationLedger.js";

const AGENT_TURN_CAPABILITIES = Symbol("pilotdeck.agent-turn-capabilities");

export type ModelRouteIdentity = Readonly<{
  provider: string;
  model: string;
}>;

export type AgentTurnRoutingPort = Readonly<{
  invalidateSticky?(sessionId: string): { previousTier?: string; previousProvider?: string; previousModel?: string; orchestrating?: boolean } | undefined;
  materializeRequest?(prepared: PreparedModelInvocation, request: CanonicalModelRequest): CanonicalModelRequest;
}>;

/**
 * Sidecar-only composition input. It deliberately has no router or legacy
 * dependency bag; the transport supplies consumer ports directly.
 */
export type SidecarAgentLoopPorts = Readonly<{
  /** Required primary-model and raw tool execution consumers. */
  model: ModelExecutionPort;
  toolExecution: ToolPort;
  /** Optional policy and model extensions supplied by the host composition. */
  toolAuthorization?: ToolAuthorizationPort;
  routing?: AgentTurnRoutingPort;
  metadata?: ModelMetadataPort;
  budget?: ModelBudgetPort;
  auxiliary?: AuxiliaryModelPort;
}>;

/**
 * Sidecar-only composition input. It deliberately has no router, registry,
 * scheduler, or AgentRuntimeDependencies reference. The sidecar receives
 * already-adapted consumer ports from its host composition.
 */
export type SidecarAgentTurnCapabilityComposition = {
  ports: SidecarAgentLoopPorts;
  permission?: PermissionPort;
  context?: AgentTurnContextPort;
  lifecycle?: LifecycleDispatchPort;
  eventEmitter?: AgentEventEmitter;
  drainEvents?: () => AgentEvent[];
  now?: () => Date;
  uuid?: () => string;
  sidecarOperationLedger?: AgentLoopOperationLedger;
  auditRecorder?: PilotDeckToolAuditRecorder;
  elicitation?: PilotDeckElicitationChannel;
  elicitationAvailable?: boolean;
  userDialog?: PilotDeckUserDialogChannel;
  fileHistory?: PilotDeckToolFileHistorySink;
  fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
  planFileManager?: PlanFileManager;
  planTodoManager?: PlanTodoPort;
  goalManager?: GoalPort;
  oneShotSubagentPort?: OneShotSubagentPort;
  toolResultObserver?: ToolResultObserver;
};

/** Primary model execution contract consumed by the loop. */
export type ModelExecutionPort = ModelInvokerPort;

/** Model metadata lookup kept independent from execution and routing policy. */
export type ModelMetadataPort = Readonly<{
  getModelMaxContextTokens?: (provider: string, model: string) => number | undefined;
  getModelMaxOutputTokens?: (provider: string, model: string) => number | undefined;
  getModelTokenLimits?: (provider: string, model: string) => {
    maxContextTokens: number;
    maxOutputTokens?: number;
  } | undefined;
  getModelProtocol?: (provider: string) => ModelProtocol | undefined;
  getModelSupportsPromptCache?: (provider: string, model: string) => boolean | undefined;
}>;

/** Token estimation and budget evaluation consumed by compaction logic. */
export type ModelBudgetPort = Readonly<{
  estimateRequestInput?: (
    ...args: Parameters<TokenAccountingRuntime["estimateRequestInput"]>
  ) => number | Promise<number>;
  evaluateRequestBudget?: TokenAccountingRuntime["evaluateRequestBudget"];
  estimateUsageCost?: (
    usage: CanonicalUsage | undefined,
    provider: string,
    model: string,
  ) => number | undefined | Promise<number | undefined>;
}>;

/** Secondary model client for tools and subagent helpers. */
export type AuxiliaryModelPort = Readonly<{
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
  /** Optional composition-time turn binding for legacy providers. */
  forTurn?(context: { sessionId: string; turnId: string; projectPath?: string }): AuxiliaryModelPort;
}>;

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

export type ContextPreparationPort = Pick<AgentTurnContextPort, "prepareForModel">;
export type ContextRecoveryPort = Required<Pick<AgentTurnContextPort, "recoverFromModelError">>;
export type ContextToolResultPort = Required<Pick<AgentTurnContextPort, "applyToolResults">>;
export type ContextCapturePort = Required<Pick<AgentTurnContextPort, "captureTurn">>;
export type ContextCompactionPort = Required<Pick<AgentTurnContextPort, "tryAutoCompact">>;

export type LifecycleDispatchPort = Pick<LifecycleRuntime, "dispatch">;

export type AgentTurnModelCapabilities = {
  execution: ModelExecutionPort;
  routing?: AgentTurnRoutingPort;
  metadata: ModelMetadataPort;
  budget?: ModelBudgetPort;
  auxiliary?: AuxiliaryModelPort;
  /** Native compatibility only; sidecar never enables this fallback. */
  legacyAuxiliaryFallback?: boolean;
  /** @deprecated Use execution. */
  invoker: ModelExecutionPort;
  /** @deprecated Use budget. */
  tokenAccounting?: ModelBudgetPort;
  /** @deprecated Use metadata. */
  getModelMaxContextTokens?: ModelMetadataPort["getModelMaxContextTokens"];
  /** @deprecated Use metadata. */
  getModelMaxOutputTokens?: ModelMetadataPort["getModelMaxOutputTokens"];
  /** @deprecated Use metadata. */
  getModelTokenLimits?: ModelMetadataPort["getModelTokenLimits"];
  /** @deprecated Use metadata. */
  getModelProtocol?: ModelMetadataPort["getModelProtocol"];
  /** @deprecated Use metadata. */
  getModelSupportsPromptCache?: ModelMetadataPort["getModelSupportsPromptCache"];
};

export type ToolExecutionPort = ToolPort & {
  auditRecorder?: PilotDeckToolAuditRecorder;
  fileHistory?: PilotDeckToolFileHistorySink;
  fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
};

/** Observes completed tool invocations without becoming part of execution. */
export type ToolResultObserver = Readonly<{
  onToolResults(input: {
    sessionId: string;
    turnId: string;
    results: readonly import("../../tool/index.js").PilotDeckToolResult[];
  }): void | Promise<void>;
}>;

export type { ToolAuthorizationPort } from "../modules/protocol.js";

export type PermissionPort = PermissionDecisionPort;

export type InteractionPort = Readonly<{
  elicitation?: PilotDeckElicitationChannel;
  elicitationAvailable?: boolean;
  userDialog?: PilotDeckUserDialogChannel;
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
  /** @deprecated Use port.list(). */
  registry?: AgentRuntimeDependenciesCompatibilityToolRegistry;
  /** @deprecated Use port.execute(). */
  scheduler?: AgentRuntimeDependenciesCompatibilityToolScheduler;
  auditRecorder?: PilotDeckToolAuditRecorder;
  elicitation?: PilotDeckElicitationChannel;
  userDialog?: PilotDeckUserDialogChannel;
  fileHistory?: PilotDeckToolFileHistorySink;
  fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
  planFileManager?: PlanFileManager;
  planTodoManager?: PlanTodoPort;
  goalManager?: GoalPort;
  permission?: PermissionDecisionPort;
  oneShotSubagentPort?: OneShotSubagentPort;
};

type AgentRuntimeDependenciesCompatibilityToolRegistry = {
  list(): readonly PilotDeckToolDefinition[];
};

type AgentRuntimeDependenciesCompatibilityToolScheduler = {
  executeAll(...args: never[]): Promise<unknown>;
};

const NOOP_CONTEXT = Symbol("pilotdeck.agent-turn-noop-context");

type InternalAgentTurnContextPort = AgentTurnContextPort & { readonly [NOOP_CONTEXT]?: true };

export type AgentTurnCapabilities = Readonly<{
  readonly [AGENT_TURN_CAPABILITIES]: true;
  readonly model: Readonly<AgentTurnModelCapabilities>;
  readonly toolExecution: Readonly<ToolExecutionPort>;
  readonly toolResultObserver?: ToolResultObserver;
  /** Policy port is composed around execution by the sidecar host. */
  readonly toolAuthorization?: ToolAuthorizationPort;
  readonly permission?: PermissionPort;
  readonly interaction: InteractionPort;
  readonly planMode: PlanModePort;
  readonly subagent: SubagentPort;
  readonly goal?: GoalPort;
  readonly contextPreparation: ContextPreparationPort;
  readonly contextRecovery?: ContextRecoveryPort;
  readonly contextToolResults?: ContextToolResultPort;
  readonly contextCapture?: ContextCapturePort;
  readonly contextCompaction?: ContextCompactionPort;
  readonly context: AgentTurnContextPort;
  /** @deprecated Use toolExecution, permission, interaction, planMode, subagent, and goal. */
  readonly tools: Readonly<AgentTurnToolCapabilities>;
  readonly transport: Readonly<{ operationLedger?: AgentLoopOperationLedger }>;
  readonly hooks: Readonly<{ lifecycle?: LifecycleDispatchPort }>;
  readonly events: Readonly<{ emit?: AgentEventEmitter; drain?: () => AgentEvent[] }>;
  readonly clock: Readonly<{ now?: () => Date; uuid?: () => string }>;
}>;

/** Build the sidecar consumer view without constructing or accepting a Router. */
export function createSidecarAgentTurnCapabilities(
  config: AgentRuntimeConfig,
  dependencies: SidecarAgentTurnCapabilityComposition,
): AgentTurnCapabilities {
  const context = dependencies.context ?? createNoopAgentTurnContextPort();
  const contextPreparation = Object.freeze({
    prepareForModel: (input: AgentContextPrepareInput) => context.prepareForModel(input),
  });
  const contextRecovery = context.recoverFromModelError
    ? Object.freeze({ recoverFromModelError: (input: AgentContextRecoveryInput) => context.recoverFromModelError!(input) })
    : undefined;
  const contextToolResults = context.applyToolResults
    ? Object.freeze({ applyToolResults: (input: AgentContextToolResultInput) => context.applyToolResults!(input) })
    : undefined;
  const contextCapture = context.captureTurn
    ? Object.freeze({ captureTurn: (input: AgentContextCaptureTurnInput) => context.captureTurn!(input) })
    : undefined;
  const contextCompaction = context.tryAutoCompact
    ? Object.freeze({ tryAutoCompact: (input: CompactionAutoCompactInput) => context.tryAutoCompact!(input) })
    : undefined;
  const toolExecution = createToolExecutionPort(dependencies.ports.toolExecution, {
    auditRecorder: dependencies.auditRecorder,
    fileHistory: dependencies.fileHistory,
    fileUpdateNotifier: dependencies.fileUpdateNotifier,
  });
  const metadata: ModelMetadataPort = dependencies.ports.metadata ?? Object.freeze({});
  const interaction = Object.freeze({
    elicitation: dependencies.elicitation,
    elicitationAvailable: dependencies.elicitationAvailable ?? dependencies.elicitation !== undefined,
    userDialog: dependencies.userDialog,
  });
  const planMode = Object.freeze({
    planFileManager: dependencies.planFileManager,
    planTodoManager: dependencies.planTodoManager,
  });
  const subagent = Object.freeze({ oneShot: dependencies.oneShotSubagentPort });
  const legacyTools = Object.freeze({
    port: toolExecution,
    auditRecorder: dependencies.auditRecorder,
    elicitation: dependencies.elicitation,
    userDialog: dependencies.userDialog,
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
      execution: dependencies.ports.model,
      routing: dependencies.ports.routing,
      metadata,
      budget: dependencies.ports.budget,
      auxiliary: dependencies.ports.auxiliary,
      legacyAuxiliaryFallback: false,
      invoker: dependencies.ports.model,
      tokenAccounting: dependencies.ports.budget,
      getModelMaxContextTokens: metadata.getModelMaxContextTokens,
      getModelMaxOutputTokens: metadata.getModelMaxOutputTokens,
      getModelTokenLimits: metadata.getModelTokenLimits,
      getModelProtocol: metadata.getModelProtocol,
      getModelSupportsPromptCache: metadata.getModelSupportsPromptCache,
    }),
    toolExecution,
    toolResultObserver: dependencies.toolResultObserver,
    toolAuthorization: dependencies.ports.toolAuthorization,
    permission: dependencies.permission,
    interaction,
    planMode,
    subagent,
    goal: dependencies.goalManager,
    contextPreparation,
    contextRecovery,
    contextToolResults,
    contextCapture,
    contextCompaction,
    context,
    tools: legacyTools,
    transport: Object.freeze({ operationLedger: dependencies.sidecarOperationLedger }),
    hooks: Object.freeze({ lifecycle: dependencies.lifecycle }),
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

export function createAgentTurnContextPort(runtime: {
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

export function createLifecycleDispatchPort(runtime: LifecycleRuntime): LifecycleDispatchPort {
  return Object.freeze({
    dispatch: (input) => runtime.dispatch.call(runtime, input),
  });
}

export function isAgentTurnCapabilities(value: unknown): value is AgentTurnCapabilities {
  return typeof value === "object"
    && value !== null
    && (value as Partial<AgentTurnCapabilities>)[AGENT_TURN_CAPABILITIES] === true;
}
