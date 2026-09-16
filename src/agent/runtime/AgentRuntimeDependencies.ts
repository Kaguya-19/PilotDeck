import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import type {
  PilotDeckElicitationChannel,
  PilotDeckUserDialogChannel,
  PilotDeckToolAuditRecorder,
  PilotDeckFileUpdateNotifier,
  PilotDeckToolFileHistorySink,
  PilotDeckToolScheduler,
  ToolRegistry,
} from "../../tool/index.js";
import type { PlanFileManager } from "../../tool/builtin/planFile.js";
import type { PlanTodoPort } from "../../plan-todo/runtime/PlanTodoPort.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { TokenAccountingRuntime } from "../../context/index.js";
import type { PromptContributionRegistry } from "../../context/prompt/PromptContributionRegistry.js";
import type { RouterRuntime } from "../../router/index.js";
import type { AgentEvent, AgentEventEmitter } from "../protocol/events.js";
import type { ModelProtocol } from "../../model/index.js";
import type { PermissionDecisionPort } from "../../permission/index.js";
import type { ModelInvokerPort, ToolAuthorizationPort, ToolPort } from "../modules/protocol.js";
import type { AgentRuntimeScope } from "../scope/AgentRuntimeScope.js";
import type { SubagentProvider } from "../sub/SubagentProvider.js";
import type { SubagentProviderRegistry } from "../sub/SubagentProviderRegistry.js";
import type { OneShotSubagentPort } from "../sub/OneShotSubagentPort.js";
import type { InteractionDeadlinePolicy, InteractionPolicy, InteractionReconnectPort } from "../../interaction/index.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { SessionEventDraft } from "../../session/events/SessionEventStore.js";
import type { AgentLoopOperationLedger } from "../modules/transport/operationLedger.js";
import type { GoalPort } from "../../goal/protocol/types.js";

export type AgentRuntimePorts = {
  model?: ModelInvokerPort;
  tools?: ToolPort;
  /** Optional explicit authorization policy for host/sidecar tool composition. */
  authorization?: ToolAuthorizationPort;
  metadata?: import("../loop/AgentTurnCapabilities.js").ModelMetadataPort;
  budget?: import("../loop/AgentTurnCapabilities.js").ModelBudgetPort;
  /** Optional routing policy view used by AgentLoop after model execution is selected. */
  routing?: Pick<AgentRouterRuntime, "materializeRequest" | "invalidateSticky"> & {
    /** @deprecated Use auxiliaryModel for secondary model calls. */
    stream?: AgentRouterRuntime["stream"];
  };
  /** Optional secondary model client for tool and subagent calls. */
  auxiliaryModel?: import("../loop/AgentTurnCapabilities.js").AuxiliaryModelPort;
};

/** Native-only customization for one dynamic subagent definition. */
export type SubagentCompositionPort = {
  createContext?(definition: import("../sub/builtinSubagentTypes.js").SubagentDefinition): AgentContextRuntime | undefined;
  configureTools?(
    definition: import("../sub/builtinSubagentTypes.js").SubagentDefinition,
    registry: ToolRegistry,
  ): void;
};

/**
 * Narrow view of the router that the agent loop actually consumes. Tests can
 * inject anything that satisfies this contract; production wiring uses
 * `createRouterRuntime`.
 *
 * `decide` + `execute` are exposed so the agent loop can insert a post-routing
 * compaction pass between the routing decision and the model call.
 */
export type AgentRouterRuntime = Pick<RouterRuntime, "stream" | "decide" | "execute"> & {
  materializeRequest?: RouterRuntime["materializeRequest"];
  observeUsage?: RouterRuntime["observeUsage"];
  invalidateSticky?: RouterRuntime["invalidateSticky"];
  estimateUsageCost?: (usage: import("../../model/index.js").CanonicalUsage | undefined, provider: string, model: string) => number | undefined;
};

/**
 * Subagent sidechain transcript hooks (C3 §6.3). The agent loop calls these
 * around a forked subagent so:
 *   - `recordSubagentStarted` writes a `subagent_started` reference into the
 *     **parent** transcript (truncated directive preview).
 *   - `recordSubagentCompleted` writes a `subagent_completed` reference into
 *     the **parent** transcript (truncated summary + usage / duration).
 *   - `subagentTranscriptResolver(subagentId, sessionId)` returns a sidechain
 *     writer that captures the subagent's turn-by-turn entries in the
 *     application-selected child storage. Native JSONL retains the compatible
 *     `<subagentId>.jsonl` artifact layout.
 *
 * All hooks are optional — when missing, the agent loop falls back to the
 * legacy "no sidechain" behavior (subagent runs, but no persistence).
 */
export type AgentSubagentTranscriptHooks = {
  recordSubagentStarted?(args: {
    sessionId: string;
    turnId: string;
    subagentId: string;
    subagentType: string;
    prompt: string;
    transcriptRelativePath: string;
    subagentSessionId?: string;
  }): Promise<void>;
  recordSubagentCompleted?(args: {
    sessionId: string;
    turnId: string;
    subagentId: string;
    subagentType: string;
    summary: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens?: number;
    };
    turns: number;
    durationMs: number;
    errored?: boolean;
  }): Promise<void>;
  subagentTranscriptResolver?(subagentId: string, sessionId?: string): {
    recordSessionEvent?(
      sessionId: string,
      turnId: string,
      event: SessionEventDraft,
    ): void | Promise<void>;
    recordAcceptedInput(
      sessionId: string,
      turnId: string,
      messages: CanonicalMessage[],
      metadata?: Record<string, unknown>,
    ): void | Promise<void>;
    recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void | Promise<void>;
    recordTurnResult?(sessionId: string, turnId: string, result: AgentTurnResult): void | Promise<void>;
    transcriptRelativePath: string;
    /** Releases an independently composed child storage; calls are idempotent. */
    dispose?(): void | Promise<void>;
  };
};

export type AgentRuntimeDependencies = {
  router: AgentRouterRuntime;
  /** Current agent scope. Child agents inherit scoped services from this owner. */
  scope?: AgentRuntimeScope;
  /** Optional modular ports. Legacy router/tools are adapted when omitted. */
  ports?: AgentRuntimePorts;
  /** Optional permission provider used by host-composed ToolRuntime instances. */
  permission?: PermissionDecisionPort;
  /** Session/agent-scoped admission policy for approval and questions. */
  interactionPolicy?: InteractionPolicy;
  /** Session/agent-scoped deadline selection for approval and questions. */
  interactionDeadlinePolicy?: InteractionDeadlinePolicy;
  /** Session/agent-scoped pending interaction reconnect owner. */
  interactionReconnect?: InteractionReconnectPort;
  tools: {
    scheduler: PilotDeckToolScheduler;
    registry: ToolRegistry;
  };
  context?: AgentContextRuntime;
  /** Whether the current Agent scope owns and disposes the Context provider. */
  ownedContext?: boolean;
  /** Session-scoped prompt registry and its explicit lifecycle ownership. */
  promptContributions?: {
    registry: PromptContributionRegistry;
    owned?: boolean;
  };
  tokenAccounting?: TokenAccountingRuntime;
  /**
   * Look up a model's context-window size by provider/model id. Used after
   * routing to re-evaluate compaction against the target model's window when
   * it is smaller than the agent's default model. Returns `undefined` for
   * unknown models so the caller can skip re-compaction gracefully.
   */
  getModelMaxContextTokens?: (provider: string, model: string) => number | undefined;
  /**
   * Look up a model's maximum output-token cap by provider/model id. Used by
   * max-output recovery to avoid retrying with a lower synthetic default than
   * the selected model already receives from the catalog.
   */
  getModelMaxOutputTokens?: (provider: string, model: string) => number | undefined;
  getModelTokenLimits?: (provider: string, model: string) => { maxContextTokens: number; maxOutputTokens?: number } | undefined;
  /** Resolve the actual wire protocol; provider IDs may be compatible gateways. */
  getModelProtocol?: (provider: string) => ModelProtocol | undefined;
  /** Resolve prompt-cache support for the concrete provider/model. */
  getModelSupportsPromptCache?: (provider: string, model: string) => boolean | undefined;
  now?: () => Date;
  uuid?: () => string;
  auditRecorder?: PilotDeckToolAuditRecorder;
  lifecycle?: LifecycleRuntime;
  /** Whether this Agent scope owns lifecycle/hook teardown. */
  ownedLifecycle?: boolean;
  /** C3 sidechain transcript hooks (optional). */
  subagentTranscript?: AgentSubagentTranscriptHooks;
  /** Named delegation provider; native in-process provider is used when omitted. */
  subagentProvider?: SubagentProvider;
  subagentProviders?: SubagentProviderRegistry;
  /** Composition-bound one-shot delegation consumer for the `agent` tool. */
  oneShotSubagentPort?: OneShotSubagentPort;
  /** Native composition seam for SDK-defined child context and tool views. */
  subagentComposition?: SubagentCompositionPort;
  /** Native composition hook for detached SDK AgentDefinitions. Never crosses the sidecar protocol. */
  backgroundSubagents?: {
    launch(input: {
      sessionId: string;
      turnId: string;
      subagentId: string;
      subagentType: string;
      run(signal: AbortSignal): Promise<unknown>;
    }): { taskId: string } | Promise<{ taskId: string }>;
  };
  /** Native-only host boundary for detached read-only AgentDefinition observers. */
  observerSubagents?: {
    launch(input: {
      sessionId: string;
      turnId: string;
      observedSubagentId: string;
      observerSubagentId: string;
      observerSubagentType: string;
      run(signal: AbortSignal): Promise<unknown>;
    }): void | Promise<void>;
  };
  /** Whether the current session scope owns provider teardown. */
  ownedSubagentProvider?: boolean;
  /**
   * Elicitation channel — wired into the per-tool `PilotDeckToolRuntimeContext`
   * so `ask_user_question` (B1) can drive the gateway. When omitted, the
   * tool returns a `mcp_unavailable` error instead of crashing.
   */
  elicitation?: PilotDeckElicitationChannel;
  /** Whether the current session scope owns and disposes the elicitation channel. */
  ownedElicitation?: boolean;
  /** Optional Gateway-owned generic dialog channel for explicitly enabled SDK tools. */
  userDialog?: PilotDeckUserDialogChannel;
  /**
   * File-history sink — wired into the per-tool runtime context so
   * `edit_file` / `write_file` (C4) snapshot the file before mutation.
   * `FileHistoryStore` directly satisfies this contract.
   */
  fileHistory?: PilotDeckToolFileHistorySink;
  /**
   * Optional sink for propagating successful file writes to editor / LSP
   * integrations. When absent, write_file still succeeds and performs no
   * post-write host notifications.
   */
  fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
  /**
   * Plan file manager — resolves the current writable plan directory
   * directory and reads explicitly submitted plan documents for
   * `enter_plan_mode` / `exit_plan_mode`. Absent in headless / test runtimes.
   */
  planFileManager?: PlanFileManager;
  /** Session-scoped state tracking required `todo_write` calls after plan approval. */
  planTodoManager?: PlanTodoPort;
  /** Session-scoped durable goal provider. */
  goalManager?: GoalPort;
  /**
   * Host-owned durable status ledger for a sidecar execution. The AgentLoop
   * never reads it; an external transport factory may use it to reconcile a
   * result_unknown attempt without inventing an outcome.
   */
  sidecarOperationLedger?: AgentLoopOperationLedger;
  eventEmitter?: AgentEventEmitter;
  drainEvents?: () => AgentEvent[];
};

export type AgentLegacyModelRuntime = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};
