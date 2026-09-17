import type { PermissionContext } from "../../../permission/index.js";
import type { PilotDeckPlanTodoStateHandle, } from "../../../tool/protocol/types.js";
import type { PilotDeckToolRuntimeContext } from "../../../tool/index.js";
import type { AgentLoopInput } from "../../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import { buildTurnEnvironment } from "../../turn/TurnEnvironment.js";
import type { AgentExecutionContext, ModuleCallRequest } from "../protocol.js";
import type { HostToolCheckpoint } from "../checkpoint/hostToolCheckpoint.js";
import type { GoalPort } from "../../../goal/protocol/types.js";
import type {
  PermissionRequestContextServicesPort,
  ContextRequestIdentityServicesPort,
  SidecarToolContextPorts,
  SidecarToolRuntimeServicesPort,
} from "./sidecarHostModulePorts.js";

export type { SidecarToolContextPorts } from "./sidecarHostModulePorts.js";

/** Keep raw auxiliary/goal/subagent services private until a turn is bound. */
export function createSidecarToolRuntimeServices(
  ports: SidecarToolContextPorts,
): SidecarToolRuntimeServicesPort {
  return Object.freeze({
    bindTurn: (binding) => createSidecarToolContextBuilder({ ...binding, ports }),
  });
}

/** Permission receives a restricted context builder, never capability execution. */
export function createSidecarPermissionRequestContextServices(
  ports: SidecarToolContextPorts,
): PermissionRequestContextServicesPort {
  return Object.freeze({
    bindTurn: (binding) => {
      const context = createSidecarToolContextBuilder({ ...binding, ports, includeAuxiliaryModel: false });
      return Object.freeze({
        toolRuntimeContext: (value: unknown) => context.toolRuntimeContext(value),
      });
    },
  });
}

/** Context callbacks only need host-owned identity canonicalization. */
export function createSidecarContextRequestIdentityServices(
  ports: SidecarToolContextPorts,
): ContextRequestIdentityServicesPort {
  return Object.freeze({
    bindTurn: (binding) => {
      const context = createSidecarToolContextBuilder({ ...binding, ports, includeAuxiliaryModel: false });
      return Object.freeze({ contextIdentity: context.contextIdentity });
    },
  });
}

/** Builds host-owned tool callback context from narrow sidecar ports. */
export function createSidecarToolContextBuilder(options: {
  config: AgentRuntimeConfig;
  input: AgentLoopInput;
  ports: SidecarToolContextPorts;
  checkpoint: HostToolCheckpoint;
  includeAuxiliaryModel?: boolean;
}) {
  const permissionContext = (): PermissionContext => effectivePermissionContext(options.config, options.input);
  const auxiliaryModel = options.includeAuxiliaryModel === false
    ? undefined
    : options.ports.model?.forTurn?.({
        sessionId: options.input.sessionId,
        turnId: options.input.turnId,
        projectPath: options.config.cwd,
      }) ?? options.ports.model;

  return {
    permissionContext,
    toolRuntimeContext(
      value: unknown,
      planTodo?: PilotDeckPlanTodoStateHandle,
      includeOneShotSubagent = false,
    ): PilotDeckToolRuntimeContext {
      const remote = asRecord(value);
      const { config, input, ports, checkpoint } = options;
      const planDirectoryPath = ports.planMode?.planFileManager?.getPlanDirectoryPath();
      const fileState = checkpoint.toolContextState();
      return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        messageId: input.turnId,
        cwd: config.cwd,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        ...(config.subagentTimeoutMs ? { subagentTimeoutMs: config.subagentTimeoutMs } : {}),
        ...(typeof remote?.currentToolCallId === "string" ? { currentToolCallId: remote.currentToolCallId } : {}),
        ...(remote?.outputTruncated === undefined
          ? {}
          : typeof remote.outputTruncated === "boolean"
            ? { outputTruncated: remote.outputTruncated }
            : (() => { throw new Error("Sidecar tool context outputTruncated must be a boolean."); })()),
        ...(config.toolAliases ? { toolAliases: config.toolAliases } : {}),
        permissionMode: config.permissionMode,
        permissionContext: {
          ...permissionContext(),
          ...(planDirectoryPath ? { planDirectoryPath } : {}),
        },
        runMode: config.runMode ?? "agent",
        // This is host-owned availability, not a channel serialized over the
        // wire. ToolRuntime needs it to distinguish dedicated elicitation from
        // ordinary prompt-based interaction.
        canElicit: input.canElicit === true && ports.interaction?.elicitation !== undefined,
        ...(ports.toolExecution?.auditRecorder ? { auditRecorder: ports.toolExecution.auditRecorder } : {}),
        ...(ports.clock?.now ? { now: ports.clock.now } : {}),
        ...(config.includeToolProgress === true && ports.eventEmitter
          ? {
              progress: (event) => {
                ports.eventEmitter?.({
                  type: "tool_progress",
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  message: event.message,
                  ...(event.metadata ? { metadata: event.metadata } : {}),
                  createdAt: event.createdAt,
                });
              },
            }
          : {}),
        env: buildTurnEnvironment(config.env, config.cwd, input.sessionId, input.turnId),
        ...(config.maxResultBytes ? { maxResultBytes: config.maxResultBytes } : {}),
        ...(auxiliaryModel ? { model: auxiliaryModel } : {}),
        ...(ports.interaction?.elicitation ? { elicitation: ports.interaction.elicitation } : {}),
        ...(ports.interaction?.userDialog ? { userDialog: ports.interaction.userDialog } : {}),
        ...(ports.toolExecution?.fileHistory ? { fileHistory: ports.toolExecution.fileHistory } : {}),
        ...(config.subagentDepth !== undefined ? { subagentDepth: config.subagentDepth } : {}),
        ...(includeOneShotSubagent && ports.subagent?.oneShot
          ? {
              subagent: ports.subagent.oneShot.createForkApi({
                sessionId: input.sessionId,
                turnId: input.turnId,
                parentReadFileState: fileState.readFileState,
                parentWriteSnapshots: fileState.writeSnapshots,
              }),
            }
          : {}),
        ...(config.modelMultimodal ? { modelMultimodal: config.modelMultimodal } : {}),
        ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
        readFileState: fileState.readFileState,
        allowedReadFiles: fileState.allowedReadFiles,
        writeSnapshots: fileState.writeSnapshots,
        ...(ports.toolExecution?.fileUpdateNotifier ? { fileUpdateNotifier: ports.toolExecution.fileUpdateNotifier } : {}),
        ...(planTodo ? { planTodo } : {}),
        ...(ports.goal ? { goal: ports.goal.forSession(input.sessionId) } : {}),
        ...(planDirectoryPath
          ? {
              planDirectory: {
                path: planDirectoryPath,
                resolve: (filePath: string) => ports.planMode?.planFileManager?.resolvePlanFilePath(filePath, config.cwd),
                read: (filePath: string) => ports.planMode?.planFileManager?.readPlanFile(filePath, config.cwd),
              },
            }
          : {}),
      };
    },
    executionContext(call: ModuleCallRequest): AgentExecutionContext {
      const { input } = options;
      return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: call.runId,
        operationId: call.operationId,
        ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
        ...(input.execution?.operationDeadline ? { operationDeadline: input.execution.operationDeadline } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      };
    },
    contextIdentity(source: Record<string, unknown> | undefined): Record<string, unknown> {
      const { config, input } = options;
      return {
        ...(source ?? {}),
        sessionId: input.sessionId,
        turnId: input.turnId,
        cwd: config.cwd,
        permissionMode: config.permissionMode,
        runMode: config.runMode ?? "agent",
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      };
    },
  };
}

function effectivePermissionContext(config: AgentRuntimeConfig, input: AgentLoopInput): PermissionContext {
  return {
    ...config.permissionContext,
    cwd: config.cwd,
    mode: config.permissionMode,
    canPrompt: input.canPrompt ?? config.permissionContext.canPrompt,
    rules: config.permissionContext.rules,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
