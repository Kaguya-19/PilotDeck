import {
  createSidecarPorts,
  type SidecarExecution,
  type SidecarExecutionFactory,
} from "../agent/modules/sidecar.js";
import {
  createHostPlanTodoPort,
  createPlanTodoResultObserver,
} from "../agent/modules/capability/index.js";
import { parseAgentLoopSeedStateProjection } from "../agent/modules/checkpoint/index.js";
import { createHostContextRuntime } from "../agent/modules/context/index.js";
import { createHostLifecycleRuntime } from "../agent/modules/lifecycle/index.js";
import { createHostAgentEventBridge } from "../agent/modules/events/index.js";
import { createHostPermissionDecisionPort } from "../agent/modules/permission/index.js";
import { resolveRuntimeContextSurface } from "../context/index.js";
import type {
  HostModuleCapabilities,
} from "../agent/modules/protocol.js";
import {
  readHostCapabilityModuleMethods,
  readHostContextModuleMethods,
  readHostEventModuleMethods,
  readHostLifecycleModuleMethods,
  readHostModelModuleMethods,
  readHostPermissionModuleMethods,
} from "../agent/modules/protocol.js";
import { AgentLoop } from "../agent/loop/AgentLoop.js";
import { createSidecarAgentTurnCapabilities } from "../agent/loop/AgentTurnCapabilities.js";
import type { AgentRuntimeConfig } from "../agent/runtime/AgentRuntimeConfig.js";
import { parseAgentRunMode } from "../agent/protocol/input.js";
import {
  DEFAULT_PERMISSION_MODE,
  createDefaultPermissionContext,
  isPermissionMode,
} from "../permission/index.js";
import type { PermissionRuleSet } from "../permission/index.js";
import type { CanonicalContentBlock, CanonicalMessage, CanonicalMessageMetadata } from "../model/index.js";
import type { TimelinePosition } from "../model/protocol/timeline.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolInputSchema,
  PilotDeckToolRuntimeCapability,
} from "../tool/index.js";

/** Host-neutral payload accepted by the default sidecar factory. */
export type SidecarAgentLoopPayload = {
  agent?: Record<string, unknown>;
  task?: Record<string, unknown>;
  messages?: unknown;
  tools?: unknown;
  hostModules?: HostModuleCapabilities;
  /** Host-owned context projection for a single execution. */
  contextOverride?: {
    systemPrompt?: unknown;
    messages?: unknown;
    metadata?: unknown;
    tools?: unknown;
  };
  permissionContext?: unknown;
  seedState?: unknown;
  executionContext?: unknown;
};

/**
 * Default sidecar factory. It maps a generic execute payload to AgentLoop
 * inputs; hosts with different state or module requirements can replace it
 * through `PILOTDECK_AGENT_LOOP_FACTORY`.
 */
export const createSidecarExecution: SidecarExecutionFactory = async ({ request, abortSignal, abortExecution, callModule }) => {
  const payload = asRecord(request.payload) ?? {};
  const agent = asRecord(payload.agent) ?? {};
  const task = asRecord(payload.task) ?? {};
  const contextOverride = asRecord(payload.contextOverride) ?? {};
  const executionContext = asRecord(payload.executionContext);
  const hostModules = asRecord(payload.hostModules);
  const modelMethods = readHostModelModuleMethods(asRecord(hostModules?.model)?.methods);
  const contextMethods = readHostContextModuleMethods(asRecord(hostModules?.context)?.methods);
  const lifecycleMethods = readHostLifecycleModuleMethods(asRecord(hostModules?.lifecycle)?.methods);
  const eventMethods = readHostEventModuleMethods(asRecord(hostModules?.event)?.methods);
  const capabilityMethods = readHostCapabilityModuleMethods(asRecord(hostModules?.capability)?.methods);
  const permissionMethods = readHostPermissionModuleMethods(asRecord(hostModules?.permission)?.methods);
  const hasOverrideMessages = Object.prototype.hasOwnProperty.call(contextOverride, "messages");
  const sessionId = String(request.sessionId ?? request.operationId);
  const turnId = String(request.turnId ?? request.operationId);
  const cwd = String(agent.cwd ?? payload.cwd ?? process.cwd());
  const permissionContextInput = asRecord(payload.permissionContext) ?? {};
  const permissionMode = isPermissionMode(permissionContextInput.mode)
    ? permissionContextInput.mode
    : isPermissionMode(agent.permissionMode)
      ? agent.permissionMode
      : DEFAULT_PERMISSION_MODE;
  const canPrompt = permissionContextInput.canPrompt === true;
  const bypassAvailable = permissionContextInput.bypassAvailable === true;
  const runMode = parseAgentRunMode(agent.runMode ?? payload.runMode);
  const subagentModel = asSubagentModel(agent.subagentModel ?? payload.subagentModel);
  const config: AgentRuntimeConfig = {
    provider: String(agent.provider ?? payload.provider ?? "default"),
    model: String(agent.model ?? payload.model ?? "default"),
    cwd,
    systemPrompt: asString(
      contextOverride.systemPrompt ?? agent.systemPrompt ?? payload.systemPrompt,
    ),
    runtimeContextSurface: resolveRuntimeContextSurface(agent.runtimeContextSurface),
    maxOutputTokens: asPositiveInteger(agent.maxOutputTokens ?? payload.maxOutputTokens),
    maxContextTokens: asPositiveInteger(agent.maxContextTokens ?? payload.maxContextTokens),
    runMode,
    isSubagent: readOptionalBoolean(agent.isSubagent ?? payload.isSubagent),
    ...(subagentModel ? { subagentModel } : {}),
    permissionMode,
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: permissionMode,
      canPrompt,
      bypassAvailable,
      rules: asPermissionRules(permissionContextInput.rules),
    }),
    metadata: mergeMetadata(executionContext, asRecord(contextOverride.metadata)),
  };
  const tools = readToolDescriptors(
    contextOverride.tools !== undefined ? contextOverride.tools : payload.tools,
  ).map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    kind: descriptor.kind,
    requiredRuntimeCapabilities: descriptor.requiredRuntimeCapabilities,
    inputSchema: descriptor.inputSchema,
    isReadOnly: () => descriptor.readOnly,
    isConcurrencySafe: () => descriptor.concurrencySafe,
    requiresUserInteraction: () => descriptor.requiresUserInteraction,
    execute: async () => ({ content: [{ type: "text", text: "Capability is executed by the host module." }] }),
  } satisfies PilotDeckToolDefinition));
  const moduleBinding = sidecarModuleBinding(request);
  const context = createSidecarContextComposition(callModule, moduleBinding, contextMethods);
  const permissionPort = createSidecarPermissionComposition(callModule, moduleBinding, permissionMethods);
  const lifecycle = createSidecarLifecycleComposition(callModule, moduleBinding, lifecycleMethods);
  const eventBridge = createSidecarEventComposition(callModule, moduleBinding, eventMethods);
  const planTodo = createSidecarPlanTodoComposition(callModule, moduleBinding, capabilityMethods);
  if (planTodo) await planTodo.initialize(sessionId, turnId);
  const sidecarPorts = createSidecarCapabilityComposition(callModule, {
    tools,
    permission: permissionPort,
    binding: moduleBinding,
    modelMethods,
    capabilityMethods,
    onAbort: abortExecution,
  });
  const dependencies = {
    ports: {
      model: sidecarPorts.model,
      toolExecution: sidecarPorts.toolExecution,
      ...(sidecarPorts.toolAuthorization ? { toolAuthorization: sidecarPorts.toolAuthorization } : {}),
    },
    ...(context ? { context } : {}),
    ...(permissionPort ? { permission: permissionPort } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(eventBridge ? { eventEmitter: eventBridge.emitter } : {}),
    ...(planTodo ? { planTodoManager: planTodo } : {}),
    ...(planTodo ? { toolResultObserver: createPlanTodoResultObserver({ planTodo, sessionId, turnId }) } : {}),
  };
  const loop = new AgentLoop(
    config,
    createSidecarAgentTurnCapabilities(config, dependencies),
    parseAgentLoopSeedStateProjection(payload.seedState),
  );
  return {
    loop,
    input: {
      sessionId,
      turnId,
      messages: buildInitialMessages(
        task,
        hasOverrideMessages ? contextOverride.messages : payload.messages,
        hasOverrideMessages,
      ),
      maxTurns: asPositiveInteger(agent.maxTurns ?? payload.maxTurns),
      runMode,
      abortSignal,
      permissionMode,
      basePermissionMode: isPermissionMode(payload.basePermissionMode)
        ? payload.basePermissionMode
        : undefined,
      allowPlanModeTools: payload.allowPlanModeTools === true,
      canPrompt,
      permissionRules: asPermissionRules(permissionContextInput.rules),
      modelOverride: asModelOverride(agent.modelOverride ?? payload.modelOverride),
      execution: {
        runId: request.runId,
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        operationDeadline: request.operationDeadline,
      },
    },
    ...(eventBridge ? { flush: eventBridge.flush } : {}),
  } as SidecarExecution;
};

type SidecarModuleBindingInput = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

function sidecarModuleBinding(request: {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
}): SidecarModuleBindingInput {
  return {
    runId: request.runId,
    operationId: request.operationId,
    ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
  };
}

/** Each helper owns one host-module adapter; the default factory only assembles them. */
function createSidecarContextComposition(
  callModule: Parameters<typeof createHostContextRuntime>[0],
  binding: SidecarModuleBindingInput,
  methods: ReturnType<typeof readHostContextModuleMethods>,
) {
  return methods.includes("prepare_for_model")
    ? createHostContextRuntime(callModule, binding, methods)
    : undefined;
}

function createSidecarPermissionComposition(
  callModule: Parameters<typeof createHostPermissionDecisionPort>[0],
  binding: SidecarModuleBindingInput,
  methods: ReturnType<typeof readHostPermissionModuleMethods>,
) {
  return methods.includes("decide")
    ? createHostPermissionDecisionPort(callModule, binding)
    : undefined;
}

function createSidecarLifecycleComposition(
  callModule: Parameters<typeof createHostLifecycleRuntime>[0],
  binding: SidecarModuleBindingInput,
  methods: ReturnType<typeof readHostLifecycleModuleMethods>,
) {
  return methods.includes("dispatch")
    ? createHostLifecycleRuntime(callModule, binding)
    : undefined;
}

function createSidecarEventComposition(
  callModule: Parameters<typeof createHostAgentEventBridge>[0],
  binding: SidecarModuleBindingInput,
  methods: ReturnType<typeof readHostEventModuleMethods>,
) {
  return methods.includes("emit")
    ? createHostAgentEventBridge(callModule, binding)
    : undefined;
}

function createSidecarPlanTodoComposition(
  callModule: Parameters<typeof createHostPlanTodoPort>[0],
  binding: SidecarModuleBindingInput,
  methods: ReturnType<typeof readHostCapabilityModuleMethods>,
) {
  return methods.includes("plan_todo")
    ? createHostPlanTodoPort(callModule, binding)
    : undefined;
}

function createSidecarCapabilityComposition(
  callModule: Parameters<typeof createSidecarPorts>[0],
  options: Parameters<typeof createSidecarPorts>[1],
) {
  return createSidecarPorts(callModule, options);
}

type ToolDescriptor = {
  name: string;
  description: string;
  kind: PilotDeckToolDefinition["kind"];
  inputSchema: PilotDeckToolInputSchema;
  readOnly: boolean;
  concurrencySafe: boolean;
  requiresUserInteraction: boolean;
  requiredRuntimeCapabilities: PilotDeckToolRuntimeCapability[];
};

function buildInitialMessages(
  task: Record<string, unknown>,
  rawMessages: unknown,
  explicitOverride = false,
): CanonicalMessage[] {
  const messages = Array.isArray(rawMessages) ? rawMessages.flatMap(toCanonicalMessages) : [];
  if (explicitOverride) return messages;
  const taskPrompt = asString(task.prompt ?? task.instruction ?? task.description);
  if (messages.length > 0) return messages;
  if (taskPrompt) return [{ role: "user", content: [{ type: "text", text: taskPrompt }] }];
  return [{ role: "user", content: [{ type: "text", text: JSON.stringify(task) }] }];
}

function toCanonicalMessages(rawMessage: unknown): CanonicalMessage[] {
  const message = asRecord(rawMessage);
  if (!message) return [];
  const role = message.role === "assistant" ? "assistant" : "user";
  const content: CanonicalContentBlock[] = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  if (Array.isArray(message.content)) content.push(...message.content.flatMap(toCanonicalContentBlocks));
  if (Array.isArray(message.images)) content.push(...message.images.flatMap(toCanonicalContentBlocks));
  const metadata = canonicalMessageMetadata(message.metadata);
  return content.length > 0 ? [{ role, content, ...(metadata ? { metadata } : {}) }] : [];
}

/**
 * Message metadata affects model-visible lifecycle behavior (for example,
 * synthetic runtime context and transient prompt expiry). Keep the canonical
 * subset across the sidecar boundary without accepting host-private fields.
 */
function canonicalMessageMetadata(value: unknown): CanonicalMessageMetadata | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const metadata: CanonicalMessageMetadata = {};
  if (typeof source.model === "string") metadata.model = source.model;
  if (typeof source.synthetic === "boolean") metadata.synthetic = source.synthetic;
  if (typeof source.transient === "boolean") metadata.transient = source.transient;
  if (typeof source.transientId === "string") metadata.transientId = source.transientId;
  if (typeof source.toolCallId === "string") metadata.toolCallId = source.toolCallId;
  if (typeof source.compactReplacement === "boolean") metadata.compactReplacement = source.compactReplacement;
  if (typeof source.compactSnapshotId === "string") metadata.compactSnapshotId = source.compactSnapshotId;
  if (typeof source.purpose === "string") metadata.purpose = source.purpose;
  if (typeof source.queueItemId === "string") metadata.queueItemId = source.queueItemId;
  const forkCarryover = asRecord(source.forkCarryover);
  if (typeof forkCarryover?.sourceSessionId === "string") {
    metadata.forkCarryover = {
      sourceSessionId: forkCarryover.sourceSessionId,
      ...(typeof forkCarryover.sourceTurnId === "string" ? { sourceTurnId: forkCarryover.sourceTurnId } : {}),
    };
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function toCanonicalContentBlocks(value: unknown): CanonicalContentBlock[] {
  const block = asRecord(value);
  if (!block) return [];
  const timeline = canonicalTimelinePosition(block.timeline);
  if (block.type === "text" && typeof block.text === "string") {
    return [{
      type: "text",
      text: block.text,
      ...(typeof block.blockId === "string" ? { blockId: block.blockId } : {}),
      ...(timeline ? { timeline } : {}),
    }];
  }
  if (block.type === "thinking" && typeof block.text === "string") {
    return [{
      type: "thinking",
      text: block.text,
      ...(typeof block.blockId === "string" ? { blockId: block.blockId } : {}),
      ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
      ...(typeof block.reasoningContent === "string" ? { reasoningContent: block.reasoningContent } : {}),
      ...(timeline ? { timeline } : {}),
    }];
  }
  if (block.type === "tool_call" && typeof block.id === "string" && typeof block.name === "string") {
    return [{
      type: "tool_call",
      id: block.id,
      name: block.name,
      input: block.input ?? {},
      ...(block.raw !== undefined ? { raw: block.raw } : {}),
      ...(timeline ? { timeline } : {}),
    }];
  }
  if (block.type === "tool_result" && typeof block.toolCallId === "string") {
    const content: CanonicalContentBlock[] = Array.isArray(block.content)
      ? block.content.flatMap(toCanonicalContentBlocks)
      : typeof block.content === "string"
        ? [{ type: "text", text: block.content }]
        : [];
    return [{
      type: "tool_result",
      toolCallId: block.toolCallId,
      content: content as any,
      ...(block.isError === true ? { isError: true } : {}),
      ...(block.raw !== undefined ? { raw: block.raw } : {}),
      ...(timeline ? { timeline } : {}),
    }];
  }
  if (block.type === "image" && block.source === "base64" && typeof block.data === "string" && typeof block.mimeType === "string") {
    return [{
      type: "image",
      source: "base64",
      mimeType: block.mimeType,
      data: block.data,
      ...(block.detail === "auto" || block.detail === "low" || block.detail === "high"
        ? { detail: block.detail }
        : {}),
    }];
  }
  if (block.type === "image_url") {
    const url = asRecord(block.image_url)?.url;
    if (typeof url === "string") {
      const match = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (match) return [{ type: "image", source: "base64", mimeType: match[1]!, data: match[2]! }];
    }
  }
  return [];
}

function canonicalTimelinePosition(value: unknown): TimelinePosition | undefined {
  const source = asRecord(value);
  if (
    source?.version !== 1
    || typeof source.turnId !== "string"
    || typeof source.id !== "string"
    || !Number.isInteger(source.order)
    || !Number.isInteger(source.revision)
  ) {
    return undefined;
  }
  return {
    version: 1,
    turnId: source.turnId,
    id: source.id,
    ...(typeof source.previousId === "string" ? { previousId: source.previousId } : {}),
    order: source.order as number,
    revision: source.revision as number,
    ...(Number.isInteger(source.offset) ? { offset: source.offset as number } : {}),
  };
}

function mergeMetadata(
  executionContext: Record<string, unknown> | undefined,
  overrideMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!executionContext && !overrideMetadata) return undefined;
  return { ...(executionContext ?? {}), ...(overrideMetadata ?? {}) };
}

function readToolDescriptors(value: unknown): ToolDescriptor[] {
  const record = asRecord(value);
  const items = Array.isArray(value) ? value : Array.isArray(record?.available) ? record.available : [];
  return items.flatMap((item) => {
    const descriptor = asRecord(item);
    const name = asString(descriptor?.name);
    if (!descriptor || !name) return [];
    const kind = isToolKind(descriptor.kind) ? descriptor.kind : "custom";
    const requiresUserInteraction = descriptor.requiresUserInteraction === true;
    const requiredRuntimeCapabilities = new Set(
      readToolRuntimeCapabilities(descriptor.requiredRuntimeCapabilities),
    );
    if (kind === "agent") requiredRuntimeCapabilities.add("subagent_fork");
    if (requiresUserInteraction) requiredRuntimeCapabilities.add("user_interaction");
    return [{
      name,
      description: asString(descriptor.description) ?? "Host capability",
      kind,
      inputSchema: asInputSchema(descriptor.inputSchema ?? descriptor.input_schema),
      readOnly: descriptor.readOnly === true,
      concurrencySafe: descriptor.concurrencySafe === true,
      requiresUserInteraction,
      requiredRuntimeCapabilities: [...requiredRuntimeCapabilities],
    }];
  });
}

function readToolRuntimeCapabilities(value: unknown): PilotDeckToolRuntimeCapability[] {
  if (!Array.isArray(value)) return [];
  return value.filter((capability): capability is PilotDeckToolRuntimeCapability =>
    capability === "always_on_run_context"
    || capability === "plan_workflow"
    || capability === "subagent_fork"
    || capability === "user_interaction");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asModelOverride(value: unknown): { provider: string; model: string } | undefined {
  const override = asRecord(value);
  const provider = asString(override?.provider);
  const model = asString(override?.model);
  return provider && model ? { provider, model } : undefined;
}

function asSubagentModel(value: unknown): AgentRuntimeConfig["subagentModel"] | undefined {
  if (value === undefined) return undefined;
  const model = asRecord(value);
  if (!model) throw new Error("agent.subagentModel must be an object.");
  const provider = asString(model.provider);
  if (!provider) throw new Error("agent.subagentModel.provider must be a non-empty string.");
  const modelName = asString(model.model);
  if (!modelName) throw new Error("agent.subagentModel.model must be a non-empty string.");
  return {
    provider,
    model: modelName,
    ...(model.maxContextTokens === undefined
      ? {}
      : { maxContextTokens: asRequiredPositiveInteger(model.maxContextTokens, "agent.subagentModel.maxContextTokens") }),
    ...(model.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: asRequiredPositiveInteger(model.maxOutputTokens, "agent.subagentModel.maxOutputTokens") }),
  };
}

function asRequiredPositiveInteger(value: unknown, field: string): number {
  const parsed = asPositiveInteger(value);
  if (parsed === undefined) throw new Error(`${field} must be a positive integer.`);
  return parsed;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asInputSchema(value: unknown): PilotDeckToolInputSchema {
  const schema = asRecord(value);
  return schema?.type === "object" ? schema as PilotDeckToolInputSchema : { type: "object" };
}

function asPermissionRules(value: unknown): Partial<PermissionRuleSet> | undefined {
  const rules = asRecord(value);
  if (!rules) return undefined;
  return {
    allow: Array.isArray(rules.allow) ? rules.allow as PermissionRuleSet["allow"] : undefined,
    deny: Array.isArray(rules.deny) ? rules.deny as PermissionRuleSet["deny"] : undefined,
    ask: Array.isArray(rules.ask) ? rules.ask as PermissionRuleSet["ask"] : undefined,
  };
}

function isToolKind(value: unknown): value is PilotDeckToolDefinition["kind"] {
  return value === "filesystem" || value === "shell" || value === "network" || value === "mcp"
    || value === "session" || value === "agent" || value === "structured_output" || value === "custom";
}

export default createSidecarExecution;
