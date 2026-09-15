import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../model/index.js";
import type { LifecycleDispatchResult } from "../../../lifecycle/index.js";
import { isPilotDeckHookEvent } from "../../../extension/hooks/protocol/events.js";
import type { PilotDeckToolCall, PilotDeckToolDefinition } from "../../../tool/index.js";
import { HostToolCheckpoint } from "../checkpoint/hostToolCheckpoint.js";
import type { AgentLoopInput } from "../../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import { buildTurnEnvironment } from "../../turn/TurnEnvironment.js";
import type {
  ModelExecutionContext,
  ModuleCallRequest,
  PreparedModelInvocation,
} from "../protocol.js";
import type { AgentEvent } from "../../protocol/events.js";
import type {
  SidecarCapabilityResultObserver,
  SidecarModuleHandler,
  SidecarModuleHandlerRegistry,
} from "./agentLoopSidecarClient.js";
import type { SidecarModuleComposition } from "./sidecarHostModulePorts.js";

export type SidecarModuleManifest = Readonly<{
  tools: readonly Record<string, unknown>[];
  permissionContext: Record<string, unknown>;
  hostModules: Record<string, unknown>;
}>;

export function createSidecarDefaultModuleDispatcher(options: {
  config: AgentRuntimeConfig;
  modules: SidecarModuleComposition;
  input: AgentLoopInput;
  checkpoint: HostToolCheckpoint;
  capabilityResultObserver: SidecarCapabilityResultObserver;
  planTodoHandler: SidecarModuleHandler;
}): Readonly<{ handlers: SidecarModuleHandlerRegistry; manifest: SidecarModuleManifest }> {
  const capabilityContext = options.modules.capability.runtimeContext.bindTurn({
    config: options.config,
    input: options.input,
    checkpoint: options.checkpoint,
  });
  const permissionContext = options.modules.permission?.requestContext.bindTurn({
    config: options.config,
    input: options.input,
    checkpoint: options.checkpoint,
  });
  const contextIdentity = options.modules.context?.requestIdentity.bindTurn({
    config: options.config,
    input: options.input,
    checkpoint: options.checkpoint,
  });
  const preparations = new Map<string, PreparedModelInvocation>();
  const handlers: SidecarModuleHandlerRegistry = Object.freeze({
    model: async (call) => {
      const operation = stringField(call.payload, "operation");
      const preparationId = stringField(call.payload, "preparationId");
      const context = modelExecutionContext(call, options.input, options.input.abortSignal);
      if (operation === "prepare") {
        const prepared = await options.modules.model.execution.prepare({ request: canonicalModelRequest(call.payload.request), context });
        preparations.set(preparationId, prepared);
        return { prepared: serializablePreparedInvocation(prepared) };
      }
      if (operation === "stream") {
        const prepared = preparations.get(preparationId);
        if (!prepared) throw new Error(`Unknown sidecar model preparation: ${preparationId}`);
        const events: CanonicalModelEvent[] = [];
        for await (const event of options.modules.model.execution.stream({ prepared, context })) events.push(event);
        return { events };
      }
      throw new Error(`Unsupported sidecar model operation: ${operation}`);
    },
    capability: async (call) => {
      const operation = stringField(call.payload, "operation");
      if (operation === "plan_todo") return options.planTodoHandler(call);
      const planTodo = options.modules.planTodo?.forSession(options.input.sessionId);
      const context = capabilityContext.toolRuntimeContext(call.payload.context, planTodo, true);
      const execution = capabilityContext.executionContext(call);
      if (operation === "execute_batch") {
        const calls = Array.isArray(call.payload.calls)
          ? call.payload.calls.map(parseToolCall)
          : (() => { throw new Error("Capability batch call must contain calls."); })();
        const results = await options.modules.capability.execution.executeAll(calls, context, execution);
        if (results.length !== calls.length) throw new Error("Capability port returned an incomplete batch result.");
        await options.capabilityResultObserver.onCapabilityResults(results);
        return { results };
      }
      if (operation === "execute") {
        const tool = parseToolCall({ toolCallId: call.payload.toolCallId, name: call.payload.name, arguments: call.payload.arguments });
        const [result] = await options.modules.capability.execution.executeAll([tool], context, execution);
        if (!result) throw new Error("Capability port returned no result.");
        await options.capabilityResultObserver.onCapabilityResults([result]);
        return result as unknown as Record<string, unknown>;
      }
      throw new Error(`Unsupported sidecar capability operation: ${operation}`);
    },
    ...(options.modules.permission ? { permission: async (call: ModuleCallRequest) => {
      if (stringField(call.payload, "operation") !== "decide") throw new Error("Unsupported sidecar permission operation.");
      const permission = options.modules.permission!;
      const toolName = stringField(asRecord(call.payload.tool), "name");
      const tool = permission.catalog.list().find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`Permission request references unavailable tool: ${toolName}`);
      const decision = await permission.decision.decide(tool, call.payload.input, permissionContext!.toolRuntimeContext(call.payload.context), stringField(call.payload, "toolCallId"));
      return { decision };
    } } : {}),
    ...(options.modules.context ? { context: async (call: ModuleCallRequest) => dispatchContext(options, contextIdentity!.contextIdentity(asRecord(call.payload.input)), call) } : {}),
    ...(options.modules.lifecycle ? { lifecycle: async (call: ModuleCallRequest) => dispatchLifecycle(options, call) } : {}),
    ...(options.modules.event ? { event: async (call: ModuleCallRequest) => {
      if (stringField(call.payload, "operation") !== "emit") throw new Error("Unsupported sidecar event operation.");
      options.modules.event!.emit(readHostEmittedEvent(call.payload.event, options.input));
      return { result: null };
    } } : {}),
  });
  return Object.freeze({
    handlers,
    manifest: Object.freeze({
      tools: options.modules.capability.execution.list().map(serializeToolDescriptor),
      permissionContext: capabilityContext.permissionContext() as unknown as Record<string, unknown>,
      hostModules: hostModuleCapabilities(options.modules),
    }),
  });
}

async function dispatchContext(options: Parameters<typeof createSidecarDefaultModuleDispatcher>[0], input: Record<string, unknown>, call: ModuleCallRequest): Promise<Record<string, unknown>> {
  const operation = stringField(call.payload, "operation");
  if (operation === "try_auto_compact" && input.maxContextTokens === undefined && options.config.maxContextTokens !== undefined) input.maxContextTokens = options.config.maxContextTokens;
  const context = options.modules.context?.execution;
  if (operation === "prepare_for_model" && context) return { result: await context.prepareForModel(input as never) };
  if (operation === "apply_tool_results" && context?.applyToolResults) return { result: await context.applyToolResults(input as never) };
  if (operation === "recover_from_model_error" && context?.recoverFromModelError) return { result: await context.recoverFromModelError(input as never) };
  if (operation === "capture_turn" && context?.captureTurn) { await context.captureTurn(input as never); return { result: null }; }
  if (operation === "try_auto_compact" && context?.tryAutoCompact) return { result: await context.tryAutoCompact(input as never) };
  throw new Error(`Host context capability does not support ${operation}.`);
}

async function dispatchLifecycle(options: Parameters<typeof createSidecarDefaultModuleDispatcher>[0], call: ModuleCallRequest): Promise<Record<string, unknown>> {
  if (stringField(call.payload, "operation") !== "dispatch") throw new Error("Unsupported sidecar lifecycle operation.");
  const event = stringField(call.payload, "event");
  if (!isPilotDeckHookEvent(event)) throw new Error(`Unsupported sidecar lifecycle event: ${event}`);
  const payload = call.payload.payload === undefined ? undefined : asRecord(call.payload.payload) ?? (() => { throw new Error("Lifecycle payload must be an object."); })();
  const result = await options.modules.lifecycle!.dispatch({
    event,
    baseInput: { sessionId: options.input.sessionId, transcriptPath: "", cwd: options.config.cwd, permissionMode: options.config.permissionMode },
    ...(payload ? { payload } : {}),
    matchQuery: event,
    ...(options.input.abortSignal ? { signal: options.input.abortSignal } : {}),
    env: buildTurnEnvironment(options.config.env, options.config.cwd, options.input.sessionId, options.input.turnId),
  });
  return { result: serializeLifecycleDispatchResult(result) };
}

function hostModuleCapabilities(modules: SidecarModuleComposition): Record<string, unknown> {
  const context = modules.context?.execution;
  const contextMethods = context ? ["prepare_for_model", ...(context.applyToolResults ? ["apply_tool_results"] : []), ...(context.recoverFromModelError ? ["recover_from_model_error"] : []), ...(context.captureTurn ? ["capture_turn"] : []), ...(context.tryAutoCompact ? ["try_auto_compact"] : [])] : [];
  return {
    model: { methods: ["prepare", "stream"] },
    capability: { methods: ["execute", "execute_batch", ...(modules.planTodo ? ["plan_todo"] : [])] },
    ...(contextMethods.length > 0 ? { context: { methods: contextMethods } } : {}),
    ...(modules.permission ? { permission: { methods: ["decide"] } } : {}),
    ...(modules.lifecycle ? { lifecycle: { methods: ["dispatch"] } } : {}),
    ...(modules.event ? { event: { methods: ["emit"] } } : {}),
  };
}

function serializeToolDescriptor(tool: PilotDeckToolDefinition): Record<string, unknown> { return { name: tool.name, description: tool.description, kind: tool.kind, inputSchema: tool.inputSchema, readOnly: safely(() => tool.isReadOnly({}), false), concurrencySafe: safely(() => tool.isConcurrencySafe({}), false), requiresUserInteraction: safely(() => tool.requiresUserInteraction?.({}) ?? false, false), ...(tool.requiredRuntimeCapabilities ? { requiredRuntimeCapabilities: [...tool.requiredRuntimeCapabilities] } : {}) }; }
function modelExecutionContext(call: ModuleCallRequest, input: AgentLoopInput, abortSignal?: AbortSignal): ModelExecutionContext { const remote = asRecord(call.payload.context); return { sessionId: input.sessionId, turnId: input.turnId, runId: call.runId, operationId: call.operationId, ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}), ...(input.execution?.operationDeadline ? { operationDeadline: input.execution.operationDeadline } : {}), ...(abortSignal ? { abortSignal } : {}), ...(modelOverride(remote?.modelOverride) ? { modelOverride: modelOverride(remote?.modelOverride) } : {}), ...(asRecord(remote?.metadata) ? { metadata: asRecord(remote?.metadata) } : {}) }; }
function parseToolCall(value: unknown): PilotDeckToolCall { const record = asRecord(value); return { id: stringField(record, "toolCallId"), name: stringField(record, "name"), input: record?.arguments ?? {} }; }
function canonicalModelRequest(value: unknown): CanonicalModelRequest { const request = asRecord(value); if (!request || typeof request.provider !== "string" || typeof request.model !== "string" || !Array.isArray(request.messages)) throw new Error("Sidecar model call contains an invalid canonical request."); return request as unknown as CanonicalModelRequest; }
function serializablePreparedInvocation(prepared: PreparedModelInvocation): Record<string, unknown> { return { request: prepared.request, provider: prepared.provider, model: prepared.model, ...(prepared.maxContextTokens ? { maxContextTokens: prepared.maxContextTokens } : {}), ...(prepared.maxOutputTokens ? { maxOutputTokens: prepared.maxOutputTokens } : {}) }; }
function readHostEmittedEvent(value: unknown, input: AgentLoopInput): AgentEvent { const event = asRecord(value); if (!event || typeof event.type !== "string" || event.sessionId !== input.sessionId || ("turnId" in event && event.turnId !== input.turnId)) throw new Error("Sidecar host event does not match the active turn."); return event as unknown as AgentEvent; }
function serializeLifecycleDispatchResult(result: LifecycleDispatchResult): Record<string, unknown> { return { effects: result.effects, messages: result.messages, events: result.events, blockingErrors: result.blockingErrors, nonBlockingErrors: result.nonBlockingErrors, ...(result.pendingAsyncHooks ? { pendingAsyncHooks: result.pendingAsyncHooks } : {}) }; }
function modelOverride(value: unknown): { provider: string; model: string } | undefined { const record = asRecord(value); return record && typeof record.provider === "string" && typeof record.model === "string" ? { provider: record.provider, model: record.model } : undefined; }
function stringField(value: Record<string, unknown> | undefined, field: string): string { const candidate = value?.[field]; if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`Sidecar payload field ${field} must be a non-empty string.`); return candidate; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function safely(value: () => boolean, fallback: boolean): boolean { try { return value(); } catch { return fallback; } }
