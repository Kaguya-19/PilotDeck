import { createInterface } from "node:readline";
import type { Writable, Readable } from "node:stream";
import type { AgentLoop, AgentLoopInput } from "../loop/AgentLoop.js";
import type { AgentEvent } from "../protocol/events.js";
import type { CanonicalModelEvent } from "../../model/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolResult, PilotDeckToolRuntimeContext, PilotDeckToolCall } from "../../tool/index.js";
import type { ModelInvokerPort, PreparedModelInvocation, ToolPort } from "./protocol.js";
import {
  MODULE_PROTOCOL_VERSION,
  type ModuleCallRequest,
  type ModuleCapabilities,
  type ModuleExecuteRequest,
  type ModuleMessage,
  type ModuleResponse,
  type ModuleOutcome,
  validateModuleMessage,
} from "./protocol.js";

export type SidecarModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
};

export type SidecarModuleCallClient = (request: SidecarModuleCall) => Promise<ModuleResponse>;

/** Build the two AgentLoop ports that call host-owned StaffDeck modules. */
export function createSidecarPorts(
  callModule: SidecarModuleCallClient,
  options: { tools?: PilotDeckToolDefinition[]; uuid?: () => string } = {},
): { model: ModelInvokerPort; tools: ToolPort } {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  return {
    model: {
      async prepare({ request }): Promise<PreparedModelInvocation> {
        return { request, provider: request.provider, model: request.model };
      },
      async *stream({ prepared, context }): AsyncIterable<CanonicalModelEvent> {
        const response = await callModule({
          runId: context.runId,
          operationId: context.operationId ?? context.turnId,
          idempotencyKey: context.idempotencyKey,
          requestId: `model-${uuid()}`,
          module: "model",
          payload: { request: prepared.request, context },
        });
        if (!response.ok) throw new Error(String(response.error?.message ?? response.code ?? "Model module failed"));
        const events = response.payload?.events;
        if (!Array.isArray(events)) return;
        for (const event of events) yield event as CanonicalModelEvent;
      },
    },
    tools: {
      list: () => options.tools ?? [],
      async executeAll(calls: PilotDeckToolCall[], _context: PilotDeckToolRuntimeContext, execution): Promise<PilotDeckToolResult[]> {
        const results: PilotDeckToolResult[] = [];
        for (const call of calls) {
          const response = await callModule({
            runId: execution.runId,
            operationId: execution.operationId ?? execution.turnId,
            idempotencyKey: execution.idempotencyKey,
            requestId: `tool-${uuid()}`,
            module: "capability",
            payload: { name: call.name, arguments: call.input, toolCallId: call.id },
          });
          const payload = response.payload;
          if (response.ok && payload && typeof payload === "object" && "type" in payload) {
            results.push(payload as unknown as PilotDeckToolResult);
            continue;
          }
          results.push({
            type: "error",
            toolCallId: call.id,
            toolName: call.name,
            error: {
              code: "tool_execution_failed",
              message: String(response.error?.message ?? "Capability module failed."),
            },
            content: [{ type: "text", text: String(response.error?.message ?? "Capability module failed.") }],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          });
        }
        return results;
      },
    },
  };
}

export type SidecarExecution = {
  loop: AgentLoop;
  input: AgentLoopInput;
};

export type SidecarExecutionFactory = (input: {
  request: ModuleExecuteRequest;
  abortSignal: AbortSignal;
  callModule: SidecarModuleCallClient;
}) => Promise<SidecarExecution> | SidecarExecution;

export type AgentLoopSidecarOptions = {
  moduleId?: string;
  moduleInstanceId?: string;
  capabilities?: ModuleCapabilities;
  uuid?: () => string;
};

/**
 * JSON-lines server for a host-owned AgentLoop.
 *
 * The server intentionally has no process, HTTP, or provider knowledge. A host
 * supplies an execution factory and handles model/capability calls on the same
 * bidirectional stream.
 */
export class AgentLoopSidecarServer {
  readonly moduleId: string;
  readonly moduleInstanceId: string;
  readonly connectionGeneration: string;
  private readonly uuid: () => string;
  private readonly pendingCalls = new Map<string, (response: ModuleResponse) => void>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private writeChain = Promise.resolve();

  constructor(
    private readonly factory: SidecarExecutionFactory,
    private readonly options: AgentLoopSidecarOptions = {},
  ) {
    this.uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
    this.moduleId = options.moduleId ?? "pilotdeck-agent-loop";
    this.moduleInstanceId = options.moduleInstanceId ?? `${this.moduleId}-instance`;
    this.connectionGeneration = `${this.moduleInstanceId}-${this.uuid()}`;
  }

  async serve(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        await this.send(output, {
          kind: "error",
          messageId: this.nextId("parse"),
          code: "INVALID_JSON",
          message: "Module message is not valid JSON.",
          retryability: "unsafe",
        });
        continue;
      }
      const validation = validateModuleMessage(value);
      if (!validation.ok) {
        await this.send(output, {
          kind: "error",
          messageId: this.nextId("validation"),
          code: validation.code,
          message: validation.message,
          retryability: "unsafe",
        });
        continue;
      }
      const message = value as ModuleMessage;
      if (message.kind === "response") {
        const resolve = this.pendingCalls.get(message.inReplyTo);
        if (resolve) {
          this.pendingCalls.delete(message.inReplyTo);
          resolve(message);
        }
        continue;
      }
      if (message.kind !== "request") continue;
      if (message.method === "hello") {
        await this.send(output, this.handshake(message.messageId, "hello"));
      } else if (message.method === "capabilities") {
        await this.send(output, {
          ...this.handshake(message.messageId, "capabilities"),
          payload: this.options.capabilities ?? defaultCapabilities(),
        });
      } else if (message.method === "execute") {
        const execution = this.handleExecute(message, output);
        this.activeExecutions.add(execution);
        void execution.finally(() => this.activeExecutions.delete(execution));
      } else if (message.method === "module_call") {
        // module_call is sidecar-originated; receiving one is a protocol error.
        await this.send(output, {
          kind: "response",
          messageId: this.nextId("module-call"),
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: false,
          final: true,
          outcome: "failed",
          code: "UNEXPECTED_MODULE_CALL",
        });
      } else if (message.method === "cancel") {
        const controller = this.abortControllers.get(message.operationId);
        controller?.abort(message.reason);
        await this.send(output, {
          kind: "response",
          messageId: this.nextId("cancel"),
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: true,
          payload: { operationId: message.operationId, cancelled: Boolean(controller) },
        });
      }
    }
    await Promise.all([...this.activeExecutions]);
  }

  private async handleExecute(request: ModuleExecuteRequest, output: Writable): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(request.operationId, controller);
    const streamId = this.nextId("stream");
    await this.send(output, {
      kind: "response",
      messageId: this.nextId("accepted"),
      inReplyTo: request.messageId,
      requestId: request.requestId,
      ok: true,
      streamId,
      cursor: 0,
    });
    let sequence = 0;
    let finalSent = false;
    try {
      const execution = await this.factory({
        request,
        abortSignal: controller.signal,
        callModule: (call) => this.callModule(output, call),
      });
      const iterator = execution.loop.run(execution.input);
      let next = await iterator.next();
      while (!next.done) {
        const event = next.value;
        await this.send(output, {
          kind: "event",
          messageId: this.nextId("event"),
          eventType: `agent.${event.type}`,
          streamId,
          sequence: sequence++,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: false,
          payload: event as unknown as Record<string, unknown>,
        });
        next = await iterator.next();
      }
      const result = next.value;
      const outcome = result.result.type === "aborted" ? "cancelled" : result.result.type === "error" ? "failed" : "completed";
      await this.send(output, {
        kind: "event",
        messageId: this.nextId("final"),
        eventType: "agent.execute.completed",
        streamId,
        sequence: sequence++,
        runId: request.runId,
        operationId: request.operationId,
        requestId: request.requestId,
        final: true,
        outcome,
        payload: { result: result.result, messages: result.messages },
      });
      finalSent = true;
    } catch (error) {
      await this.send(output, {
        kind: "event",
        messageId: this.nextId("failed"),
        eventType: "agent.execute.failed",
        streamId,
        sequence: sequence++,
        runId: request.runId,
        operationId: request.operationId,
        requestId: request.requestId,
        final: true,
        outcome: controller.signal.aborted ? "cancelled" : "failed",
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      finalSent = true;
    } finally {
      if (!finalSent) {
        await this.send(output, {
          kind: "event",
          messageId: this.nextId("unknown"),
          eventType: "agent.execute.unknown",
          streamId,
          sequence: sequence++,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: true,
          outcome: "result_unknown",
          payload: {},
        });
      }
      this.abortControllers.delete(request.operationId);
    }
  }

  private async callModule(output: Writable, call: SidecarModuleCall): Promise<ModuleResponse> {
    const messageId = this.nextId("module-call");
    const request: ModuleCallRequest = {
      kind: "request",
      messageId,
      method: "module_call",
      ...call,
    };
    const response = new Promise<ModuleResponse>((resolve) => this.pendingCalls.set(messageId, resolve));
    await this.send(output, request);
    return response;
  }

  private handshake(inReplyTo: string, method: "hello" | "capabilities"): ModuleResponse {
    return {
      kind: "response",
      messageId: this.nextId(method),
      inReplyTo,
      ok: true,
      protocolVersion: MODULE_PROTOCOL_VERSION,
      moduleId: this.moduleId,
      moduleInstanceId: this.moduleInstanceId,
      connectionGeneration: this.connectionGeneration,
      capabilitiesVersion: (this.options.capabilities ?? defaultCapabilities()).capabilitiesVersion,
      payload: {},
    };
  }

  private async send(output: Writable, message: ModuleMessage | Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(() => new Promise<void>((resolve, reject) => {
      output.write(line, (error) => error ? reject(error) : resolve());
    }));
    return this.writeChain;
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.uuid()}`;
  }
}

function defaultCapabilities(): ModuleCapabilities {
  return {
    capabilitiesVersion: "1",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], cancel: true, resumeSupport: "streaming", retry: "retry_after_status" },
      { name: "cancel", enabled: true },
      { name: "status", enabled: false },
      { name: "resume", enabled: false },
      { name: "ack", enabled: false },
    ],
  };
}

export function moduleOutcomeFromAgentResult(result: { type: string }): ModuleOutcome {
  return result.type === "aborted" ? "cancelled" : result.type === "error" ? "failed" : "completed";
}
