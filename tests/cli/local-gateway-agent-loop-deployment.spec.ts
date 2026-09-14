import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  AgentLoopSidecarServer,
  AgentLoopSidecarTcpServer,
  createAgentLoopSidecarRuntimeFactory,
  createTcpAgentLoopSidecarConnectionFactory,
  type AgentLoopSidecarConnection,
} from "../../src/agent/index.js";
import { createSidecarExecution } from "../../src/cli/pilotdeck-agent-loop-default-factory.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { SidecarExecutionFactory } from "../../src/agent/modules/transport/agentLoopSidecarServer.js";
import type { ModuleCapabilities, ModuleMessage } from "../../src/agent/modules/protocol.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
  ModelRuntimeOptions,
  MultimodalConstraints,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { readAgentProjectSessionPersistence } from "../../src/session/index.js";
import type { PilotDeckToolDefinition } from "../../src/tool/index.js";

test("local Gateway selects the TCP sidecar profile and keeps model/tool execution in the host", async (t) => {
  const root = await createFixture(t);
  const moduleCalls: Array<{ payload: unknown; response: unknown }> = [];
  const operationDeadlines: Array<string | undefined> = [];
  const transportObservations: string[] = [];
  const factory: SidecarExecutionFactory = async (input) => {
    operationDeadlines.push(input.request.operationDeadline);
    return createSidecarExecution({
      ...input,
      callModule: async (call) => {
        const response = await input.callModule(call);
        moduleCalls.push({ payload: structuredClone(call.payload), response: structuredClone(response) });
        return response;
      },
    });
  };
  const sidecar = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(factory));
  const address = await sidecar.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => sidecar.close());

  const model = new ToolCallingModel();
  let toolExecutions = 0;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    permissionMode: "bypassPermissions",
    env: {
      PILOTDECK_AGENT_LOOP_TRANSPORT: "tcp",
      PILOTDECK_AGENT_LOOP_TCP_HOST: address.host,
      PILOTDECK_AGENT_LOOP_TCP_PORT: String(address.port),
      PILOTDECK_AGENT_LOOP_CONNECT_TIMEOUT_MS: "500",
    },
    agentLoopTransportObserver: {
      observe(observation) {
        transportObservations.push(observation.type);
      },
    },
    __testModelFactory: () => model,
    extraTools: [{
      name: "host_probe",
      description: "Confirms that sidecar tool calls execute in the host.",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => {
        toolExecutions += 1;
        return { content: [{ type: "text", text: "host probe completed" }] };
      },
    } satisfies PilotDeckToolDefinition],
  });
  t.after(() => local.dispose());

  const events = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "tcp-deployment-session",
    channelKey: "test",
    projectKey: root,
    message: "Use the host probe.",
    runId: "tcp-deployment-run",
    timeoutMs: 5_000,
  })) {
    events.push(event);
  }

  assert.equal(model.requests, 2, `the sidecar must return to the host for both model steps: ${JSON.stringify({ events, moduleCalls })}`);
  assert.equal(toolExecutions, 1, `the sidecar capability call must execute the host-owned tool once: ${JSON.stringify({ events, moduleCalls })}`);
  assert.equal(events.filter((event) => event.type === "tool_call_started").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_call_finished").length, 1);
  assert.equal(events.some((event) => event.type === "assistant_text_delta" && event.text === "TCP sidecar complete."), true);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.equal(operationDeadlines.length, 1);
  assert.ok(operationDeadlines[0] && Number.isFinite(Date.parse(operationDeadlines[0])));
  assert.ok(Date.parse(operationDeadlines[0]!) > Date.now());
  assert.deepEqual(transportObservations, ["stream_accepted"]);
});

test("local Gateway executes a sidecar agent-tool delegation through the host one-shot subagent port", async (t) => {
  const root = await createFixture(t);
  const moduleCalls: Array<{ payload: unknown; response: unknown }> = [];
  const factory: SidecarExecutionFactory = async (input) => createSidecarExecution({
    ...input,
    callModule: async (call) => {
      const response = await input.callModule(call);
      moduleCalls.push({ payload: structuredClone(call.payload), response: structuredClone(response) });
      return response;
    },
  });
  const sidecar = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(factory));
  const address = await sidecar.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => sidecar.close());

  const model = new DelegatingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    permissionMode: "bypassPermissions",
    env: {
      PILOTDECK_AGENT_LOOP_TRANSPORT: "tcp",
      PILOTDECK_AGENT_LOOP_TCP_HOST: address.host,
      PILOTDECK_AGENT_LOOP_TCP_PORT: String(address.port),
      PILOTDECK_AGENT_LOOP_CONNECT_TIMEOUT_MS: "500",
    },
    __testModelFactory: () => model,
  });
  t.after(() => local.dispose());

  const events = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "tcp-subagent-session",
    channelKey: "test",
    projectKey: root,
    message: "Delegate this investigation.",
    runId: "tcp-subagent-run",
  })) {
    events.push(event);
  }

  assert.equal(model.requests, 3, `outer sidecar turn plus one host-owned child run: ${JSON.stringify({ events, moduleCalls })}`);
  const delegatedCapability = moduleCalls.find(({ payload }) => {
    const record = payload as { operation?: unknown; calls?: Array<{ name?: unknown }> };
    return record.operation === "execute_batch" && record.calls?.some((call) => call.name === "agent");
  });
  assert.ok(delegatedCapability, `agent tool must cross the capability module: ${JSON.stringify(moduleCalls)}`);
  assert.equal(events.filter((event) => event.type === "tool_call_started").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_call_finished").length, 1);
  assert.equal(events.some((event) => event.type === "assistant_text_delta" && event.text === "Delegation complete."), true);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
});

test("local Gateway abort cancels a TCP sidecar agent-tool child through the host one-shot subagent port", async (t) => {
  const root = await createFixture(t);
  const moduleCalls: Array<{ payload: unknown; response: unknown }> = [];
  const moduleRequests: unknown[] = [];
  const factory: SidecarExecutionFactory = async (input) => createSidecarExecution({
    ...input,
    callModule: async (call) => {
      moduleRequests.push(structuredClone(call.payload));
      const response = await input.callModule(call);
      moduleCalls.push({ payload: structuredClone(call.payload), response: structuredClone(response) });
      return response;
    },
  });
  const sidecar = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(factory));
  const address = await sidecar.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => sidecar.close());

  const model = new AbortableDelegatingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    permissionMode: "bypassPermissions",
    env: {
      PILOTDECK_AGENT_LOOP_TRANSPORT: "tcp",
      PILOTDECK_AGENT_LOOP_TCP_HOST: address.host,
      PILOTDECK_AGENT_LOOP_TCP_PORT: String(address.port),
      PILOTDECK_AGENT_LOOP_CONNECT_TIMEOUT_MS: "500",
    },
    __testModelFactory: () => model,
  });
  t.after(() => local.dispose());

  const sessionKey = "tcp-subagent-abort-session";
  const runId = "tcp-subagent-abort-run";
  const submitted = collectEvents(local.gateway.submitTurn({
    sessionKey,
    channelKey: "test",
    projectKey: root,
    message: "Delegate this investigation, then wait.",
    runId,
  }));
  void submitted.catch(() => undefined);

  await withTimeout(
    model.childStarted,
    2_000,
    () => "The host-owned one-shot child did not start.",
  );
  await withTimeout(
    local.gateway.abortTurn({ sessionKey, runId, reason: "test_parent_abort" }),
    5_000,
    () => "Gateway abort did not settle the sidecar delegation.",
  );
  const events = await withTimeout(
    submitted,
    5_000,
    () => "Gateway turn did not settle after aborting the sidecar delegation.",
  );
  const persisted = await readAgentProjectSessionPersistence({
    projectRoot: root,
    pilotHome: root,
    sessionId: sessionKey,
  });
  const capabilityCalls = moduleRequests.filter((payload) => {
    const record = payload as { operation?: unknown; name?: unknown; calls?: Array<{ name?: unknown }> };
    return (record.operation === "execute_batch" && record.calls?.some((call) => call.name === "agent"))
      || (record.operation === "execute" && record.name === "agent");
  });
  const operationTerminals = persisted.entries.filter((entry) => entry.type === "agent_loop_operation_terminal");

  assert.equal(model.requests, 2, `outer sidecar turn plus one child run: ${JSON.stringify({ events, moduleCalls })}`);
  assert.equal(model.childAbortSignals, 1, "the child model must receive the parent abort signal exactly once");
  assert.equal(capabilityCalls.length, 1, "the sidecar must not duplicate the agent capability call");
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_call_finished").length, 0, "an aborted host child must not publish a completed tool result");
  assert.equal(operationTerminals.length, 1, "the host Session must retain one sidecar operation terminal");
  assert.equal(operationTerminals[0]?.type === "agent_loop_operation_terminal" && operationTerminals[0].outcome, "cancelled");
});

test("local Gateway abort cancels a stdio sidecar agent-tool child through the host one-shot subagent port", async (t) => {
  const root = await createFixture(t);
  const model = new AbortableDelegatingModel();
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    permissionMode: "bypassPermissions",
    env: { PILOTDECK_AGENT_LOOP_TRANSPORT: "stdio" },
    __testModelFactory: () => model,
  });
  t.after(() => local.dispose());

  const sessionKey = "stdio-subagent-abort-session";
  const runId = "stdio-subagent-abort-run";
  const submitted = collectEvents(local.gateway.submitTurn({
    sessionKey,
    channelKey: "test",
    projectKey: root,
    message: "Delegate this investigation, then wait.",
    runId,
  }));
  void submitted.catch(() => undefined);

  await withTimeout(
    model.childStarted,
    10_000,
    () => "The stdio sidecar did not start the host-owned one-shot child.",
  );
  await withTimeout(
    local.gateway.abortTurn({ sessionKey, runId, reason: "test_parent_abort" }),
    10_000,
    () => "Gateway abort did not settle the stdio sidecar delegation.",
  );
  const events = await withTimeout(
    submitted,
    10_000,
    () => "Gateway turn did not settle after aborting the stdio sidecar delegation.",
  );
  const persisted = await readAgentProjectSessionPersistence({
    projectRoot: root,
    pilotHome: root,
    sessionId: sessionKey,
  });
  const operationTerminals = persisted.entries.filter((entry) => entry.type === "agent_loop_operation_terminal");

  assert.equal(model.requests, 2, `outer stdio sidecar turn plus one child run: ${JSON.stringify({ events })}`);
  assert.equal(model.childAbortSignals, 1, "the stdio sidecar child must receive the parent abort signal exactly once");
  assert.equal(events.filter((event) => event.type === "tool_call_started").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_call_finished").length, 0, "an aborted host child must not publish a completed tool result");
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.equal(operationTerminals.length, 1, "the host Session must retain one stdio sidecar operation terminal");
  assert.equal(operationTerminals[0]?.type === "agent_loop_operation_terminal" && operationTerminals[0].outcome, "cancelled");
});

test("local Gateway replays a TCP sidecar stream without duplicating host tool or Session terminals", async (t) => {
  const root = await createFixture(t);
  const moduleCalls: Array<{ payload: unknown; response: unknown }> = [];
  let waitForResume: (() => Promise<void>) | undefined;
  const factory: SidecarExecutionFactory = (input) => {
    const sessionId = String(input.request.sessionId);
    const turnId = String(input.request.turnId);
    const callHost = async (call: Parameters<typeof input.callModule>[0]) => {
      const response = await input.callModule(call);
      moduleCalls.push({ payload: structuredClone(call.payload), response: structuredClone(response) });
      return response;
    };
    return {
      loop: {
        async *run() {
          const model = await callHost({
            runId: input.request.runId,
            operationId: input.request.operationId,
            requestId: "reconnect-model-prepare",
            module: "model",
            payload: {
              operation: "prepare",
              preparationId: "reconnect-preparation",
              request: {
                provider: "test",
                model: "test",
                messages: [{ role: "user", content: [{ type: "text", text: "Use the reconnect probe." }] }],
                tools: [],
              },
            },
          });
          if (!model.ok) throw new Error(`Host model preparation failed: ${model.code ?? model.error?.message ?? "unknown error"}`);
          const streamed = await callHost({
            runId: input.request.runId,
            operationId: input.request.operationId,
            requestId: "reconnect-model-stream",
            module: "model",
            payload: {
              operation: "stream",
              preparationId: "reconnect-preparation",
            },
          });
          if (!streamed.ok) throw new Error(`Host model stream failed: ${streamed.code ?? streamed.error?.message ?? "unknown error"}`);
          yield { type: "model_request_started" as const, sessionId, turnId, provider: "test", model: "test" };
          if (!waitForResume) throw new Error("TCP replay test did not configure a resume gate.");
          await waitForResume();
          const tool = await callHost({
            runId: input.request.runId,
            operationId: input.request.operationId,
            requestId: "reconnect-probe-capability",
            module: "capability",
            payload: {
              operation: "execute_batch",
              calls: [{ name: "reconnect_probe", arguments: {}, toolCallId: "reconnect-probe-call" }],
              context: { currentToolCallId: "reconnect-probe-call" },
            },
          });
          if (!tool.ok) throw new Error(`Host reconnect probe failed: ${tool.code ?? tool.error?.message ?? "unknown error"}`);
          return { result: completedSidecarResult(sessionId, turnId), messages: [] };
        },
      } as never,
      input: {} as never,
    };
  };
  const sidecar = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(factory, {
    capabilities: RESUMABLE_TCP_CAPABILITIES,
  }));
  const sidecarAddress = await sidecar.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => sidecar.close());

  const tcpConnect = createTcpAgentLoopSidecarConnectionFactory(sidecarAddress);
  const trace: string[] = [];
  let dropped = false;
  let reconnects = 0;
  let resumeResponses = 0;
  let resumeMessageId: string | undefined;
  let resolveResume!: () => void;
  const resumeAccepted = new Promise<void>((resolve) => { resolveResume = resolve; });
  const faultInjectingFactory = createAgentLoopSidecarRuntimeFactory({
    connect: async (input) => {
      let active = await tcpConnect(input);
      let decorated!: AgentLoopSidecarConnection;
      decorated = {
        send(message: ModuleMessage) {
          if (message.kind === "request" && message.method === "resume") {
            resumeMessageId = message.messageId;
            trace.push("resume-request");
          }
          return active.send(message);
        },
        async *receive() {
          for await (const message of active.receive()) {
            const record = message as { kind?: unknown; inReplyTo?: unknown };
            if (record.kind === "response" && record.inReplyTo === resumeMessageId) {
              // Yield first so SidecarRunner updates its phase to execute
              // before the model emits the host capability call.
              yield message;
              resumeResponses += 1;
              trace.push("resume-response");
              resolveResume();
              continue;
            }
            yield message;
            if (!dropped && isInitialStreamEvent(message)) {
              dropped = true;
              trace.push("drop-after-sequence-0");
              // Let the sidecar advance from the yielded stream event into
              // the model gate. The model is blocked on resume, so this does
              // not permit a second stream event on the old connection.
              await new Promise<void>((resolve) => setTimeout(resolve, 20));
              await active.close?.("test_partial_replay_drop");
              return;
            }
          }
        },
        async reconnect(reconnectInput) {
          reconnects += 1;
          trace.push(`reconnect-${reconnectInput.lastAppliedSequence}`);
          if (!active.reconnect) throw new Error("TCP connection must support reconnect.");
          active = await active.reconnect(reconnectInput);
          return decorated;
        },
        close(reason) {
          return active.close?.(reason);
        },
      };
      return decorated;
    },
  });

  waitForResume = () => withTimeout(
    resumeAccepted,
    2_000,
    () => `Timed out waiting for TCP resume: ${trace.join(" | ")}`,
  );
  let toolExecutions = 0;
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    permissionMode: "bypassPermissions",
    env: {
      PILOTDECK_AGENT_LOOP_TRANSPORT: "tcp",
      PILOTDECK_AGENT_LOOP_TCP_HOST: sidecarAddress.host,
      PILOTDECK_AGENT_LOOP_TCP_PORT: String(sidecarAddress.port),
      PILOTDECK_AGENT_LOOP_CONNECT_TIMEOUT_MS: "500",
    },
    // This is the production TCP provider with a test-only first-stream
    // disconnect decorator. Gateway and Session still compose the real host
    // sidecar factory and all host callbacks.
    agentLoopFactory: faultInjectingFactory,
    __testModelFactory: () => new ToolCallingModel(),
    extraTools: [{
      name: "reconnect_probe",
      description: "Confirms a replayed sidecar stream executes the host tool once.",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => {
        toolExecutions += 1;
        return { content: [{ type: "text", text: "reconnect probe completed" }] };
      },
    } satisfies PilotDeckToolDefinition],
  });
  t.after(() => local.dispose());

  const sessionKey = "tcp-reconnect-session";
  const submitted = collectEvents(local.gateway.submitTurn({
    sessionKey,
    channelKey: "test",
    projectKey: root,
    message: "Use the reconnect probe.",
    runId: "tcp-reconnect-run",
  }));
  void submitted.catch(() => undefined);
  const events = await withTimeout(
    submitted,
    5_000,
    () => `Gateway turn did not settle after the forced TCP drop: ${trace.join(" | ")}`,
  );

  const persisted = await readAgentProjectSessionPersistence({
    projectRoot: root,
    pilotHome: root,
    sessionId: sessionKey,
  });
  const capabilityCalls = moduleCalls.filter(({ payload }) => {
    const record = payload as { operation?: unknown; calls?: Array<{ name?: unknown }> };
    return record.operation === "execute_batch" && record.calls?.some((call) => call.name === "reconnect_probe");
  });
  const modelPreparations = moduleCalls.filter(({ payload }) => {
    const record = payload as { operation?: unknown; preparationId?: unknown };
    return record.operation === "prepare" && record.preparationId === "reconnect-preparation";
  });

  assert.equal(
    dropped,
    true,
    `the test connection must drop the first stream after sequence 0: ${JSON.stringify({ events, moduleCalls })}`,
  );
  assert.equal(reconnects, 1, `the reconnect must use exactly one replacement TCP connection: ${trace.join(" | ")}`);
  assert.equal(resumeResponses, 1, `the replacement connection must acknowledge resume: ${trace.join(" | ")}`);
  assert.equal(modelPreparations.length, 1, `model admission must not be replayed: ${JSON.stringify(moduleCalls)}`);
  assert.equal(toolExecutions, 1, `host tool side effect must execute once: ${JSON.stringify({ events, moduleCalls })}`);
  assert.equal(capabilityCalls.length, 1, `capability.execute_batch must not be resent: ${JSON.stringify(moduleCalls)}`);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.equal(
    persisted.entries.filter((entry) => entry.type === "agent_loop_operation_terminal").length,
    1,
    "the host Session must retain one durable operation terminal",
  );
});

class ToolCallingModel implements ModelRuntime {
  requests = 0;

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests += 1;
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    if (!hasToolResult(request, "host-probe-call")) {
      yield { type: "tool_call_start", id: "host-probe-call", name: "host_probe" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "host-probe-call", name: "host_probe", input: {} },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "TCP sidecar complete." };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [], finishReason: "stop" };
  }

  getCapabilities() {
    return {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsToolUse: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

class DelegatingModel implements ModelRuntime {
  requests = 0;

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests += 1;
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.requests === 1) {
      yield { type: "tool_call_start", id: "delegate-agent-call", name: "agent" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "delegate-agent-call",
          name: "agent",
          input: {
            description: "Inspect delegation",
            prompt: "Inspect the host-owned sidecar delegation boundary.",
            subagent_type: "explore",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (this.requests === 2) {
      yield { type: "text_delta", text: "Scope: host child\nResult: complete\nKey files: none\nFiles changed: none\nIssues: none" };
      yield { type: "message_end", finishReason: "stop" };
      return;
    }
    yield { type: "text_delta", text: "Delegation complete." };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [], finishReason: "stop" };
  }

  getCapabilities() {
    return {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsToolUse: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

class AbortableDelegatingModel implements ModelRuntime {
  requests = 0;
  childAbortSignals = 0;
  private resolveChildStarted!: () => void;
  readonly childStarted = new Promise<void>((resolve) => {
    this.resolveChildStarted = resolve;
  });

  async *stream(_request: CanonicalModelRequest, options?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent> {
    this.requests += 1;
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.requests === 1) {
      yield { type: "tool_call_start", id: "abort-delegate-agent-call", name: "agent" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "abort-delegate-agent-call",
          name: "agent",
          input: {
            description: "Wait for parent abort",
            prompt: "Wait until the parent aborts this subagent.",
            subagent_type: "explore",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (this.requests === 2) {
      this.resolveChildStarted();
      const signal = options?.signal;
      await waitForAbort(signal);
      this.childAbortSignals += 1;
      throw signal?.reason instanceof Error ? signal.reason : new Error("child model aborted");
    }
    throw new Error("The outer sidecar must stop after the child is cancelled.");
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [], finishReason: "stop" };
  }

  getCapabilities() {
    return {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsToolUse: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

const RESUMABLE_TCP_CAPABILITIES: ModuleCapabilities = {
  capabilitiesVersion: "2.0",
  methods: [
    { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "streaming" },
    { name: "resume", enabled: true },
    { name: "ack", enabled: true },
    { name: "status", enabled: true },
  ],
};

function isInitialStreamEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const message = value as { kind?: unknown; sequence?: unknown; final?: unknown };
  return message.kind === "event" && message.sequence === 0 && message.final !== true;
}

function completedSidecarResult(sessionId: string, turnId: string) {
  return {
    type: "success" as const,
    sessionId,
    turnId,
    stopReason: "completed" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:00:00.001Z",
  };
}

async function collectEvents<T>(values: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const value of values) events.push(value);
  return events;
}

async function withTimeout<T>(
  value: Promise<T>,
  timeoutMs: number,
  message: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return Promise.reject(new Error("abortable model did not receive an abort signal"));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function hasToolResult(request: CanonicalModelRequest, toolCallId: string): boolean {
  return request.messages.some((message) => message.content.some(
    (block) => block.type === "tool_result" && block.toolCallId === toolCallId,
  ));
}

async function createFixture(t: { after(callback: () => void | Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-sidecar-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "  maxContextTokens: 128000",
    "  maxOutputTokens: 8192",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test:",
    "          capabilities:",
    "            supportsToolUse: true",
    "            maxContextTokens: 128000",
    "            maxOutputTokens: 8192",
    "",
  ].join("\n"));
  return root;
}
