import { createHostPlanTodoModuleHandler } from "../capability/hostPlanTodoModuleHandler.js";
import {
  HostPermissionModeState,
  createHostPermissionModeResultObserver,
} from "../permission/hostPermissionModeState.js";
import type { AgentLoopInput } from "../../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import type { SidecarModuleComposition } from "./sidecarHostModulePorts.js";
import type {
  SidecarCapabilityResultObserver,
  SidecarModuleHandler,
  SidecarModuleHandlerFactory,
  SidecarModuleHandlerRegistry,
} from "./agentLoopSidecarClient.js";

/** Per-turn domain callbacks supplied to the transport protocol. */
export type SidecarTurnComposition = Readonly<{
  forTurn(input: AgentLoopInput): Readonly<{
    capabilityResultObserver: SidecarCapabilityResultObserver;
    planTodoHandler: SidecarModuleHandler;
    moduleHandlers?: SidecarModuleHandlerRegistry;
  }>;
}>;

/** Factory owned by host composition, never by the transport runner. */
export type SidecarTurnCompositionFactory = (input: {
  config: AgentRuntimeConfig;
  modules: SidecarModuleComposition;
  moduleHandlers?: SidecarModuleHandlerFactory;
  capabilityResultObserver?: SidecarCapabilityResultObserver;
}) => SidecarTurnComposition;

/**
 * Legacy host composition. It keeps permission-mode state and Plan/Todo
 * ownership outside the protocol transport while preserving current defaults.
 */
export function createDefaultSidecarTurnComposition(
  input: Parameters<SidecarTurnCompositionFactory>[0],
): SidecarTurnComposition {
  const permissionMode = new HostPermissionModeState(input.config);
  return {
    forTurn: (turn) => {
      permissionMode.applyTurnInput(turn);
      return {
        capabilityResultObserver: input.capabilityResultObserver
          ?? createHostPermissionModeResultObserver(permissionMode),
        planTodoHandler: createHostPlanTodoModuleHandler({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          resolve: () => input.modules.planTodo?.forSession(turn.sessionId),
        }),
      };
    },
  };
}

/** Compose explicit handlers without giving the transport a domain aggregate. */
export function createSidecarModuleHandlerRegistry(
  handlers: SidecarModuleHandlerRegistry,
): SidecarModuleHandlerRegistry {
  return Object.freeze({ ...handlers });
}

/** Resolve externally supplied handlers for one active host turn. */
export function resolveSidecarTurnCompositionHandlers(
  input: { config: AgentRuntimeConfig; modules: SidecarModuleComposition; turn: AgentLoopInput },
  factory?: SidecarModuleHandlerFactory,
): SidecarModuleHandlerRegistry | undefined {
  if (!factory) return undefined;
  const identity = Object.freeze({
    sessionId: input.turn.sessionId,
    turnId: input.turn.turnId,
    runId: input.turn.execution?.runId ?? `run-${input.turn.turnId}`,
    operationId: input.turn.execution?.operationId ?? input.turn.turnId,
    ...(input.turn.execution?.operationDeadline ? { operationDeadline: input.turn.execution.operationDeadline } : {}),
    ...(input.turn.abortSignal ? { abortSignal: input.turn.abortSignal } : {}),
  });
  return createSidecarModuleHandlerRegistry({
    ...(factory.model ? { model: factory.model({ port: input.modules.model, turn: Object.freeze({ ...identity, projectPath: input.config.cwd }) }) } : {}),
    ...(factory.budget && input.modules.budget
      ? { budget: factory.budget({ port: input.modules.budget, turn: identity }) }
      : {}),
    ...(factory.turn ? { turn: factory.turn({ turn: identity }) } : {}),
    ...(factory.capability ? { capability: factory.capability({ port: input.modules.capability, turn: identity }) } : {}),
    ...(factory.permission && input.modules.permission
      ? { permission: factory.permission({ port: input.modules.permission, turn: Object.freeze({ sessionId: identity.sessionId, turnId: identity.turnId, ...(identity.abortSignal ? { abortSignal: identity.abortSignal } : {}) }) }) }
      : {}),
    ...(factory.context && input.modules.context
      ? { context: factory.context({ port: input.modules.context, turn: Object.freeze({ sessionId: identity.sessionId, turnId: identity.turnId, cwd: input.config.cwd, permissionMode: input.config.permissionMode, runMode: input.config.runMode ?? "agent", ...(input.config.maxContextTokens === undefined ? {} : { maxContextTokens: input.config.maxContextTokens }), ...(identity.abortSignal ? { abortSignal: identity.abortSignal } : {}) }) }) }
      : {}),
    ...(factory.lifecycle && input.modules.lifecycle
      ? { lifecycle: factory.lifecycle({ port: input.modules.lifecycle, turn: Object.freeze({ sessionId: identity.sessionId, turnId: identity.turnId, cwd: input.config.cwd, permissionMode: input.config.permissionMode, environment: input.config.env, ...(identity.abortSignal ? { abortSignal: identity.abortSignal } : {}) }) }) }
      : {}),
    ...(factory.event && input.modules.event
      ? { event: factory.event({ port: input.modules.event, turn: Object.freeze({ sessionId: identity.sessionId, turnId: identity.turnId }) }) }
      : {}),
  });
}
