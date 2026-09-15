import { randomUUID } from "node:crypto";

import type { CanonicalModelEvent, CanonicalModelRequest, CanonicalMessage } from "../../../model/index.js";
import type { LifecycleDispatchResult } from "../../../lifecycle/index.js";
import { isPilotDeckHookEvent } from "../../../extension/hooks/protocol/events.js";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionRuleSet,
} from "../../../permission/index.js";
import type {
  PilotDeckToolCall,
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../../../tool/index.js";
import type { PilotDeckPlanTodoStateHandle } from "../../../tool/protocol/types.js";
import { createHostPlanTodoModuleHandler } from "../capability/hostPlanTodoModuleHandler.js";
import { HostToolCheckpoint } from "../checkpoint/hostToolCheckpoint.js";
import { parseAgentLoopSeedStateProjection, serializeAgentLoopSeedStateProjection } from "../checkpoint/seedStateProjection.js";
import { HostPermissionModeState } from "../permission/hostPermissionModeState.js";
import type {
  AgentLoopSidecarTransportObservation,
  AgentLoopSidecarTransportObserver,
} from "./sidecarTransportObserver.js";
import type {
  AgentLoopOperationAccepted,
  AgentLoopOperationIdentity,
  AgentLoopOperationKnownTerminal,
  AgentLoopOperationLedger,
  AgentLoopOperationResolution,
  AgentLoopOperationUnknownTerminal,
} from "./operationLedger.js";
import type {
  AgentExecutionContext,
  ModelExecutionContext,
  ModuleCapabilities,
  ModuleBinding,
  ModuleCallRequest,
  ModuleEvent,
  ModuleExecuteRequest,
  ModuleHandshakeRequest,
  ModuleMessage,
  ModuleOutcome,
  ModuleResponse,
  PreparedModelInvocation,
} from "../protocol.js";
import { MODULE_PROTOCOL_VERSION, validateModuleMessage } from "../protocol.js";
import type { AgentLoopRuntimeFactory } from "../../loop/AgentLoopRuntimeFactory.js";
import {
  isNoopAgentTurnContextPort,
  type AgentTurnCapabilities,
} from "../../loop/AgentTurnCapabilities.js";
import type { AgentLoopInput, AgentLoopRunResult, AgentLoopSeedState } from "../../loop/AgentLoop.js";
import type { AgentEvent } from "../../protocol/events.js";
import { agentError } from "../../protocol/errors.js";
import type { AgentTurnResult } from "../../protocol/result.js";
import type { AgentRuntimeConfig } from "../../runtime/AgentRuntimeConfig.js";
import type { AgentLoopRunner } from "../../turn/TurnRunner.js";
import { buildTurnEnvironment } from "../../turn/TurnEnvironment.js";

/**
 * One bidirectional connection to an AgentLoop sidecar. The application owns
 * process/stdio/socket lifecycle; this client only speaks Module Protocol.
 */
export type AgentLoopSidecarConnection = {
  send(message: ModuleMessage): void | Promise<void>;
  receive(): AsyncIterable<unknown>;
  /**
   * Optional transport-owned replacement connection. Only long-lived
   * transports implement this; the client never respawns or retries execute.
   */
  reconnect?(input: {
    streamId: string;
    previousBinding: ModuleBinding;
    lastAppliedSequence: number;
  }): AgentLoopSidecarConnection | Promise<AgentLoopSidecarConnection>;
  close?(reason?: unknown): void | Promise<void>;
};

export type AgentLoopSidecarConnectionFactoryInput = {
  config: AgentRuntimeConfig;
  capabilities: AgentTurnCapabilities;
  seedState?: AgentLoopSeedState;
  input: AgentLoopInput;
};

export type AgentLoopSidecarConnectionFactory = (
  input: AgentLoopSidecarConnectionFactoryInput,
) => AgentLoopSidecarConnection | Promise<AgentLoopSidecarConnection>;

/**
 * Immutable protocol facts supplied to the host when a sidecar cannot prove
 * an execute terminal. The host owns the operation ledger and may use these
 * values to query it; this client never retries or invents a result.
 */
export type AgentLoopSidecarResultUnknownInput = AgentLoopOperationUnknownTerminal;

/** A host-owned, already reconciled terminal for a result_unknown attempt. */
export type AgentLoopSidecarResultUnknownResolution = AgentLoopOperationResolution;

export type AgentLoopSidecarResultUnknownReconciler = (
  input: AgentLoopSidecarResultUnknownInput,
) => AgentLoopSidecarResultUnknownResolution | undefined | Promise<AgentLoopSidecarResultUnknownResolution | undefined>;

export type AgentLoopSidecarRuntimeFactoryOptions = {
  connect: AgentLoopSidecarConnectionFactory;
  /**
   * Optional host operation-ledger query for a sidecar result_unknown final.
   * Omitting it intentionally keeps result_unknown fail-closed.
   */
  reconcileResultUnknown?: AgentLoopSidecarResultUnknownReconciler;
  /** Optional explicit host ledger. Session composition supplies one by default. */
  operationLedger?: AgentLoopOperationLedger;
  /** Passive deployment telemetry. It cannot affect transport or turn semantics. */
  transportObserver?: AgentLoopSidecarTransportObserver;
  uuid?: () => string;
};

/**
 * Build the public, capability-only external AgentLoop factory for a
 * Module-Protocol sidecar. It deliberately has no Session, Router, Gateway,
 * scheduler, or persistence dependency.
 */
export function createAgentLoopSidecarRuntimeFactory(
  options: AgentLoopSidecarRuntimeFactoryOptions,
): AgentLoopRuntimeFactory {
  return ({ config, capabilities, seedState }) => new AgentLoopSidecarRunner({
    config,
    capabilities,
    seedState,
    connect: options.connect,
    reconcileResultUnknown: options.reconcileResultUnknown,
    operationLedger: options.operationLedger ?? capabilities.transport.operationLedger,
    transportObserver: options.transportObserver,
    uuid: options.uuid ?? randomUUID,
  });
}

class AgentLoopSidecarRunner implements AgentLoopRunner {
  private seedState: AgentLoopSeedState | undefined;
  private active = false;
  private readonly permissionMode: HostPermissionModeState;

  constructor(private readonly options: {
    config: AgentRuntimeConfig;
    capabilities: AgentTurnCapabilities;
    seedState?: AgentLoopSeedState;
    connect: AgentLoopSidecarConnectionFactory;
    reconcileResultUnknown?: AgentLoopSidecarResultUnknownReconciler;
    operationLedger?: AgentLoopOperationLedger;
    transportObserver?: AgentLoopSidecarTransportObserver;
    uuid: () => string;
  }) {
    this.seedState = cloneSeedState(options.seedState);
    this.permissionMode = new HostPermissionModeState(options.config);
  }

  snapshotFileState(): AgentLoopSeedState {
    return cloneSeedState(this.seedState) ?? {};
  }

  async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
    if (this.active) throw new Error("AgentLoop sidecar runner does not support concurrent turns.");
    this.active = true;
    let connection: AgentLoopSidecarConnection | undefined;
    let protocol: SidecarTurnProtocol | undefined;
    try {
      // Native AgentLoop applies submit overrides before it evaluates this
      // turn. The host keeps the resulting live policy for later turns too.
      this.applyRunModeOverride(input);
      this.permissionMode.applyTurnInput(input);
      if (input.abortSignal?.aborted) return abortedResult(input);
      // The connection provider and host module dispatcher must observe one
      // immutable checkpoint for this turn. A transport receives its own
      // clone so it cannot alter the host-owned seed used by capability calls.
      const turnSeedState = this.snapshotFileState();
      connection = await this.options.connect({
        config: this.options.config,
        capabilities: this.options.capabilities,
        seedState: cloneSeedState(turnSeedState),
        input,
      });
      protocol = new SidecarTurnProtocol({
        config: this.options.config,
        capabilities: this.options.capabilities,
        permissionMode: this.permissionMode,
        input,
        seedState: cloneSeedState(turnSeedState),
        uuid: this.options.uuid,
        reconcileResultUnknown: this.options.reconcileResultUnknown,
        operationLedger: this.options.operationLedger,
        transportObserver: this.options.transportObserver,
      });
      const result = yield* protocol.execute(connection);
      this.seedState = result.seedState;
      return { result: result.result, messages: result.messages };
    } finally {
      this.active = false;
      await protocol?.close("agent_loop_turn_finished") ?? connection?.close?.("agent_loop_turn_finished");
    }
  }

  private applyRunModeOverride(input: AgentLoopInput): void {
    // Mirror AgentLoop.applyRunModeOverride(). The host ToolRuntime and
    // lifecycle callbacks cannot treat a sidecar payload as policy authority.
    this.options.config.runMode = input.runMode ?? this.options.config.runMode ?? "agent";
  }
}

type SidecarTerminal = AgentLoopRunResult & { seedState?: AgentLoopSeedState };

type SidecarBinding = {
  moduleId: string;
  moduleInstanceId: string;
  connectionGeneration: string;
  capabilitiesVersion: string;
};

type CachedModuleResponse = {
  call: ModuleCallRequest;
  response: ModuleResponse;
};

/** One host-owned Module Protocol handler. Handlers are composed per turn. */
type SidecarModuleHandler = (call: ModuleCallRequest) => Promise<Record<string, unknown>>;
type SidecarModuleHandlers = Readonly<{
  model: SidecarModuleHandler;
  capability: SidecarModuleHandler;
  permission: SidecarModuleHandler;
  context: SidecarModuleHandler;
  lifecycle: SidecarModuleHandler;
  event: SidecarModuleHandler;
}>;

/** A new sidecar instance has no authority to replay a prior process's stream. */
class SidecarInstanceRestartedError extends Error {
  constructor() {
    super("Sidecar instance restarted while resuming a stream.");
    this.name = "SidecarInstanceRestartedError";
  }
}

class SidecarTurnProtocol {
  private helloMessageId = "";
  private capabilitiesMessageId = "";
  private readonly executeMessageId: string;
  private readonly runId: string;
  private readonly operationId: string;
  private readonly requestId: string;
  private readonly modelPreparations = new Map<string, PreparedModelInvocation>();
  /** Per-turn delivery cache. It is never persisted or shared across runs. */
  private readonly completedModuleResponses = new Map<string, CachedModuleResponse>();
  private streamId: string | undefined;
  private nextSequence = 0;
  private cancelSent = false;
  private cancelRequested = false;
  private supportsCancel = false;
  private supportsResume = false;
  private binding: SidecarBinding | undefined;
  private connectionBinding: SidecarBinding | undefined;
  private connection: AgentLoopSidecarConnection | undefined;
  private reconnectAttempts = 0;
  private pendingResumeBinding: ModuleBinding | undefined;
  private resumeMessageId: string | undefined;
  private reconnectSucceeded = false;
  private reconnectFailureObserved = false;
  private resultUnknownSource: "sidecar_final" | "transport_interruption" | undefined;
  private readonly hostToolCheckpoint: HostToolCheckpoint;
  private readonly handlers: SidecarModuleHandlers;
  private readonly planTodoHandler: (call: ModuleCallRequest) => Promise<Record<string, unknown>>;

  constructor(private readonly options: {
    config: AgentRuntimeConfig;
    capabilities: AgentTurnCapabilities;
    permissionMode: HostPermissionModeState;
    input: AgentLoopInput;
    seedState?: AgentLoopSeedState;
    uuid: () => string;
    reconcileResultUnknown?: AgentLoopSidecarResultUnknownReconciler;
    operationLedger?: AgentLoopOperationLedger;
    transportObserver?: AgentLoopSidecarTransportObserver;
  }) {
    this.hostToolCheckpoint = new HostToolCheckpoint(options.seedState, options.input.allowedReadFiles);
    this.helloMessageId = `hello-${options.uuid()}`;
    this.capabilitiesMessageId = `capabilities-${options.uuid()}`;
    this.executeMessageId = `execute-${options.uuid()}`;
    this.runId = options.input.execution?.runId ?? `run-${options.uuid()}`;
    this.operationId = options.input.execution?.operationId ?? options.input.turnId;
    this.requestId = `request-${options.uuid()}`;
    this.planTodoHandler = createHostPlanTodoModuleHandler({
      sessionId: options.input.sessionId,
      turnId: options.input.turnId,
      resolve: () => options.capabilities.planMode.planTodoManager?.forSession(options.input.sessionId),
    });
    this.handlers = Object.freeze({
      model: (call) => this.dispatchModel(call),
      capability: (call) => this.dispatchCapability(call),
      permission: (call) => this.dispatchPermission(call),
      context: (call) => this.dispatchContext(call),
      lifecycle: (call) => this.dispatchLifecycle(call),
      event: (call) => this.dispatchEvent(call),
    });
  }

  async *execute(connection: AgentLoopSidecarConnection): AsyncGenerator<AgentEvent, SidecarTerminal, unknown> {
    const removeAbortListener = this.linkCancellation();
    let executeStarted = false;
    let terminalObserved = false;
    let phase: "hello" | "capabilities" | "resume" | "execute" = "hello";
    let reconnecting = false;
    this.connection = connection;
    try {
      await this.send(this.handshakeRequest("hello"));
      let iterator = connection.receive()[Symbol.asyncIterator]();
      while (true) {
        let next: IteratorResult<unknown>;
        try {
          next = await iterator.next();
        } catch (error) {
          const replacement = await this.reconnect();
          if (!replacement) throw error;
          reconnecting = true;
          phase = "hello";
          iterator = replacement.receive()[Symbol.asyncIterator]();
          await this.send(this.handshakeRequest("hello"));
          continue;
        }
        if (next.done) {
          const replacement = await this.reconnect();
          if (!replacement) throw new Error("Sidecar connection closed before execute reached a terminal event.");
          reconnecting = true;
          phase = "hello";
          iterator = replacement.receive()[Symbol.asyncIterator]();
          await this.send(this.handshakeRequest("hello"));
          continue;
        }
        const rawMessage = next.value;
        const validation = validateModuleMessage(rawMessage);
        if (!validation.ok) throw new Error(`Invalid sidecar message: ${validation.code}: ${validation.message}`);
        const message = rawMessage as ModuleMessage;
        if (isModuleCall(message)) {
          if (phase !== "execute") throw new Error("Sidecar issued module_call before handshake completed.");
          const replacement = await this.sendModuleResponse(message);
          if (replacement) {
            reconnecting = true;
            phase = "hello";
            iterator = replacement.receive()[Symbol.asyncIterator]();
            await this.send(this.handshakeRequest("hello"));
          }
          continue;
        }
        if (message.kind === "response") {
          if (phase === "hello" || phase === "capabilities") {
            this.acceptHandshakeResponse(message, phase);
            if (phase === "hello") {
              phase = "capabilities";
              await this.send(this.handshakeRequest("capabilities"));
            } else if (reconnecting) {
              reconnecting = false;
              phase = "resume";
              await this.send(this.resumeRequest());
            } else {
              phase = "execute";
              if (this.options.input.abortSignal?.aborted) return abortedResult(this.options.input);
              await this.options.operationLedger?.start(this.operationIdentity());
              await this.send(this.executeRequest());
              executeStarted = true;
            }
            continue;
          }
          if (phase === "resume") {
            this.acceptResumeResponse(message);
            phase = "execute";
            continue;
          }
          const terminal = await this.acceptResponse(message);
          if (terminal) {
            const hostTerminal = this.withHostToolCheckpoint(terminal);
            await this.recordKnownTerminal(hostTerminal, "failed");
            terminalObserved = true;
            yield {
              type: "turn_completed",
              sessionId: this.options.input.sessionId,
              turnId: this.options.input.turnId,
              result: hostTerminal.result,
            };
            return hostTerminal;
          }
          continue;
        }
        if (message.kind === "error") {
          throw new Error(`Sidecar transport error ${message.code}: ${message.message}`);
        }
        if (message.kind !== "event") continue;
        if (phase !== "execute") throw new Error("Sidecar emitted an event before handshake completed.");
        this.assertEventIdentity(message);
        if (message.final) {
          const terminal = message.outcome === "result_unknown"
            ? await this.reconcileResultUnknown(message)
            : this.withHostToolCheckpoint(readTerminal(message, this.options.input));
          if (isResolvedModuleOutcome(message.outcome)) {
            await this.recordKnownTerminal(terminal, message.outcome);
          }
          terminalObserved = true;
          // Module final is the authoritative terminal. Suppress a preceding
          // sidecar turn_completed event and publish exactly this validated one.
          yield {
            type: "turn_completed",
            sessionId: this.options.input.sessionId,
            turnId: this.options.input.turnId,
            result: terminal.result,
          };
          return terminal;
        }
        const event = readAgentEvent(message, this.options.input);
        if (event.type !== "turn_completed") {
          yield event;
          this.sendAckIfReady();
        }
      }
    } catch (error) {
      this.observeReconnectFailure();
      if (executeStarted && !terminalObserved && this.streamId) {
        try {
          const terminal = await this.reconcileTransportInterruption(
            error,
            this.resultUnknownSource ?? "transport_interruption",
          );
          terminalObserved = true;
          yield {
            type: "turn_completed",
            sessionId: this.options.input.sessionId,
            turnId: this.options.input.turnId,
            result: terminal.result,
          };
          return terminal;
        } catch {
          // Preserve the original transport error. A failed status query or
          // durable write must not be mistaken for a business terminal.
          this.observe({
            type: "result_unknown_fail_closed",
            source: this.resultUnknownSource ?? "transport_interruption",
          });
        }
      }
      throw error;
    } finally {
      removeAbortListener();
    }
  }

  private handshakeRequest(method: "hello" | "capabilities"): ModuleHandshakeRequest {
    const initial = this.reconnectAttempts === 0;
    const messageId = initial
      ? method === "hello" ? this.helloMessageId : this.capabilitiesMessageId
      : `${method}-${this.options.uuid()}`;
    if (!initial) {
      if (method === "hello") this.helloMessageId = messageId;
      else this.capabilitiesMessageId = messageId;
    }
    return {
      kind: "request",
      messageId,
      method,
      payload: {},
    };
  }

  private executeRequest(): ModuleExecuteRequest {
    const { config, capabilities, input, seedState } = this.options;
    const permissionContext = effectivePermissionContext(config, input);
    return {
      kind: "request",
      messageId: this.executeMessageId,
      method: "execute",
      runId: this.runId,
      operationId: this.operationId,
      requestId: this.requestId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.execution?.idempotencyKey ? { idempotencyKey: input.execution.idempotencyKey } : {}),
      ...(input.execution?.operationDeadline ? { operationDeadline: input.execution.operationDeadline } : {}),
      payload: {
        agent: serializeAgentConfig(config),
        messages: input.messages,
        ...(input.basePermissionMode !== undefined ? { basePermissionMode: input.basePermissionMode } : {}),
        ...(input.allowPlanModeTools !== undefined ? { allowPlanModeTools: input.allowPlanModeTools } : {}),
        tools: capabilities.toolExecution.list().map(serializeToolDescriptor),
        permissionContext,
        hostModules: hostModuleCapabilities(capabilities),
        ...(seedState ? { seedState: serializeAgentLoopSeedStateProjection(seedState) } : {}),
      },
    };
  }

  private async acceptResponse(message: ModuleResponse): Promise<SidecarTerminal | undefined> {
    if (message.inReplyTo !== this.executeMessageId) return;
    if (message.requestId !== this.requestId) {
      throw new Error("Sidecar execute response does not match the active request.");
    }
    if (!message.ok) {
      if (message.final === true && message.outcome === "failed") {
        return rejectedExecuteTerminal(message, this.options.input);
      }
      throw new Error(`Sidecar rejected execute request: ${message.code ?? message.error?.message ?? "unknown error"}`);
    }
    if (message.final === true) {
      throw new Error("Sidecar streaming execute response cannot be final when accepted.");
    }
    if (!message.streamId) throw new Error("Sidecar execute response did not provide streamId.");
    this.streamId = message.streamId;
    await this.options.operationLedger?.accept(this.acceptedOperation());
    this.observe({ type: "stream_accepted", resumeSupported: this.supportsResume });
    this.sendCancelIfReady();
  }

  private acceptHandshakeResponse(message: ModuleResponse, phase: "hello" | "capabilities"): void {
    const expectedId = phase === "hello" ? this.helloMessageId : this.capabilitiesMessageId;
    if (message.inReplyTo !== expectedId) {
      throw new Error(`Sidecar ${phase} response does not match the active handshake request.`);
    }
    if (!message.ok) {
      throw new Error(`Sidecar rejected ${phase}: ${message.code ?? message.error?.message ?? "unknown error"}`);
    }
    const binding = parseBinding(message);
    if (phase === "hello") {
      if (this.binding) {
        if (this.binding.moduleId !== binding.moduleId) {
          throw new Error("Sidecar changed its module identity while resuming a stream.");
        }
        if (this.binding.moduleInstanceId !== binding.moduleInstanceId) {
          this.observe({ type: "sidecar_instance_restarted" });
          throw new SidecarInstanceRestartedError();
        }
      } else {
        this.binding = binding;
      }
      this.connectionBinding = binding;
      return;
    }
    if (!this.connectionBinding || !sameBinding(this.connectionBinding, binding)) {
      throw new Error("Sidecar changed its binding during handshake.");
    }
    const capabilities = parseCapabilities(message, binding.capabilitiesVersion);
    const execute = capabilities.methods.find((method) => method.name === "execute");
    if (!execute || execute.enabled === false || !execute.profiles?.includes("streaming")) {
      throw new Error("Sidecar does not advertise a streaming execute capability.");
    }
    this.supportsCancel = capabilities.methods.some((method) => method.name === "cancel" && method.enabled !== false)
      || execute.cancel === true;
    this.supportsResume = execute.resumeSupport === "streaming"
      && capabilities.methods.some((method) => method.name === "resume" && method.enabled !== false)
      && capabilities.methods.some((method) => method.name === "ack" && method.enabled !== false);
  }

  private resumeRequest(): Extract<ModuleMessage, { kind: "request"; method: "resume" }> {
    if (!this.streamId || !this.pendingResumeBinding) {
      throw new Error("Sidecar reconnect has no accepted stream binding.");
    }
    this.resumeMessageId = `resume-${this.options.uuid()}`;
    return {
      kind: "request",
      messageId: this.resumeMessageId,
      method: "resume",
      streamId: this.streamId,
      previousBinding: this.pendingResumeBinding,
      lastAppliedSequence: this.nextSequence - 1,
    };
  }

  private acceptResumeResponse(message: ModuleResponse): void {
    if (!this.resumeMessageId || message.inReplyTo !== this.resumeMessageId) {
      throw new Error("Sidecar resume response does not match the active resume request.");
    }
    if (!message.ok) {
      throw new Error(`Sidecar resume failed: ${message.code ?? message.error?.message ?? "unknown error"}`);
    }
    if (message.streamId !== undefined && message.streamId !== this.streamId) {
      throw new Error("Sidecar resume response changed the stream identity.");
    }
    this.pendingResumeBinding = undefined;
    this.resumeMessageId = undefined;
    this.reconnectSucceeded = true;
    this.observe({ type: "reconnect_succeeded", attempt: this.reconnectAttempts });
  }

  private assertEventIdentity(event: ModuleEvent): void {
    if (!this.streamId) throw new Error("Sidecar emitted an event before accepting execute.");
    if (
      event.streamId !== this.streamId
      || event.runId !== this.runId
      || event.operationId !== this.operationId
      || event.requestId !== this.requestId
    ) {
      throw new Error("Sidecar event identity does not match the active execution.");
    }
    if (event.sequence !== this.nextSequence) {
      throw new Error(`Sidecar event sequence mismatch: expected ${this.nextSequence}, got ${event.sequence}.`);
    }
    this.nextSequence += 1;
  }

  private async reconnect(): Promise<AgentLoopSidecarConnection | undefined> {
    const connection = this.connection;
    const previousBinding = this.connectionBinding;
    if (
      !connection?.reconnect
      || !this.streamId
      || !previousBinding
      || !this.supportsResume
      || this.reconnectAttempts >= 1
    ) return undefined;
    this.reconnectAttempts += 1;
    const lastAppliedSequence = this.nextSequence - 1;
    this.observe({ type: "reconnect_started", attempt: this.reconnectAttempts, lastAppliedSequence });
    let replacement: AgentLoopSidecarConnection;
    try {
      replacement = await connection.reconnect({
        streamId: this.streamId,
        previousBinding: {
          moduleInstanceId: previousBinding.moduleInstanceId,
          connectionGeneration: previousBinding.connectionGeneration,
        },
        lastAppliedSequence,
      });
    } catch (error) {
      this.observeReconnectFailure();
      throw error;
    }
    this.pendingResumeBinding = {
      moduleInstanceId: previousBinding.moduleInstanceId,
      connectionGeneration: previousBinding.connectionGeneration,
    };
    this.connection = replacement;
    this.connectionBinding = undefined;
    return replacement;
  }

  private linkCancellation(): () => void {
    const signal = this.options.input.abortSignal;
    if (!signal) return () => undefined;
    const requestCancel = () => {
      this.cancelRequested = true;
      this.sendCancelIfReady();
    };
    if (signal.aborted) requestCancel();
    else signal.addEventListener("abort", requestCancel, { once: true });
    return () => signal.removeEventListener("abort", requestCancel);
  }

  private sendCancelIfReady(): void {
    if (!this.cancelRequested || this.cancelSent || !this.streamId || !this.supportsCancel) return;
    this.cancelSent = true;
    void Promise.resolve(this.send({
      kind: "request",
      messageId: `cancel-${this.options.uuid()}`,
      method: "cancel",
      runId: this.runId,
      operationId: this.operationId,
      requestId: this.requestId,
      reason: "host_abort",
    })).catch(() => undefined);
  }

  private sendAckIfReady(): void {
    if (!this.supportsResume || !this.streamId || this.nextSequence <= 0) return;
    void Promise.resolve(this.send({
      kind: "request",
      messageId: `ack-${this.options.uuid()}`,
      method: "ack",
      streamId: this.streamId,
      lastAppliedSequence: this.nextSequence - 1,
    })).catch(() => undefined);
  }

  private send(message: ModuleMessage): void | Promise<void> {
    if (!this.connection) throw new Error("Sidecar transport connection is unavailable.");
    return this.connection.send(message);
  }

  async close(reason?: unknown): Promise<void> {
    await this.connection?.close?.(reason);
  }

  private async reconcileResultUnknown(event: ModuleEvent): Promise<SidecarTerminal> {
    if (!this.streamId || !this.binding) {
      throw new Error("Sidecar terminal outcome is result_unknown; host reconciliation is required.");
    }
    const unknown: AgentLoopOperationUnknownTerminal = {
      ...this.acceptedOperation(),
      lastAppliedSequence: this.nextSequence - 1,
      ...(event.code ? { code: event.code } : {}),
      ...(event.error === undefined ? {} : { error: event.error }),
    };
    this.resultUnknownSource = "sidecar_final";
    return this.reconcileUnknownTerminal(unknown, this.resultUnknownSource);
  }

  /**
   * A dead connection or a new instance cannot prove an AgentLoop terminal.
   * Record that fact first, then let the host's durable ledger or side-effect
   * status provider decide whether a terminal is safe to publish.
   */
  private async reconcileTransportInterruption(
    error: unknown,
    source: "sidecar_final" | "transport_interruption" = "transport_interruption",
  ): Promise<SidecarTerminal> {
    if (!this.streamId || !this.binding) {
      throw new Error("Sidecar transport interrupted before an accepted stream could be reconciled.");
    }
    return this.reconcileUnknownTerminal({
      ...this.acceptedOperation(),
      lastAppliedSequence: this.nextSequence - 1,
      code: error instanceof SidecarInstanceRestartedError
        ? "SIDECAR_INSTANCE_RESTARTED"
        : "TRANSPORT_INTERRUPTED",
      error: serializeTransportError(error),
    }, source);
  }

  private async reconcileUnknownTerminal(
    unknown: AgentLoopOperationUnknownTerminal,
    source: "sidecar_final" | "transport_interruption",
  ): Promise<SidecarTerminal> {
    await this.options.operationLedger?.resultUnknown(unknown);
    const ledgerResolution = await this.options.operationLedger?.reconcile(unknown);
    const resolution = ledgerResolution ?? await this.options.reconcileResultUnknown?.(unknown);
    if (!resolution) {
      throw new Error("Sidecar terminal outcome is result_unknown and host reconciliation found no final result.");
    }
    const terminal = readResolvedTerminal(resolution, this.options.input);
    // A successful external status query becomes the new durable source of
    // truth. Without this write, a later session recovery would see only the
    // result_unknown observation and repeat reconciliation indefinitely.
    await this.recordKnownTerminal(terminal, resolution.outcome);
    this.observe({ type: "result_unknown_resolved", source, outcome: resolution.outcome });
    return terminal;
  }

  private withHostToolCheckpoint(terminal: SidecarTerminal): SidecarTerminal {
    return { ...terminal, seedState: this.hostToolCheckpoint.snapshot() };
  }

  private operationIdentity(): AgentLoopOperationIdentity {
    if (!this.binding) throw new Error("Sidecar execute started without a handshake binding.");
    return {
      runId: this.runId,
      operationId: this.operationId,
      requestId: this.requestId,
      sessionId: this.options.input.sessionId,
      turnId: this.options.input.turnId,
      binding: {
        moduleInstanceId: this.binding.moduleInstanceId,
        connectionGeneration: this.binding.connectionGeneration,
      },
      ...(this.options.input.execution?.idempotencyKey
        ? { idempotencyKey: this.options.input.execution.idempotencyKey }
        : {}),
    };
  }

  private acceptedOperation(): AgentLoopOperationAccepted {
    if (!this.streamId) throw new Error("Sidecar operation has no accepted stream identity.");
    return { ...this.operationIdentity(), streamId: this.streamId };
  }

  private async recordKnownTerminal(
    terminal: SidecarTerminal,
    outcome: Exclude<ModuleOutcome, "result_unknown">,
  ): Promise<void> {
    await this.options.operationLedger?.terminal({
      ...this.operationIdentity(),
      ...(this.streamId ? { streamId: this.streamId } : {}),
      lastAppliedSequence: this.nextSequence - 1,
      outcome,
      result: terminal.result,
      messages: terminal.messages,
      ...(terminal.seedState ? { seedState: terminal.seedState } : {}),
    });
  }

  private async dispatchModuleCall(call: ModuleCallRequest): Promise<ModuleResponse> {
    try {
      this.assertModuleCallIdentity(call);
      const payload = await this.dispatchModule(call);
      return moduleResponse(call, this.options.uuid, true, payload);
    } catch (error) {
      return moduleResponse(call, this.options.uuid, false, undefined, error);
    }
  }

  /**
   * A host module may have completed a permission or a non-idempotent tool
   * operation just as its response loses the socket. Reconnect first and wait
   * for the server to replay the immutable request; never dispatch it twice.
   */
  private async sendModuleResponse(call: ModuleCallRequest): Promise<AgentLoopSidecarConnection | undefined> {
    const { response, replayed } = await this.moduleResponseFor(call);
    try {
      await this.send(response);
      if (replayed) {
        this.observe({ type: "cached_module_response_replayed", module: call.module });
      }
      return undefined;
    } catch (error) {
      const replacement = await this.reconnect();
      if (!replacement) throw error;
      return replacement;
    }
  }

  private async moduleResponseFor(call: ModuleCallRequest): Promise<{
    response: ModuleResponse;
    replayed: boolean;
  }> {
    const cached = this.completedModuleResponses.get(call.messageId);
    if (cached) {
      this.assertModuleCallIdentity(call);
      if (!sameModuleCall(cached.call, call)) {
        throw new Error("Sidecar replayed a module_call with a conflicting immutable identity.");
      }
      this.observe({ type: "pending_module_call_replayed", module: call.module });
      return { response: cached.response, replayed: true };
    }
    const response = await this.dispatchModuleCall(call);
    // Cache before delivery: a failed response write must never repeat the
    // permission/tool operation when this live sidecar stream resumes.
    this.completedModuleResponses.set(call.messageId, { call, response });
    return { response, replayed: false };
  }

  private observe(observation: AgentLoopSidecarTransportObservation): void {
    try {
      void Promise.resolve(this.options.transportObserver?.observe(observation)).catch(() => undefined);
    } catch {
      // Deployment telemetry is not part of the AgentLoop or host terminal.
    }
  }

  private observeReconnectFailure(): void {
    if (this.reconnectAttempts === 0 || this.reconnectSucceeded || this.reconnectFailureObserved) return;
    this.reconnectFailureObserved = true;
    this.observe({ type: "reconnect_failed", attempt: this.reconnectAttempts });
  }

  private assertModuleCallIdentity(call: ModuleCallRequest): void {
    if (call.runId !== this.runId || call.operationId !== this.operationId) {
      throw new Error("Sidecar module call identity does not match the active execution.");
    }
  }

  private async dispatchModule(call: ModuleCallRequest): Promise<Record<string, unknown>> {
    const handler = this.handlers[call.module as keyof SidecarModuleHandlers];
    if (!handler) throw new Error(`Unsupported sidecar host module: ${call.module}`);
    return handler(call);
  }

  private async dispatchModel(call: ModuleCallRequest): Promise<Record<string, unknown>> {
    const operation = stringField(call.payload, "operation");
    const preparationId = stringField(call.payload, "preparationId");
    const context = modelExecutionContext(call, this.options.input, this.options.config, this.options.input.abortSignal);
    if (operation === "prepare") {
      const request = canonicalModelRequest(call.payload.request);
      const prepared = await this.options.capabilities.model.execution.prepare({ request, context });
      this.modelPreparations.set(preparationId, prepared);
      return { prepared: serializablePreparedInvocation(prepared) };
    }
    if (operation === "stream") {
      const prepared = this.modelPreparations.get(preparationId);
      if (!prepared) throw new Error(`Unknown sidecar model preparation: ${preparationId}`);
      const events: CanonicalModelEvent[] = [];
      for await (const event of this.options.capabilities.model.execution.stream({ prepared, context })) events.push(event);
      return { events };
    }
    throw new Error(`Unsupported sidecar model operation: ${operation}`);
  }

  private async dispatchCapability(call: ModuleCallRequest): Promise<Record<string, unknown>> {
    const operation = stringField(call.payload, "operation");
    if (operation === "plan_todo") return this.planTodoHandler(call);
    const planTodo = this.options.capabilities.planMode.planTodoManager?.forSession(this.options.input.sessionId);
    const context = toolRuntimeContext(
      call.payload.context,
      this.options.config,
      this.options.input,
      this.options.capabilities,
      this.hostToolCheckpoint,
      planTodo,
      true,
    );
    const execution = toolExecutionContext(call, this.options.input);
    if (operation === "execute_batch") {
      const calls = Array.isArray(call.payload.calls)
        ? call.payload.calls.map(parseToolCall)
        : (() => { throw new Error("Capability batch call must contain calls."); })();
      const results = await this.options.capabilities.toolExecution.executeAll(calls, context, execution);
      if (results.length !== calls.length) throw new Error("Capability port returned an incomplete batch result.");
      this.options.permissionMode.applyCapabilityResults(results);
      return { results };
    }
    if (operation === "execute") {
      const callInput = parseToolCall({
        toolCallId: call.payload.toolCallId,
        name: call.payload.name,
        arguments: call.payload.arguments,
      });
      const [result] = await this.options.capabilities.toolExecution.executeAll([callInput], context, execution);
      if (!result) throw new Error("Capability port returned no result.");
      this.options.permissionMode.applyCapabilityResults([result]);
      return result as unknown as Record<string, unknown>;
    }
    throw new Error(`Unsupported sidecar capability operation: ${operation}`);
  }

  private async dispatchPermission(call: ModuleCallRequest): Promise<Record<string, unknown>> {
    if (stringField(call.payload, "operation") !== "decide") {
      throw new Error("Unsupported sidecar permission operation.");
    }
    const permission = this.options.capabilities.permission;
    if (!permission) throw new Error("Host did not provide a permission capability.");
    const toolName = stringField(asRecord(call.payload.tool), "name");
    const tool = this.options.capabilities.toolExecution.list().find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Permission request references unavailable tool: ${toolName}`);
    const decision = await permission.decide(
      tool,
      call.payload.input,
      toolRuntimeContext(
        call.payload.context,
        this.options.config,
        this.options.input,
        this.options.capabilities,
        this.hostToolCheckpoint,
      ),
      stringField(call.payload, "toolCallId"),
    );
    return { decision };
  }

  private async dispatchContext(call: ModuleCallRequest): Promise<Record<string, unknown>> {
    const operation = stringField(call.payload, "operation");
    const input = withContextIdentity(asRecord(call.payload.input), this.options.input, this.options.config);
    // Before routing, the sidecar has no model-specific window to serialize.
    // The host owns the configured default; a later routed value remains an
    // explicit, narrower per-call override.
    if (
      operation === "try_auto_compact"
      && input.maxContextTokens === undefined
      && this.options.config.maxContextTokens !== undefined
    ) {
      input.maxContextTokens = this.options.config.maxContextTokens;
    }
    if (operation === "prepare_for_model") return { result: await this.options.capabilities.contextPreparation.prepareForModel(input as never) };
    if (operation === "apply_tool_results" && this.options.capabilities.contextToolResults) {
      return { result: await this.options.capabilities.contextToolResults.applyToolResults(input as never) };
    }
    if (operation === "recover_from_model_error" && this.options.capabilities.contextRecovery) {
      return { result: await this.options.capabilities.contextRecovery.recoverFromModelError(input as never) };
    }
    if (operation === "capture_turn" && this.options.capabilities.contextCapture) {
      await this.options.capabilities.contextCapture.captureTurn(input as never);
      return { result: null };
    }
    if (operation === "try_auto_compact" && this.options.capabilities.contextCompaction) {
      return { result: await this.options.capabilities.contextCompaction.tryAutoCompact(input as never) };
    }
    throw new Error(`Host context capability does not support ${operation}.`);
  }

  private async dispatchLifecycle(call: ModuleCallRequest): Promise<Record<string, unknown>> {
    const lifecycle = this.options.capabilities.hooks.lifecycle;
    if (!lifecycle) throw new Error("Host did not provide a lifecycle capability.");
    if (stringField(call.payload, "operation") !== "dispatch") {
      throw new Error("Unsupported sidecar lifecycle operation.");
    }
    const event = stringField(call.payload, "event");
    if (!isPilotDeckHookEvent(event)) throw new Error(`Unsupported sidecar lifecycle event: ${event}`);
    const payload = call.payload.payload === undefined
      ? undefined
      : asRecord(call.payload.payload) ?? (() => { throw new Error("Lifecycle payload must be an object."); })();
    const input = this.options.input;
    const config = this.options.config;
    const result = await lifecycle.dispatch({
      event,
      baseInput: {
        sessionId: input.sessionId,
        transcriptPath: "",
        cwd: config.cwd,
        permissionMode: config.permissionMode,
      },
      ...(payload ? { payload } : {}),
      matchQuery: event,
      ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      env: buildTurnEnvironment(config.env, config.cwd, input.sessionId, input.turnId),
    });
    return { result: serializeLifecycleDispatchResult(result) };
  }

  private async dispatchEvent(call: ModuleCallRequest): Promise<Record<string, unknown>> {
    if (stringField(call.payload, "operation") !== "emit") {
      throw new Error("Unsupported sidecar event operation.");
    }
    const event = readHostEmittedEvent(call.payload.event, this.options.input);
    this.options.capabilities.events.emit?.(event);
    return { result: null };
  }
}

function isModuleCall(message: ModuleMessage): message is ModuleCallRequest {
  return message.kind === "request" && message.method === "module_call";
}

/** Replayed module calls must be byte-for-byte equivalent protocol facts. */
function sameModuleCall(left: ModuleCallRequest, right: ModuleCallRequest): boolean {
  return left.messageId === right.messageId
    && left.runId === right.runId
    && left.operationId === right.operationId
    && left.requestId === right.requestId
    && left.idempotencyKey === right.idempotencyKey
    && left.module === right.module
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

function parseBinding(message: ModuleResponse): SidecarBinding {
  if (message.protocolVersion !== MODULE_PROTOCOL_VERSION) {
    throw new Error(`Sidecar protocol version is unsupported: ${message.protocolVersion ?? "missing"}.`);
  }
  const moduleId = nonEmptyResponseField(message.moduleId, "moduleId");
  const moduleInstanceId = nonEmptyResponseField(message.moduleInstanceId, "moduleInstanceId");
  const connectionGeneration = nonEmptyResponseField(message.connectionGeneration, "connectionGeneration");
  const capabilitiesVersion = nonEmptyResponseField(message.capabilitiesVersion, "capabilitiesVersion");
  return { moduleId, moduleInstanceId, connectionGeneration, capabilitiesVersion };
}

function parseCapabilities(message: ModuleResponse, expectedVersion: string): ModuleCapabilities {
  const payload = asRecord(message.payload);
  if (!payload || payload.capabilitiesVersion !== expectedVersion || !Array.isArray(payload.methods)) {
    throw new Error("Sidecar capabilities response does not match its hello binding.");
  }
  for (const method of payload.methods) {
    const entry = asRecord(method);
    if (!entry || !isCapabilityMethodName(entry.name)) {
      throw new Error("Sidecar capabilities response contains an invalid method.");
    }
  }
  return payload as unknown as ModuleCapabilities;
}

function sameBinding(left: SidecarBinding, right: SidecarBinding): boolean {
  return left.moduleId === right.moduleId
    && left.moduleInstanceId === right.moduleInstanceId
    && left.connectionGeneration === right.connectionGeneration
    && left.capabilitiesVersion === right.capabilitiesVersion;
}

function nonEmptyResponseField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Sidecar handshake response is missing ${name}.`);
  }
  return value;
}

function isCapabilityMethodName(value: unknown): value is ModuleCapabilities["methods"][number]["name"] {
  return value === "execute" || value === "cancel" || value === "status" || value === "resume" || value === "ack";
}

function moduleResponse(
  call: ModuleCallRequest,
  uuid: () => string,
  ok: boolean,
  payload?: Record<string, unknown>,
  error?: unknown,
): ModuleResponse {
  if (ok) {
    return {
      kind: "response",
      messageId: `host-module-${uuid()}`,
      inReplyTo: call.messageId,
      requestId: call.requestId,
      ok: true,
      ...(payload ? { payload } : {}),
    };
  }
  return {
    kind: "response",
    messageId: `host-module-${uuid()}`,
    inReplyTo: call.messageId,
    requestId: call.requestId,
    ok: false,
    code: "HOST_MODULE_FAILED",
    error: { message: error instanceof Error ? error.message : String(error) },
  };
}

function hostModuleCapabilities(capabilities: AgentTurnCapabilities): Record<string, unknown> {
  const contextMethods = !isNoopAgentTurnContextPort(capabilities.context)
    ? [
        "prepare_for_model",
        ...(capabilities.contextToolResults ? ["apply_tool_results"] : []),
        ...(capabilities.contextRecovery ? ["recover_from_model_error"] : []),
        ...(capabilities.contextCapture ? ["capture_turn"] : []),
        ...(capabilities.contextCompaction ? ["try_auto_compact"] : []),
      ]
    : [];
  return {
    model: { methods: ["prepare", "stream"] },
    capability: {
      methods: [
        "execute",
        "execute_batch",
        ...(capabilities.planMode.planTodoManager ? ["plan_todo"] : []),
      ],
    },
    ...(contextMethods.length > 0 ? { context: { methods: contextMethods } } : {}),
    ...(capabilities.permission ? { permission: { methods: ["decide"] } } : {}),
    ...(capabilities.hooks.lifecycle ? { lifecycle: { methods: ["dispatch"] } } : {}),
    ...(capabilities.events.emit ? { event: { methods: ["emit"] } } : {}),
  };
}

function serializeAgentConfig(config: AgentRuntimeConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    model: config.model,
    cwd: config.cwd,
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.runtimeContextSurface ? { runtimeContextSurface: config.runtimeContextSurface } : {}),
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(config.maxContextTokens ? { maxContextTokens: config.maxContextTokens } : {}),
    ...(config.runMode ? { runMode: config.runMode } : {}),
    ...(config.isSubagent !== undefined ? { isSubagent: config.isSubagent } : {}),
    ...(config.subagentModel ? { subagentModel: config.subagentModel } : {}),
  };
}

function serializeToolDescriptor(tool: PilotDeckToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
    inputSchema: tool.inputSchema,
    readOnly: safely(() => tool.isReadOnly({}), false),
    concurrencySafe: safely(() => tool.isConcurrencySafe({}), false),
    requiresUserInteraction: safely(() => tool.requiresUserInteraction?.({}) ?? false, false),
    ...(tool.requiredRuntimeCapabilities ? { requiredRuntimeCapabilities: [...tool.requiredRuntimeCapabilities] } : {}),
  };
}

function effectivePermissionContext(config: AgentRuntimeConfig, input: AgentLoopInput): PermissionContext {
  const rules: PermissionRuleSet = {
    allow: input.permissionRules?.allow ?? config.permissionContext.rules.allow,
    deny: input.permissionRules?.deny ?? config.permissionContext.rules.deny,
    ask: input.permissionRules?.ask ?? config.permissionContext.rules.ask,
  };
  return {
    ...config.permissionContext,
    // Native AgentLoop always evaluates permission policy in the actual tool
    // workspace. Keep host module callbacks on that same canonical cwd.
    cwd: config.cwd,
    mode: config.permissionMode,
    canPrompt: input.canPrompt ?? config.permissionContext.canPrompt,
    rules,
  };
}

function modelExecutionContext(
  call: ModuleCallRequest,
  input: AgentLoopInput,
  config: AgentRuntimeConfig,
  abortSignal?: AbortSignal,
): ModelExecutionContext {
  const remote = asRecord(call.payload.context);
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: call.runId,
    operationId: call.operationId,
    ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
    ...(input.execution?.operationDeadline ? { operationDeadline: input.execution.operationDeadline } : {}),
    ...(abortSignal ? { abortSignal } : {}),
    ...(modelOverride(remote?.modelOverride) ? { modelOverride: modelOverride(remote?.modelOverride) } : {}),
    ...(asRecord(remote?.metadata) ? { metadata: asRecord(remote?.metadata) } : {}),
  };
}

function toolRuntimeContext(
  value: unknown,
  config: AgentRuntimeConfig,
  input: AgentLoopInput,
  capabilities: AgentTurnCapabilities,
  checkpoint: HostToolCheckpoint,
  planTodo?: PilotDeckPlanTodoStateHandle,
  includeOneShotSubagent = false,
): PilotDeckToolRuntimeContext {
  const remote = asRecord(value);
  const planDirectoryPath = capabilities.planMode.planFileManager?.getPlanDirectoryPath();
  const fileState = checkpoint.toolContextState();
  // Sidecar composition accepts an explicitly injected auxiliary provider only.
  // Router-backed fallback remains available exclusively through native legacy
  // composition, so this process can run without any Router implementation.
  const auxiliaryModel = capabilities.model.auxiliary;
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    messageId: input.turnId,
    cwd: config.cwd,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(config.subagentTimeoutMs ? { subagentTimeoutMs: config.subagentTimeoutMs } : {}),
    ...(typeof remote?.currentToolCallId === "string" ? { currentToolCallId: remote.currentToolCallId } : {}),
    ...(config.toolAliases ? { toolAliases: config.toolAliases } : {}),
    permissionMode: config.permissionMode,
    permissionContext: {
      ...effectivePermissionContext(config, input),
      ...(planDirectoryPath ? { planDirectoryPath } : {}),
    },
    runMode: config.runMode ?? "agent",
    ...(capabilities.toolExecution.auditRecorder ? { auditRecorder: capabilities.toolExecution.auditRecorder } : {}),
    ...(capabilities.clock.now ? { now: capabilities.clock.now } : {}),
    env: buildTurnEnvironment(config.env, config.cwd, input.sessionId, input.turnId),
    ...(config.maxResultBytes ? { maxResultBytes: config.maxResultBytes } : {}),
    ...(auxiliaryModel ? { model: auxiliaryModel } : {}),
    ...(capabilities.interaction.elicitation ? { elicitation: capabilities.interaction.elicitation } : {}),
    ...(capabilities.toolExecution.fileHistory ? { fileHistory: capabilities.toolExecution.fileHistory } : {}),
    ...(config.subagentDepth !== undefined ? { subagentDepth: config.subagentDepth } : {}),
    ...(includeOneShotSubagent && capabilities.subagent.oneShot
      ? {
          subagent: capabilities.subagent.oneShot.createForkApi({
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
    ...(capabilities.toolExecution.fileUpdateNotifier ? { fileUpdateNotifier: capabilities.toolExecution.fileUpdateNotifier } : {}),
    ...(planTodo ? { planTodo } : {}),
    ...(capabilities.goal ? { goal: capabilities.goal.forSession(input.sessionId) } : {}),
    ...(planDirectoryPath
      ? {
          planDirectory: {
            path: planDirectoryPath,
            resolve: (filePath: string) => capabilities.planMode.planFileManager?.resolvePlanFilePath(filePath, config.cwd),
            read: (filePath: string) => capabilities.planMode.planFileManager?.readPlanFile(filePath, config.cwd),
          },
        }
      : {}),
  };
}

function toolExecutionContext(call: ModuleCallRequest, input: AgentLoopInput): AgentExecutionContext {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: call.runId,
    operationId: call.operationId,
    ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
    ...(input.execution?.operationDeadline ? { operationDeadline: input.execution.operationDeadline } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };
}

function withContextIdentity(
  source: Record<string, unknown> | undefined,
  input: AgentLoopInput,
  config: AgentRuntimeConfig,
): Record<string, unknown> {
  return {
    ...(source ?? {}),
    sessionId: input.sessionId,
    turnId: input.turnId,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    runMode: config.runMode ?? "agent",
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };
}

function parseToolCall(value: unknown): PilotDeckToolCall {
  const record = asRecord(value);
  const id = stringField(record, "toolCallId");
  const name = stringField(record, "name");
  return { id, name, input: record?.arguments ?? {} };
}

function canonicalModelRequest(value: unknown): CanonicalModelRequest {
  const request = asRecord(value);
  if (!request || typeof request.provider !== "string" || typeof request.model !== "string" || !Array.isArray(request.messages)) {
    throw new Error("Sidecar model call contains an invalid canonical request.");
  }
  return request as unknown as CanonicalModelRequest;
}

function serializablePreparedInvocation(prepared: PreparedModelInvocation): Record<string, unknown> {
  return {
    request: prepared.request,
    provider: prepared.provider,
    model: prepared.model,
    ...(prepared.maxContextTokens ? { maxContextTokens: prepared.maxContextTokens } : {}),
    ...(prepared.maxOutputTokens ? { maxOutputTokens: prepared.maxOutputTokens } : {}),
  };
}

function readAgentEvent(event: ModuleEvent, input: AgentLoopInput): AgentEvent {
  const value = asRecord(event.payload);
  if (!value || typeof value.type !== "string") throw new Error("Sidecar event payload is not an AgentEvent.");
  if (value.sessionId !== input.sessionId || ("turnId" in value && value.turnId !== input.turnId)) {
    throw new Error("Sidecar AgentEvent does not match the active session or turn.");
  }
  return value as unknown as AgentEvent;
}

function readHostEmittedEvent(value: unknown, input: AgentLoopInput): AgentEvent {
  const event = asRecord(value);
  if (!event || typeof event.type !== "string" || event.sessionId !== input.sessionId) {
    throw new Error("Sidecar host event does not match the active session.");
  }
  if ("turnId" in event && event.turnId !== input.turnId) {
    throw new Error("Sidecar host event does not match the active turn.");
  }
  return event as unknown as AgentEvent;
}

function readTerminal(event: ModuleEvent, input: AgentLoopInput): SidecarTerminal {
  const payload = asRecord(event.payload);
  const result = payload?.result;
  const messages = payload?.messages;
  if (!isAgentTurnResult(result) || !Array.isArray(messages)) {
    throw new Error("Sidecar terminal payload does not contain an AgentLoop result.");
  }
  assertTerminalResult(event.outcome, result, input);
  return {
    result,
    messages: messages as CanonicalMessage[],
    ...(payload?.seedState === undefined ? {} : { seedState: parseAgentLoopSeedStateProjection(payload.seedState) }),
  };
}

/**
 * A deadline can expire before a streaming execute is accepted, so the
 * protocol has no stream identity or final event to project. Preserve its
 * protocol failure as one host-visible AgentLoop terminal instead of treating
 * a valid final response as a malformed connection error.
 */
function rejectedExecuteTerminal(message: ModuleResponse, input: AgentLoopInput): SidecarTerminal {
  const error = asRecord(message.error);
  const code = message.code ?? (typeof error?.code === "string" ? error.code : undefined);
  const failureMessage = typeof error?.message === "string"
    ? error.message
    : code
      ? `Sidecar rejected execute request: ${code}`
      : "Sidecar rejected execute request.";
  const now = new Date().toISOString();
  return {
    result: {
      type: "error",
      sessionId: input.sessionId,
      turnId: input.turnId,
      // Native execution aborts the active model stream at the same deadline.
      // Preserve that terminal classification even when the sidecar rejects
      // before an execute stream can be accepted.
      stopReason: code === "DEADLINE_EXCEEDED" ? "aborted_streaming" : "model_error",
      usage: {},
      permissionDenials: [],
      turns: 0,
      startedAt: now,
      completedAt: now,
      errors: [agentError("agent_execution_rejected", failureMessage, {
        ...(code ? { sidecarCode: code } : {}),
        ...(message.error === undefined ? {} : { sidecarError: message.error }),
      })],
    },
    messages: input.messages,
  };
}

function readResolvedTerminal(
  resolution: AgentLoopSidecarResultUnknownResolution,
  input: AgentLoopInput,
): SidecarTerminal {
  if (!Array.isArray(resolution.messages)) {
    throw new Error("Host result_unknown reconciliation did not return canonical messages.");
  }
  assertTerminalResult(resolution.outcome, resolution.result, input);
  return {
    result: resolution.result,
    messages: resolution.messages,
    ...(resolution.seedState === undefined ? {} : { seedState: cloneSeedState(resolution.seedState) }),
  };
}

function assertTerminalResult(
  outcome: ModuleOutcome | undefined,
  result: AgentTurnResult,
  input: AgentLoopInput,
): void {
  if (result.sessionId !== input.sessionId || result.turnId !== input.turnId) {
    throw new Error("Sidecar terminal result does not match the active session or turn.");
  }
  if (outcome === "completed" && result.type !== "success") {
    throw new Error("Completed sidecar terminal does not contain a successful result.");
  }
  if (outcome === "cancelled" && result.type !== "aborted") {
    throw new Error("Cancelled sidecar terminal does not contain an aborted result.");
  }
  if (outcome === "failed" && result.type !== "error" && result.type !== "max_turns") {
    throw new Error("Failed sidecar terminal does not contain a failed result.");
  }
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") {
    throw new Error("Sidecar terminal outcome is invalid for a resolved execute result.");
  }
}

function isResolvedModuleOutcome(
  outcome: ModuleOutcome | undefined,
): outcome is Exclude<ModuleOutcome, "result_unknown"> {
  return outcome === "completed" || outcome === "failed" || outcome === "cancelled";
}

function abortedResult(input: AgentLoopInput): AgentLoopRunResult {
  const now = new Date().toISOString();
  return {
    result: {
      type: "aborted",
      sessionId: input.sessionId,
      turnId: input.turnId,
      stopReason: "aborted_streaming",
      usage: {},
      permissionDenials: [],
      turns: 0,
      startedAt: now,
      completedAt: now,
      errors: [agentError("agent_aborted", "AgentLoop sidecar turn was cancelled before execution started.")],
    },
    messages: input.messages,
  };
}

function isAgentTurnResult(value: unknown): value is AgentTurnResult {
  const result = asRecord(value);
  return Boolean(
    result
      && (result.type === "success" || result.type === "error" || result.type === "aborted" || result.type === "max_turns")
      && typeof result.sessionId === "string"
      && typeof result.turnId === "string"
      && typeof result.stopReason === "string"
      && typeof result.turns === "number",
  );
}

function cloneSeedState(seedState: AgentLoopSeedState | undefined): AgentLoopSeedState | undefined {
  return seedState ? parseAgentLoopSeedStateProjection(serializeAgentLoopSeedStateProjection(seedState)) : undefined;
}

function modelOverride(value: unknown): { provider: string; model: string } | undefined {
  const record = asRecord(value);
  return record && typeof record.provider === "string" && typeof record.model === "string"
    ? { provider: record.provider, model: record.model }
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, field: string): string {
  const candidate = value?.[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Sidecar payload field ${field} must be a non-empty string.`);
  }
  return candidate;
}

function optionalStringField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const candidate = value?.[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") {
    throw new Error(`Sidecar payload field ${field} must be a string when provided.`);
  }
  return candidate;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function serializeLifecycleDispatchResult(result: LifecycleDispatchResult): Record<string, unknown> {
  return {
    effects: result.effects,
    messages: result.messages,
    events: result.events,
    blockingErrors: result.blockingErrors,
    nonBlockingErrors: result.nonBlockingErrors,
    ...(result.pendingAsyncHooks ? { pendingAsyncHooks: result.pendingAsyncHooks } : {}),
  };
}

function serializeTransportError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { message: String(error) };
}

function safely(value: () => boolean, fallback: boolean): boolean {
  try {
    return value();
  } catch {
    return fallback;
  }
}
