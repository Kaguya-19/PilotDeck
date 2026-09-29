import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelRequest } from "../../model/index.js";
import type { TokenAccountingRuntime } from "../../context/index.js";
import { createRouterModelInvokerPort, createToolSchedulerPort } from "../modules/adapters.js";
import {
  createSidecarAgentTurnCapabilities,
  createAgentTurnContextPort,
  createLifecycleDispatchPort,
  type AgentTurnCapabilities,
  type ToolResultObserver,
} from "./AgentTurnCapabilities.js";

/** Native compatibility input. New sidecar composition must not use this bag. */
export type AgentTurnCapabilityComposition = Omit<Partial<AgentRuntimeDependencies>, "tools"> & {
  tools?: Partial<AgentRuntimeDependencies["tools"]>;
  toolResultObserver?: ToolResultObserver;
};

/**
 * @deprecated Native adapter retained for one compatibility cycle. Sidecar
 * callers must compose explicit ports with createSidecarAgentTurnCapabilities.
 */
export function createAgentTurnCapabilities(
  config: AgentRuntimeConfig,
  dependencies: AgentTurnCapabilityComposition,
): AgentTurnCapabilities {
  const model = dependencies.ports?.model
    ?? (dependencies.router
      ? createRouterModelInvokerPort(dependencies.router, {
          isMainAgent: !config.isSubagent,
          projectPath: config.cwd,
        })
      : undefined);
  if (!model) throw new TypeError("AgentLoop composition requires a model execution port or router.");
  const registry = dependencies.tools?.registry;
  const scheduler = dependencies.tools?.scheduler;
  const rawTools = dependencies.ports?.tools
    ?? (registry && scheduler ? createToolSchedulerPort(registry, scheduler) : undefined);
  if (!rawTools) throw new TypeError("AgentLoop composition requires a tool execution port.");
  const budget = dependencies.ports?.budget ?? (
    dependencies.tokenAccounting || dependencies.router?.estimateUsageCost
      ? Object.freeze({
          ...(dependencies.tokenAccounting?.estimateRequestInput ? {
            estimateRequestInput: (request: CanonicalModelRequest) =>
              dependencies.tokenAccounting!.estimateRequestInput.call(dependencies.tokenAccounting, request),
          } : {}),
          ...(dependencies.tokenAccounting?.evaluateRequestBudget ? {
            evaluateRequestBudget: (request: CanonicalModelRequest, options: Parameters<TokenAccountingRuntime["evaluateRequestBudget"]>[1]) =>
              dependencies.tokenAccounting!.evaluateRequestBudget.call(dependencies.tokenAccounting, request, options),
          } : {}),
          ...(dependencies.router?.estimateUsageCost ? {
            estimateUsageCost: (usage: Parameters<NonNullable<typeof dependencies.router.estimateUsageCost>>[0], provider: string, model: string) =>
              dependencies.router!.estimateUsageCost!.call(dependencies.router, usage, provider, model),
          } : {}),
        })
      : undefined
  );
  const metadata = dependencies.ports?.metadata ?? Object.freeze({
    getModelMaxContextTokens: dependencies.getModelMaxContextTokens,
    getModelMaxOutputTokens: dependencies.getModelMaxOutputTokens,
    getModelTokenLimits: dependencies.getModelTokenLimits,
    getModelProtocol: dependencies.getModelProtocol,
    getModelSupportsPromptCache: dependencies.getModelSupportsPromptCache,
  });
  const router = dependencies.router;
  const auxiliary = dependencies.ports?.auxiliaryModel ?? (router
    ? Object.freeze({
        stream: () => { throw new Error("Native auxiliary model requires a turn binding."); },
        forTurn: (context: { sessionId: string; turnId: string; projectPath?: string }) => Object.freeze({
          stream: (request: CanonicalModelRequest, signal?: AbortSignal) => router.stream(request, {
            sessionId: context.sessionId,
            turnId: context.turnId,
            projectPath: context.projectPath ?? config.cwd,
            abortSignal: signal,
            isMainAgent: false,
          }),
        }),
      })
    : undefined);
  return createSidecarAgentTurnCapabilities(config, {
    ports: {
      model,
      toolExecution: rawTools,
      toolAuthorization: dependencies.ports?.authorization,
      metadata,
      budget,
      auxiliary,
      routing: dependencies.ports?.routing
        ? {
            invalidateSticky: dependencies.ports.routing.invalidateSticky,
            materializeRequest: (prepared, request) => dependencies.ports!.routing!.materializeRequest!(prepared.opaque as never, request),
          }
        : router
          ? {
              invalidateSticky: router.invalidateSticky?.bind(router),
              materializeRequest: (prepared, request) => router.materializeRequest
                ? router.materializeRequest(prepared.opaque as never, request)
                : { ...request, provider: prepared.provider, model: prepared.model },
            }
          : undefined,
    },
    ...(dependencies.context ? { context: createAgentTurnContextPort(dependencies.context) } : {}),
    ...(dependencies.lifecycle ? { lifecycle: createLifecycleDispatchPort(dependencies.lifecycle) } : {}),
    permission: dependencies.permission,
    eventEmitter: dependencies.eventEmitter,
    drainEvents: dependencies.drainEvents,
    now: dependencies.now,
    uuid: dependencies.uuid,
    sidecarOperationLedger: dependencies.sidecarOperationLedger,
    auditRecorder: dependencies.auditRecorder,
    elicitation: dependencies.elicitation,
    userDialog: dependencies.userDialog,
    fileHistory: dependencies.fileHistory,
    fileUpdateNotifier: dependencies.fileUpdateNotifier,
    planFileManager: dependencies.planFileManager,
    planTodoManager: dependencies.planTodoManager,
    goalManager: dependencies.goalManager,
    oneShotSubagentPort: dependencies.oneShotSubagentPort,
    toolResultObserver: dependencies.toolResultObserver,
  });
}
