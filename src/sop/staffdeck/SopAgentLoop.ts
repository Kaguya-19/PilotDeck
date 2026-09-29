import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import { AgentLoop, type AgentLoopSeedState } from "../../agent/loop/AgentLoop.js";
import type {
  AgentTurnCapabilities,
  ToolExecutionPort,
} from "../../agent/loop/AgentTurnCapabilities.js";
import type { AgentLoopRuntimeFactoryInput } from "../../agent/loop/AgentLoopRuntimeFactory.js";
import type { AgentLoopRuntimeFactory } from "../../agent/loop/AgentLoopRuntimeFactory.js";
import type { AgentRuntimeConfig } from "../../agent/runtime/AgentRuntimeConfig.js";
import type { AgentLoopRunner } from "../../agent/turn/TurnRunner.js";
import type { AgentEvent } from "../../agent/protocol/events.js";
import type { AgentLoopInput, AgentLoopRunResult } from "../../agent/loop/AgentLoop.js";
import type { ModelExecutionContext, ToolPort } from "../../agent/modules/protocol.js";
import type {
  PilotDeckToolCall,
  PilotDeckToolDefinition,
  PilotDeckToolResult,
  PilotDeckToolRuntimeContext,
} from "../../tool/index.js";
import { toolError } from "../../tool/index.js";

import { StaffDeckSopClient, StaffDeckSopClientError } from "./StaffDeckSopClient.js";
import { StaffDeckSopDiscoveryClient } from "./StaffDeckSopDiscoveryClient.js";
import { loadStaffDeckSopDefinitions } from "./StaffDeckSopDefinitions.js";
import { SopStateStore } from "./SopStateStore.js";
import type {
  StaffDeckSopBundle,
  StaffDeckSopPrepareResponse,
  StaffDeckSopProposal,
  StaffDeckSopReplyDelivery,
  StaffDeckSopRuntimeClient,
  SopRuntimeConfig,
  StaffDeckSopSubmitResult,
  StaffDeckSopDiscoveryPort,
} from "./types.js";
import type { SidecarModuleComposition } from "../../agent/modules/transport/sidecarHostModulePorts.js";

export const SUBMIT_SOP_STEP_RESULT_TOOL = "submit_step_result";

type SopSubmission = Readonly<{
  result: StaffDeckSopSubmitResult;
}>;

type SopAgentLoopOptions = Readonly<{
  profile: SopRuntimeConfig;
  bundle: StaffDeckSopBundle;
  client?: StaffDeckSopRuntimeClient;
  stateStore?: SopStateStore;
  /** Optional externally deployed loop. SOP remains a host-side decorator. */
  runnerFactory?: AgentLoopRuntimeFactory;
  sidecarModules?: SidecarModuleComposition;
  sidecarTransportContext?: AgentLoopRuntimeFactoryInput["sidecarTransportContext"];
}>;

/**
 * Adds the StaffDeck SOP control plane around, rather than into, PilotDeck's
 * native AgentLoop. Model, tools, context, transcript and session ownership
 * remain on the PilotDeck side of the boundary.
 */
export class SopAgentLoop implements AgentLoopRunner {
  private readonly stateStore: SopStateStore;
  private readonly client: StaffDeckSopRuntimeClient;
  private readonly submissions = new Map<string, SopSubmission>();
  private readonly selectedSops = new Map<string, string | undefined>();
  private readonly sessionContext = new AsyncLocalStorage<string>();
  private readonly discovery: StaffDeckSopDiscoveryPort | undefined;
  private readonly native: AgentLoopRunner;
  private readonly preparedSteps = new Map<string, StaffDeckSopPrepareResponse["step"]>();
  private readonly protocolCorrections = new Map<string, string>();
  private readonly collectInputs = new Map<string, string>();
  private readonly collectCorrectionTurns = new Set<string>();

  constructor(
    config: AgentRuntimeConfig,
    capabilities: AgentTurnCapabilities,
    seedState: AgentLoopSeedState | undefined,
    private readonly options: SopAgentLoopOptions,
  ) {
    config.stopOnStructuredOutput = true;
    assertRequiredSopTools(options.bundle, options.profile.defaultSopId, capabilities.toolExecution.list());
    this.stateStore = options.stateStore ?? new SopStateStore(join(config.staffDeckSop!.stateRoot, "sessions"));
    this.client = options.client ?? new StaffDeckSopClient(options.profile.endpoint, {
      timeoutMs: options.profile.timeoutMs,
      ...("implementationId" in options.profile
        ? {
            manifestPath: options.profile.manifestPath,
            expectedManifest: {
              implementationId: options.profile.implementationId,
              contract: options.profile.contract,
              transport: options.profile.transport,
            },
          }
      : {}),
    });
    this.discovery = options.profile.discoveryEndpoint && options.profile.discoveryAgentId && options.profile.discoveryApiKey
      ? new StaffDeckSopDiscoveryClient(
          options.profile.discoveryEndpoint,
          options.profile.discoveryAgentId,
          options.profile.discoveryApiKey,
          {
            path: options.profile.discoveryPath,
            timeoutMs: options.profile.discoveryTimeoutMs ?? options.profile.timeoutMs,
          },
        )
      : undefined;

    const controlPort = new SopControlToolPort({
      delegate: capabilities.toolExecution,
      client: this.client,
      stateStore: this.stateStore,
      bundle: options.bundle,
      defaultSopId: options.profile.defaultSopId,
      selectedSopId: (sessionId) => this.selectedSops.get(sessionId),
      selectedSopForTools: () => {
        if (!this.discovery) return options.profile.defaultSopId;
        const sessionId = this.sessionContext.getStore();
        return sessionId ? this.selectedSops.get(sessionId) : undefined;
      },
      currentStepForTools: () => {
        const sessionId = this.sessionContext.getStore();
        return sessionId ? this.preparedSteps.get(sessionId) : undefined;
      },
      onSubmission: (sessionId, result) => this.submissions.set(sessionId, { result }),
      currentStep: (sessionId) => this.preparedSteps.get(sessionId),
      collectInput: (sessionId) => this.collectInputs.get(sessionId) ?? "",
      shouldReviewCollectWait: (sessionId, turnId) => {
        const key = `${sessionId}:${turnId}`;
        if (this.collectCorrectionTurns.has(key)) return false;
        this.collectCorrectionTurns.add(key);
        return true;
      },
    });
    const toolExecution: ToolExecutionPort = Object.freeze({
      list: () => controlPort.list(),
      executeAll: (calls, context, execution) => controlPort.executeAll(calls, context, execution),
      auditRecorder: capabilities.toolExecution.auditRecorder,
      fileHistory: capabilities.toolExecution.fileHistory,
      fileUpdateNotifier: capabilities.toolExecution.fileUpdateNotifier,
    });
    const contextPreparation = Object.freeze({
      prepareForModel: (input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0]) =>
        this.prepareContext(capabilities, input),
    });
    const wrappedCapabilities = Object.freeze({
      ...capabilities,
      model: Object.freeze({
        ...capabilities.model,
        execution: {
          prepare: (input: Parameters<typeof capabilities.model.execution.prepare>[0]) =>
            capabilities.model.execution.prepare({ ...input, request: {
              ...input.request,
              ...sopModelTools(this.preparedSteps.get(input.context.sessionId), input.request.tools),
            } }),
          stream: (input: Parameters<typeof capabilities.model.execution.stream>[0]) => capabilities.model.execution.stream({
            ...input,
            prepared: { ...input.prepared, request: { ...input.prepared.request,
              ...sopModelTools(this.preparedSteps.get(input.context.sessionId), input.prepared.request.tools),
            } },
          }),
        },
      }),
      toolExecution,
      contextPreparation,
      tools: Object.freeze({
        ...capabilities.tools,
        port: controlPort,
      }),
    }) as AgentTurnCapabilities;
    this.native = options.runnerFactory
      ? options.runnerFactory({
          config,
          capabilities: wrappedCapabilities,
          sidecarModules: options.sidecarModules
            ? wrapSidecarModules(options.sidecarModules, controlPort, (input) => this.prepareContext(capabilities, input),
                (sessionId) => this.preparedSteps.get(sessionId))
            : undefined,
          seedState,
          sidecarTransportContext: options.sidecarTransportContext,
        })
      : new AgentLoop(config, wrappedCapabilities, seedState);
  }

  snapshotFileState(): AgentLoopSeedState {
    return this.native.snapshotFileState();
  }

  seedReadState(filePath: string, mtimeMs: number): Promise<{ applied: boolean }> {
    return this.native.seedReadState?.(filePath, mtimeMs) ?? Promise.resolve({ applied: false });
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    this.submissions.delete(input.sessionId);
    this.protocolCorrections.delete(input.sessionId);
    this.collectCorrectionTurns.delete(`${input.sessionId}:${input.turnId}`);
    this.collectInputs.set(input.sessionId, latestUserMessage(input.messages));
    const recoverableDelivery = await this.stateStore.replyDelivery(input.sessionId);
    if (recoverableDelivery) {
      const active = (await this.stateStore.status(input.sessionId))?.state.status === "active";
      const recovered = yield* this.deliverReply(input, recoverableDelivery, !active);
      if (!active) return recovered;
      input = { ...input, messages: recovered.messages };
    }
    await this.selectSop(input, this.discovery);
    let completed: AgentLoopRunResult;
    let delayedCompletion: Extract<AgentEvent, { type: "turn_completed" }> | undefined;
    const correctionsByStep = new Map<string, number>();
    let sawToolError = false;
    let iterator = this.native.run(input);
    while (true) {
      const next = await this.sessionContext.run(input.sessionId, () => iterator.next());
      if (next.done) {
        completed = next.value;
        const state = await this.stateStore.status(input.sessionId);
        if (!sawToolError && this.selectedSops.get(input.sessionId)
          && !this.submissions.has(input.sessionId) && state?.state.status === "active"
          && completed.result.stopReason === "completed") {
          // A provider can ignore tool_choice and end with prose. Give each
          // active node one correction in this turn, without fabricating a result.
          const stepKey = sopStepKey(
            state.state.active_skill_id ?? state.state.selected_skill_id ?? this.selectedSops.get(input.sessionId),
            state.state.active_step_id ?? this.preparedSteps.get(input.sessionId)?.nodeId,
          );
          const attempted = correctionsByStep.get(stepKey) ?? 0;
          if (attempted >= 1) throw new Error("SOP_STEP_RESULT_REQUIRED: model ended without submitting the active node result");
          correctionsByStep.set(stepKey, attempted + 1);
          this.protocolCorrections.set(input.sessionId, stepKey);
          input = { ...input, messages: completed.messages };
          iterator = this.native.run(input);
          continue;
        }
        break;
      }
      if (next.value.type === "tool_result" && next.value.result.type === "error"
        && next.value.result.error.code !== "invalid_tool_input") sawToolError = true;
      if (next.value.type === "turn_completed") {
        delayedCompletion = next.value;
        continue;
      }
      yield next.value;
    }

    const submission = this.submissions.get(input.sessionId);
    if (!submission) {
      if (delayedCompletion) yield delayedCompletion;
      return completed;
    }
    const finalMessage = replyMessage(submission.result, input.turnId);
    await input.onDurableMessage?.(finalMessage);
    await this.stateStore.markReplyDurable(input.sessionId, input.turnId);
    yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: finalMessage };
    const rewritten: AgentLoopRunResult = {
      result: {
        ...completed.result,
        finalMessage,
        structuredOutput: {
          sop: submission.result,
        },
      },
      messages: [...completed.messages, finalMessage],
    };
    if (delayedCompletion) {
      yield { ...delayedCompletion, result: rewritten.result };
    }
    await this.stateStore.clearReplyDelivery(input.sessionId, input.turnId);
    return rewritten;
  }

  private async *deliverReply(
    input: AgentLoopInput,
    delivery: StaffDeckSopReplyDelivery,
    finishTurn = true,
  ): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    const finalMessage = replyMessage(delivery.result, finishTurn ? input.turnId : `${input.turnId}:recovered-step`);
    if (delivery.phase === "pending" || delivery.turnId !== input.turnId) {
      await input.onDurableMessage?.(finalMessage);
      await this.stateStore.markReplyDurable(input.sessionId, delivery.turnId, input.turnId);
      yield { type: "assistant_message", sessionId: input.sessionId, turnId: input.turnId, message: finalMessage };
    }
    const now = new Date().toISOString();
    const result: AgentLoopRunResult["result"] = {
      type: "success",
      sessionId: input.sessionId,
      turnId: input.turnId,
      finalMessage,
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 0,
      startedAt: now,
      completedAt: now,
      structuredOutput: { sop: delivery.result },
    };
    if (finishTurn) yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
    await this.stateStore.clearReplyDelivery(input.sessionId, input.turnId);
    return { result, messages: appendReplyOnce(input.messages, finalMessage) };
  }

  private async prepareContext(
    capabilities: AgentTurnCapabilities,
    input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0],
  ) {
    const selectedSopId = this.selectedSops.get(input.sessionId);
    this.preparedSteps.delete(input.sessionId);
    if (!selectedSopId) return capabilities.contextPreparation.prepareForModel(input);
    const persisted = await this.stateStore.loadOrCreate(
      input.sessionId,
      this.options.bundle,
      selectedSopId,
    );
    if (isTerminalSopStatus(persisted.state.status)) {
      return capabilities.contextPreparation.prepareForModel(input);
    }
    const ownerPrepared = await this.client.prepare({
      bundle: persisted.bundle,
      state: persisted.state,
      context: {
        runId: `sop:${input.sessionId}:${input.turnId}`,
        operationId: `sop.prepare:${input.sessionId}:${input.turnId}`,
        requestId: `sop.prepare:${input.sessionId}:${input.turnId}:${input.stepId ?? 0}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        idempotencyKey: `sop.prepare:${input.sessionId}:${input.turnId}:${input.stepId ?? 0}`,
        expectedRevision: persisted.revision,
      },
      signal: input.abortSignal,
    });
    // The owner exposes a knowledge_query node without mapping its domain
    // binding to the PilotDeck tool name. Keep that host mapping here.
    const prepared = ownerPrepared.step.node.type === "knowledge_query"
      ? { ...ownerPrepared, step: { ...ownerPrepared.step,
          requiredToolNames: [...new Set([...ownerPrepared.step.requiredToolNames, "knowledge_query"])] } }
      : ownerPrepared;
    await this.stateStore.replace(input.sessionId, persisted.bundle, prepared.state);
    this.preparedSteps.set(input.sessionId, prepared.step);
    return capabilities.contextPreparation.prepareForModel({
      ...input,
      appendSystemPrompt: joinPrompt(input.appendSystemPrompt, joinPrompt(renderSopInstruction(prepared),
        this.protocolCorrections.get(input.sessionId) === sopStepKey(prepared.step.skillId, prepared.step.nodeId)
          ? prepared.step.isTerminal
            ? "SOP_STEP_RESULT_REQUIRED: The previous assistant text was only a draft. The final SOP node is still active. Call submit_step_result now with status completed, the final answer in replyFragment, slotUpdates {}, and no nextStepId. Do not repeat the draft as plain assistant text."
            : "SOP_STEP_RESULT_REQUIRED: Your previous response did not submit the current SOP node result. Text cannot create an approval or missing-field wait. Follow the current node contract and call submit_step_result with your actual result before ending. Do not claim a persisted wait or completion without a successful tool receipt."
          : "")),
    });
  }

  private async selectSop(
    input: AgentLoopInput,
    discovery: StaffDeckSopDiscoveryPort | undefined,
  ): Promise<void> {
    const existing = await this.stateStore.status(input.sessionId);
    const persistedSelection = existing?.state.selected_skill_id ?? existing?.state.active_skill_id;
    if (persistedSelection) {
      ensureBundleSop(this.options.bundle, persistedSelection);
      this.selectedSops.set(input.sessionId, persistedSelection);
      return;
    }
    if (!discovery) {
      this.selectedSops.set(input.sessionId, this.options.profile.defaultSopId);
      return;
    }
    const result = await discovery.route({
      message: latestUserMessage(input.messages),
      sessionId: input.sessionId,
    });
    const selected = result.selectedSopId ?? undefined;
    if (selected && result.candidateSopIds && !result.candidateSopIds.includes(selected)) {
      throw Object.assign(
        new Error(`StaffDeck SOP discovery selected '${selected}', but StaffDeck did not expose it as a candidate.`),
        { code: "SOP_DISCOVERY_SELECTION_NOT_VISIBLE", selectedSopId: selected },
      );
    }
    if (selected) ensureBundleSop(this.options.bundle, selected);
    this.selectedSops.set(input.sessionId, selected);
  }
}

/** Creates a native PilotDeck loop decorated with one StaffDeck SOP profile. */
export function createStaffDeckSopAgentLoop(
  input: AgentLoopRuntimeFactoryInput,
  profile: SopRuntimeConfig,
  runnerFactory?: AgentLoopRuntimeFactory,
): SopAgentLoop {
  const bundle = loadStaffDeckSopDefinitions(profile.definitionsPath);
  if (!bundle.sops.some((definition) => sopId(definition) === profile.defaultSopId)) {
    throw new Error(`StaffDeck SOP defaultSopId '${profile.defaultSopId}' is not present in ${profile.definitionsPath}.`);
  }
  return new SopAgentLoop(input.config, input.capabilities, input.seedState, {
    profile,
    bundle,
    ...(runnerFactory ? { runnerFactory } : {}),
    ...(input.sidecarModules ? { sidecarModules: input.sidecarModules } : {}),
    ...(input.sidecarTransportContext ? { sidecarTransportContext: input.sidecarTransportContext } : {}),
  });
}

function wrapSidecarModules(
  modules: SidecarModuleComposition,
  controlPort: ToolPort,
  prepareForModel: (input: Parameters<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>[0]) => ReturnType<AgentTurnCapabilities["contextPreparation"]["prepareForModel"]>,
  currentStep: (sessionId: string) => StaffDeckSopPrepareResponse["step"] | undefined,
): SidecarModuleComposition {
  return Object.freeze({
    ...modules,
    model: Object.freeze({
      ...modules.model,
      execution: {
        prepare: (input: Parameters<typeof modules.model.execution.prepare>[0]) => modules.model.execution.prepare({
          ...input, request: { ...input.request, ...sopModelTools(currentStep(input.context.sessionId), input.request.tools) },
        }),
        stream: (input: Parameters<typeof modules.model.execution.stream>[0]) => modules.model.execution.stream({
          ...input, prepared: { ...input.prepared, request: { ...input.prepared.request,
            ...sopModelTools(currentStep(input.context.sessionId), input.prepared.request.tools),
          } },
        }),
      },
    }),
    capability: Object.freeze({
      ...modules.capability,
      execution: controlPort,
    }),
    ...(modules.context
      ? {
          context: Object.freeze({
            ...modules.context,
            execution: Object.freeze({
              ...modules.context.execution,
              prepareForModel,
            }),
          }),
        }
      : {}),
  });
}

type SopControlToolPortOptions = Readonly<{
  delegate: ToolPort;
  client: StaffDeckSopRuntimeClient;
  stateStore: SopStateStore;
  bundle: StaffDeckSopBundle;
  defaultSopId: string;
  selectedSopId(sessionId: string): string | undefined;
  currentStep(sessionId: string): StaffDeckSopPrepareResponse["step"] | undefined;
  collectInput(sessionId: string): string;
  shouldReviewCollectWait(sessionId: string, turnId: string): boolean;
  selectedSopForTools(): string | undefined;
  currentStepForTools(): StaffDeckSopPrepareResponse["step"] | undefined;
  onSubmission(sessionId: string, result: StaffDeckSopSubmitResult): void;
}>;

class SopControlToolPort implements ToolPort {
  constructor(private readonly options: SopControlToolPortOptions) {}

  list(): PilotDeckToolDefinition[] {
    const tools = this.options.delegate.list();
    if (tools.some((tool) => tool.name === SUBMIT_SOP_STEP_RESULT_TOOL)) {
      throw new Error(`${SUBMIT_SOP_STEP_RESULT_TOOL} is reserved by the StaffDeck SOP runtime.`);
    }
    if (!this.options.selectedSopForTools()) return tools;
    const step = this.options.currentStepForTools();
    return step && step.requiredToolNames.length === 0
      ? [submitSopStepResultTool()]
      : [...tools, submitSopStepResultTool()];
  }

  async executeAll(
    calls: PilotDeckToolCall[],
    context: PilotDeckToolRuntimeContext,
    execution: ModelExecutionContext,
  ): Promise<PilotDeckToolResult[]> {
    const controls = calls.filter((call) => call.name === SUBMIT_SOP_STEP_RESULT_TOOL);
    const ordinary = calls.filter((call) => call.name !== SUBMIT_SOP_STEP_RESULT_TOOL);
    const ordinaryResults = ordinary.length > 0
      ? await this.options.delegate.executeAll(ordinary, context, execution)
      : [];
    const resultByCallId = new Map(ordinaryResults.map((result) => [result.toolCallId, result]));

    const selectedSopId = this.options.selectedSopId(execution.sessionId);
    if (selectedSopId && ordinaryResults.some((result) => result.type === "success")) {
      await this.options.stateStore.recordSuccessfulTools(
        execution.sessionId,
        this.options.bundle,
        selectedSopId,
        ordinaryResults
          .filter((result): result is Extract<PilotDeckToolResult, { type: "success" }> => result.type === "success")
          .map((result) => result.toolName),
      );
    }

    for (const call of controls) {
      const result = ordinary.length > 0
        ? controlError(call, "Call submit_step_result only after the preceding tool results are available to you.")
        : await this.submit(call, execution);
      resultByCallId.set(call.id, result);
    }
    return calls.map((call) => resultByCallId.get(call.id) ?? controlError(call, "Tool execution produced no result."));
  }

  private async submit(call: PilotDeckToolCall, execution: ModelExecutionContext): Promise<PilotDeckToolResult> {
    if (!this.options.selectedSopId(execution.sessionId)) {
      return controlError(call, "No StaffDeck SOP is selected for this session.");
    }
    let proposal = parseProposal(call.input);
    if (!proposal) return controlError(call, "submit_step_result requires a valid status, non-empty replyFragment, and correctly typed known fields.", "invalid_tool_input");
    try {
      const persisted = await this.options.stateStore.loadOrCreate(
        execution.sessionId,
        this.options.bundle,
        this.options.selectedSopId(execution.sessionId) ?? this.options.defaultSopId,
      );
      const currentStep = this.options.currentStep(execution.sessionId);
      if (currentStep && currentStep.nodeId === persisted.state.active_step_id) {
        for (const field of currentStep.expectedUserInfo) {
          if (Object.hasOwn(proposal.slotUpdates ?? {}, field)
            && slotFilled(persisted.state.slots_json?.[field])
            && !slotFilled(proposal.slotUpdates?.[field])) {
            return controlError(call, `REQUIRED_SLOT_ERASURE: ${field} is already filled; an empty update cannot erase it.`, "invalid_tool_input");
          }
        }
      }
      if (proposal.status === "handoff" && currentStep && currentStep.nodeId === persisted.state.active_step_id && !currentStep.declaresHandoff) {
        return controlError(call, "HANDOFF_NOT_DECLARED: complete the current evidence step and advance to the declared approval node before creating handoff.", "invalid_tool_input");
      }
      if (proposal.status === "awaiting_user" && currentStep && currentStep.nodeId === persisted.state.active_step_id && currentStep.declaresHandoff) {
        return controlError(call, "HANDOFF_REQUIRED: this node declares a resumable human approval handoff. Submit handoff to wait for the responsible person's reply; awaiting_user cannot create that approval wait.", "invalid_tool_input");
      }
      if (proposal.status === "awaiting_user") {
        if (proposal.nextStepId) return controlError(call, "AWAITING_USER_CANNOT_ADVANCE: remove nextStepId and retain the current step.", "invalid_tool_input");
        if (currentStep && currentStep.nodeId === persisted.state.active_step_id) {
          const slots = { ...persisted.state.slots_json, ...proposal.slotUpdates };
          const missing = missingFields(currentStep.expectedUserInfo, slots);
          const type = currentStep.node.type;
          if (missing.length > 0 && type === "collect_info"
            && (persisted.state.status === "awaiting_user" || Object.keys(proposal.slotUpdates ?? {}).length === 0)
            && this.options.collectInput(execution.sessionId).trim()
            && this.options.shouldReviewCollectWait(execution.sessionId, execution.turnId)) {
            return controlError(call,
              `COLLECT_FIELDS_CHECK: Before waiting, re-read this turn's user message: ${JSON.stringify(this.options.collectInput(execution.sessionId))}. `
              + `Persisted slots: ${JSON.stringify(persisted.state.slots_json ?? {})}. Your proposal still leaves these fields missing: ${missing.join(", ")}. `
              + `Extract every explicitly supplied value into slotUpdates using these exact keys: ${currentStep.expectedUserInfo.join(", ")}. `
              + "If a field is genuinely absent, resubmit awaiting_user for only that field; do not invent a value or repeat fields already supplied.",
              "invalid_tool_input");
          }
          if (missing.length === 0 && (currentStep.expectedUserInfo.length > 0
            || !currentStep.allowedActions.some((action) => action === "ask_user" || action === "ask_missing"))) {
            return controlError(call, "STEP_MUST_ADVANCE: required fields are complete. Submit completed to an allowed next step; approval belongs to the declared handoff node.", "invalid_tool_input");
          }
          if (type === "collect_info" && missing.length > 0) {
            proposal = { ...proposal, replyFragment: missingFieldsReply(missing) };
          }
        }
      }
      if (proposal.status === "completed" && currentStep && currentStep.nodeId === persisted.state.active_step_id
        && currentStep.isTerminal && currentStep.expectedUserInfo.length === 0
        && !currentStep.allowedActions.some((action) => action === "ask_user" || action === "ask_missing")
        && claimsUnresolvedUserWait(proposal.replyFragment)) {
        return controlError(call,
          "FINAL_REPLY_CONTRADICTS_COMPLETION: this terminal step has no missing user fields, but replyFragment says progress is blocked or asks the user for missing information. Rewrite the final answer from the current step instruction and known facts, then submit completed without a nextStepId. Do not reuse the rejected waiting reply.",
          "invalid_tool_input");
      }
      const successfulToolNames = Array.isArray(persisted.state.successful_tool_names)
        ? persisted.state.successful_tool_names.filter((name): name is string => typeof name === "string" && name.length > 0)
        : [];
      if (proposal.status === "completed" && currentStep?.node.type === "knowledge_query"
        && !successfulToolNames.includes("knowledge_query")) {
        return controlError(call, "REQUIRED_CAPABILITY_NOT_INVOKED: the current knowledge node requires a successful knowledge_query receipt before completion.", "invalid_tool_input");
      }
      const submitted = await this.options.client.submit({
        bundle: persisted.bundle,
        state: persisted.state,
        proposal,
        successfulToolNames,
        context: {
          runId: execution.runId,
          operationId: execution.operationId ?? `sop.submit:${execution.sessionId}:${execution.turnId}`,
          requestId: `sop.submit:${call.id}`,
          sessionId: execution.sessionId,
          turnId: execution.turnId,
          idempotencyKey: call.id,
          deadlineAt: execution.operationDeadline,
          expectedRevision: persisted.revision,
        },
        signal: execution.abortSignal,
      });
      await this.options.stateStore.commitSubmission(
        execution.sessionId,
        persisted.bundle,
        submitted.state,
        persisted.revision,
        execution.turnId,
        submitted.result,
      );
      // Node completion may leave the owner SOP active. In that case the
      // result is an ordinary tool receipt, so the same native turn prepares
      // the next node. Only an owner wait or terminal outcome ends the turn.
      const finishTurn = submitted.state.status !== "active";
      if (finishTurn) this.options.onSubmission(execution.sessionId, submitted.result);
      else await this.options.stateStore.clearReplyDelivery(execution.sessionId, execution.turnId);
      return controlSuccess(call, submitted.result, {
        submittedStepId: persisted.state.active_step_id ?? null,
        activeStepId: submitted.state.active_step_id ?? null,
        sopStatus: submitted.state.status ?? null,
        finishTurn,
      });
    } catch (error) {
      const sopError = describeSopError(error);
      return controlError(call, `[${sopError.code}] ${sopError.message}`, sopError.toolCode, sopError.details);
    }
  }
}

function describeSopError(error: unknown): {
  code: string;
  message: string;
  toolCode: "tool_aborted" | "tool_execution_failed";
  details: Record<string, unknown>;
} {
  const code = error instanceof StaffDeckSopClientError
    ? error.code
    : isRecord(error) && typeof error.code === "string" ? error.code : "SOP_RUNTIME_REJECTED";
  const message = error instanceof Error ? error.message : String(error);
  const retryability = error instanceof StaffDeckSopClientError ? error.retryability ?? "unsafe" : "unsafe";
  const ownerDetails = error instanceof StaffDeckSopClientError ? error.details : undefined;
  return {
    code,
    message,
    toolCode: code === "SOP_RUNTIME_CANCELLED" ? "tool_aborted" : "tool_execution_failed",
    details: {
      ...(ownerDetails ?? {}),
      sopRuntime: { code, message, retryability, details: ownerDetails ?? {} },
    },
  };
}

function replyMessage(result: StaffDeckSopSubmitResult, turnId: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: result.replyFragment }],
    metadata: { purpose: "staffdeck_sop_reply", transientId: `staffdeck-sop-reply:${turnId}` },
  };
}

function appendReplyOnce(
  messages: AgentLoopInput["messages"],
  reply: ReturnType<typeof replyMessage>,
): AgentLoopInput["messages"] {
  const duplicate = messages.some((message) => message.metadata?.transientId === reply.metadata.transientId);
  return duplicate ? messages : [...messages, reply];
}

function submitSopStepResultTool(): PilotDeckToolDefinition {
  return {
    name: SUBMIT_SOP_STEP_RESULT_TOOL,
    title: "Submit SOP step result",
    description: "Submit the current StaffDeck SOP step result after all required PilotDeck tools have returned successfully.",
    kind: "structured_output",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "awaiting_user", "handoff", "failed", "blocked", "waiting_external_task"] },
        replyFragment: { type: "string" },
        slotUpdates: { type: "object", additionalProperties: true,
          description: "Persist every known user field using the Required user information keys. Required even for awaiting_user: missing other fields must not discard fields already supplied. Use {} only when no new fields are known." },
        taskSummary: { type: "string" },
        structuredResult: {},
        nextStepId: { type: "string" },
      },
      required: ["status", "replyFragment", "slotUpdates"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    execute: async () => {
      throw new Error("submit_step_result is executed by the StaffDeck SOP control port.");
    },
  };
}

function parseProposal(value: unknown): StaffDeckSopProposal | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  const replyFragment = text(value.replyFragment);
  if (!isSopStatus(status) || !replyFragment) return undefined;
  if ((value.slotUpdates !== undefined && !isRecord(value.slotUpdates))
    || (value.nextStepId !== undefined && value.nextStepId !== null && typeof value.nextStepId !== "string")
    || (value.taskSummary !== undefined && value.taskSummary !== null && typeof value.taskSummary !== "string")) return undefined;
  return {
    status,
    replyFragment,
    ...(isRecord(value.slotUpdates) ? { slotUpdates: value.slotUpdates } : {}),
    ...(text(value.taskSummary) ? { taskSummary: text(value.taskSummary) } : {}),
    ...(Object.hasOwn(value, "structuredResult") ? { structuredResult: value.structuredResult } : {}),
    ...(text(value.nextStepId) ? { nextStepId: text(value.nextStepId) } : {}),
  };
}

function missingFields(fields: readonly string[], slots: Record<string, unknown>): string[] {
  return fields.filter((field) => !slotFilled(slots[field]));
}

function slotFilled(value: unknown): boolean {
  return value != null && (typeof value !== "string" || Boolean(value.trim()))
    && (!Array.isArray(value) || value.length > 0)
    && (!isRecord(value) || Object.keys(value).length > 0);
}

function missingFieldsReply(fields: readonly string[]): string {
  return `请补充以下信息，以继续当前步骤：\n${fields.map((field) => `- ${field}`).join("\n")}`;
}

function claimsUnresolvedUserWait(reply: string): boolean {
  // Match an active blocker or request, not a completed answer quoting an old error.
  return /(?:^|[。！？.!?\n])\s*(?:(?:由于)?(?:我|目前|当前|本步骤|此步骤|SOP).{0,80}(?:卡在|无法(?:继续|推进|完成|生成)|缺少.{0,30}(?:信息|资料|上下文))|请(?:您|你)?(?:提供|补充)|(?:I|we|this step|the SOP)\s+(?:(?:am|are|is)\s+)?(?:stuck|blocked|cannot|can't|lack|need more information)|(?:please|could you)\s+(?:provide|supply))/i.test(reply);
}

function controlSuccess(
  call: PilotDeckToolCall,
  result: StaffDeckSopSubmitResult,
  owner: { submittedStepId: string | null; activeStepId: string | null; sopStatus: string | null; finishTurn: boolean },
): PilotDeckToolResult {
  const now = new Date().toISOString();
  return {
    type: "success",
    toolCallId: call.id,
    toolName: SUBMIT_SOP_STEP_RESULT_TOOL,
    content: [{ type: "json", value: {
      submittedStepId: owner.submittedStepId,
      status: result.status,
      resultStatus: result.status,
      activeStepId: owner.activeStepId,
      sopStatus: owner.sopStatus,
      nextStepId: result.nextStepId ?? null,
      ...(owner.sopStatus === "active" ? { nextStepRequiresOwnSubmission: true } : {}),
    } }],
    data: result,
    metadata: { structuredOutput: owner.finishTurn },
    startedAt: now,
    completedAt: now,
  };
}

function controlError(
  call: PilotDeckToolCall,
  message: string,
  code: "invalid_tool_input" | "tool_aborted" | "tool_execution_failed" = "tool_execution_failed",
  details?: Record<string, unknown>,
): PilotDeckToolResult {
  const now = new Date().toISOString();
  return {
    type: "error",
    toolCallId: call.id,
    toolName: SUBMIT_SOP_STEP_RESULT_TOOL,
    error: toolError(code, message, details),
    content: [{ type: "text", text: message }],
    startedAt: now,
    completedAt: now,
  };
}

function sopToolChoice(step: StaffDeckSopPrepareResponse["step"] | undefined) {
  if (!step) return {};
  // Collection, approval and final response nodes have only a lifecycle
  // submission to perform. Require that named function rather than leaving
  // unrelated optional tools eligible to satisfy the protocol boundary.
  return { toolChoice: step.node.type === "knowledge_query" || step.requiredToolNames.length > 0
    ? "required" as const : { type: "tool" as const, name: SUBMIT_SOP_STEP_RESULT_TOOL } };
}

function sopModelTools<T extends { name: string }>(
  step: StaffDeckSopPrepareResponse["step"] | undefined,
  tools: readonly T[] | undefined,
) {
  return {
    ...sopToolChoice(step),
    ...(step && step.requiredToolNames.length === 0 && tools
      ? { tools: tools.filter((tool) => tool.name === SUBMIT_SOP_STEP_RESULT_TOOL) }
      : {}),
  };
}

function renderSopInstruction(prepared: StaffDeckSopPrepareResponse): string {
  const step = prepared.step;
  const lines = [
    "<staffdeck-sop>",
    `Current SOP: ${step.skillName} (${step.skillId}), step ${step.nodeId}.`,
    step.instruction ? `Step instruction: ${step.instruction}` : undefined,
    step.expectedUserInfo.length > 0 ? `Required user information: ${step.expectedUserInfo.join(", ")}.` : undefined,
    `Already persisted user fields: ${JSON.stringify(step.knownSlots)}.`,
    step.requiredToolNames.length > 0 ? `Required successful tools: ${step.requiredToolNames.join(", ")}.` : undefined,
    step.allowedNextStepIds.length > 0 ? `Allowed next steps: ${step.allowedNextStepIds.join(", ")}.` : undefined,
    step.transitions && step.transitions.length > 0
      ? `Transition guidance:\n${step.transitions.map((transition) => {
        const target = transition.targetStep;
        const targetName = text(target.name) ?? transition.nextStepId;
        const targetType = text(target.type);
        const targetInstruction = text(target.instruction);
        const targetParts = [targetName, targetType, targetInstruction].filter(Boolean).join("; ");
        const label = text(transition.label);
        const condition = transition.condition || "default";
        return `- ${transition.nextStepId}: condition=${condition}, priority=${transition.priority}${label ? `, label=${label}` : ""}; target=${targetParts}`;
      }).join("\n")}`
      : undefined,
    step.expectedUserInfo.length > 0
      ? "When required information is present in the user messages or tool results, include it in slotUpdates and submit completed to advance; use awaiting_user only when information is genuinely missing. If any required field is missing, your question MUST be the replyFragment of a submit_step_result call with status awaiting_user, known slotUpdates, and no nextStepId. Do not end with a plain-text question."
      : undefined,
    step.expectedUserInfo.length > 0
      ? "Before submitting, extract each supplied value into slotUpdates under its exact required field key, including when other fields remain missing. Preserve explicit user facts instead of replacing them with inferred risks or future changes. Saying a value is recorded in replyFragment does not store it. Do not submit an empty slotUpdates when the user has supplied any required field."
      : undefined,
    step.transitions && step.transitions.length > 0
      ? "Choose nextStepId from the transition whose condition matches the available facts. If the target is a handoff step, advance to it first and use status handoff there when approval is required."
      : undefined,
    step.declaresHandoff ? "This step declares a human handoff. When approval is required, use status handoff to create the resumable approval wait; do not use awaiting_user. When the responsible person has explicitly replied with approval, persist that reply with submit_step_result status completed and advance to an allowed next step. Do not end with a plain-text approval summary." : undefined,
    step.isTerminal
      ? "This is the active final SOP node, even if the previous node already submitted completed. Put the final user-facing answer in replyFragment and call submit_step_result with status completed, slotUpdates {}, and no nextStepId. Do not emit the answer as plain assistant text or claim the SOP is complete before this tool succeeds."
      : "A completed submission closes only this node. Its replyFragment is this node's result, not a submission or final answer for a successor node; the successor must be prepared and submitted separately.",
    !step.declaresHandoff && step.expectedUserInfo.length === 0 && step.allowedNextStepIds.length > 0
      && !step.allowedActions.some((action) => action === "ask_user" || action === "ask_missing")
      ? "This step has no missing user fields. After producing its required evidence or draft, submit completed and advance to an allowed next step. Approval belongs to the declared handoff step; do not pause this evidence step with awaiting_user."
      : undefined,
    "A question asking for missing fields is also a step result: persist it with awaiting_user and no nextStepId before ending the turn. A plain-text answer without submit_step_result does not persist SOP progress.",
    "When this step has a result, call submit_step_result exactly once. Do not claim a tool succeeded before its result is in the conversation.",
    "Use status awaiting_user for missing user information and handoff only when this step explicitly permits it.",
    "</staffdeck-sop>",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function joinPrompt(existing: string | undefined, sop: string): string {
  return [existing, sop].filter((value): value is string => Boolean(value?.trim())).join("\n\n");
}

function sopStepKey(skillId: string | null | undefined, stepId: string | null | undefined): string {
  return `${skillId ?? ""}:${stepId ?? ""}`;
}

function isTerminalSopStatus(value: unknown): boolean {
  return value === "completed" || value === "handoff" || value === "blocked" || value === "waiting_external_task";
}

function isSopStatus(value: unknown): value is StaffDeckSopProposal["status"] {
  return value === "completed" || value === "awaiting_user" || value === "handoff"
    || value === "failed" || value === "blocked" || value === "waiting_external_task";
}


function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sopId(definition: Record<string, unknown>): string | undefined {
  return text(definition.id) ?? text(definition.skill_id);
}

function ensureBundleSop(bundle: StaffDeckSopBundle, selectedSopId: string): void {
  if (!bundle.sops.some((definition) => sopId(definition) === selectedSopId)) {
    throw Object.assign(
      new Error(`StaffDeck SOP discovery selected '${selectedSopId}', but it is not present in the PilotDeck bundle.`),
      { code: "SOP_DISCOVERY_SELECTION_UNAVAILABLE", selectedSopId },
    );
  }
}

function latestUserMessage(messages: readonly { role?: unknown; content?: unknown }[]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type?: unknown; text?: unknown } => isRecord(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  }
  return "";
}

/**
 * StaffDeck declares every `call_tool:<name>` action as a required capability
 * for that graph node. Rejecting a selected definition without the host tool
 * makes an unavailable dependency a composition error rather than a turn that
 * can never satisfy the owner validation.
 */
function assertRequiredSopTools(
  bundle: StaffDeckSopBundle,
  defaultSopId: string,
  availableTools: readonly PilotDeckToolDefinition[],
): void {
  const definition = bundle.sops.find((candidate) => sopId(candidate) === defaultSopId);
  const content = definition?.content;
  if (!isRecord(content) || !Array.isArray(content.nodes)) return;
  const required = new Set<string>();
  for (const node of content.nodes) {
    if (!isRecord(node) || !Array.isArray(node.allowed_actions)) continue;
    for (const action of node.allowed_actions) {
      if (typeof action !== "string" || !action.startsWith("call_tool:")) continue;
      const name = action.slice("call_tool:".length).trim();
      if (name) required.add(name);
    }
  }
  const available = new Set(availableTools.map((tool) => tool.name));
  const missing = [...required].filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`StaffDeck SOP '${defaultSopId}' requires unavailable PilotDeck tools: ${missing.join(", ")}.`),
      { code: "SOP_REQUIRED_TOOL_UNAVAILABLE", missingToolNames: missing },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
