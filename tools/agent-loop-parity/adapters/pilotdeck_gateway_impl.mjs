import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const sourceRoot = process.env.PARITY_SOURCE_ROOT;
const sidecarRoot = process.env.PARITY_PILOTDECK_ROOT ?? sourceRoot;
const scenario = JSON.parse(process.env.PARITY_SCENARIO_JSON);
const mockBaseUrl = process.env.PARITY_MOCK_BASE_URL;
const traceOut = process.env.PARITY_TRACE_OUT;
const mode = process.env.PARITY_MODE;
const runKey = process.env.PARITY_RUN_KEY ?? `${mode}-parity`;
const keepRuntime = process.env.PARITY_KEEP_RUNTIME === "1";
const debug = (...values) => {
  if (process.env.PARITY_DEBUG === "1") console.error("[parity-gateway]", ...values);
};

if (!sourceRoot || !sidecarRoot || !mockBaseUrl || !traceOut) {
  throw new Error("PilotDeck gateway parity environment is incomplete.");
}

const importFrom = (root, relative) => import(pathToFileURL(path.join(root, relative)).href);
const { createLocalGateway } = await importFrom(sourceRoot, "dist/src/cli/createLocalGateway.js");
const { startPilotDeckServer } = await importFrom(sourceRoot, "dist/src/cli/pilotdeckServer.js");
const { GatewayWsClient } = await importFrom(sourceRoot, "dist/src/gateway/client/GatewayWsClient.js");
const { createRouterModelInvokerPort, createToolSchedulerPort } = await importFrom(
  sidecarRoot,
  "dist/src/agent/modules/adapters.js",
);
const { createNativeOneShotSubagentPort } = await importFrom(
  sidecarRoot,
  "dist/src/agent/sub/OneShotSubagentPort.js",
);
const { requiresPromptCapability } = await importFrom(
  sourceRoot,
  "dist/src/tool/userInteractionConstraints.js",
);
const { DEFAULT_MODEL_CAPABILITIES } = await importFrom(
  sourceRoot,
  "dist/src/model/protocol/capabilities.js",
);
const { materializeMediaReferences } = await importFrom(
  sourceRoot,
  "dist/src/model/index.js",
);

let sequence = 0;
const trace = [];
let modelAttempt = 0;
let markModelStarted;
const modelStarted = new Promise((resolve) => {
  markModelStarted = resolve;
});
let markToolStarted;
const toolStarted = new Promise((resolve) => {
  markToolStarted = resolve;
});
const push = (kind, extra = {}) => {
  trace.push({ kind, scenarioId: scenario.scenarioId, q: scenario.q, sequence: sequence++, ...extra });
};
const modelView = (request) => ({
  systemPrompt: request.systemPrompt,
  messages: request.messages,
  tools: request.tools,
  metadata: request.metadata,
});
const faultAt = (target, attempt, stage) => (scenario.faults?.[target] ?? []).find(
  (fault) => (fault.at ?? 1) === attempt && (!stage || !fault.stage || fault.stage === stage),
);
const post = async (pathname, body, signal) => {
  const response = await fetch(`${mockBaseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return response.json();
};

async function waitForSubagentModelRequest({ timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = 0;
  while (Date.now() < deadline) {
    const state = await post("/control/state", { runKey });
    latest = Number(state.subagentModelRequests ?? 0);
    if (latest >= 1) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a subagent model request; observed ${latest}.`);
}

class MockModelRuntime {
  async *stream(request, options = {}) {
    modelAttempt += 1;
    push("model.request", { attempt: modelAttempt, modelView: modelView(request), request });
    markModelStarted();
    const fault = faultAt("model", modelAttempt);
    if (fault?.action === "retryable_error" || fault?.action === "non_retryable_error") {
      const retryable = fault.action === "retryable_error";
      const error = Object.assign(new Error(retryable ? "Deterministic temporary provider failure." : "Deterministic permanent provider failure."), {
        code: retryable ? "provider_unavailable" : "invalid_model_response",
        retryable,
      });
      push("fault.injected", { target: "model", action: fault.action, attempt: modelAttempt });
      push("model.error", { code: error.code, message: error.message, retryable, attempt: modelAttempt });
      throw error;
    }
    if (fault?.action === "stream_interruption") {
      push("fault.injected", { target: "model", action: fault.action, attempt: modelAttempt });
      yield { type: "request_started", provider: request.provider, model: request.model };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "partial" };
      throw Object.assign(new Error("Deterministic stream interruption."), { code: "stream_interrupted", retryable: false });
    }
    const response = await post("/v1/chat/completions", {
      scenarioId: scenario.scenarioId,
      q: scenario.q,
      messages: request.messages,
      tools: request.tools,
      // A child AgentLoop inherits this metadata through the native subagent
      // composition. The deterministic provider uses it only to select its
      // fixture response; the sidecar never receives or owns child state.
      isSubagent: typeof request.metadata?.subagentId === "string",
      delays: scenario.delays,
      toolDelays: scenario.toolDelays,
      // Model faults are injected above using the shared invocation sequence.
      // Do not forward them to the backend: its request counter excludes a
      // locally injected attempt and would fault a later parent request again.
      faults: { ...(scenario.faults ?? {}), model: [] },
      runKey,
    }, options.signal);
    if (fault?.action === "malformed_response") {
      push("fault.injected", { target: "model", action: fault.action, attempt: modelAttempt });
      throw Object.assign(new Error("Deterministic malformed model response."), { code: "invalid_model_response", retryable: false });
    }
    const message = response.choices[0].message;
    push("model.response", { attempt: modelAttempt, modelView: message, response: message });
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    for (const call of message.tool_calls ?? []) {
      yield {
        type: "tool_call_end",
        toolCall: {
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments),
        },
      };
    }
    if (message.tool_calls?.length) {
      yield { type: "message_end", finishReason: "tool_call" };
    } else {
      yield { type: "text_delta", text: message.content ?? "" };
      yield { type: "message_end", finishReason: "stop" };
    }
  }

  async complete() {
    return { role: "assistant", content: [{ type: "text", text: "Parity session" }], finishReason: "stop" };
  }

  getCapabilities() {
    return { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true };
  }

  getMultimodal() {
    return { input: ["text", "image"] };
  }

  getProviderProtocol() {
    return "openai";
  }

  getProviderBaseUrl() {
    return mockBaseUrl;
  }
}

function createTools() {
  return (scenario.tools ?? []).filter((name) => name !== "ask_user_question" && name !== "read_file").map((name) => ({
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => !["restricted", "loop"].includes(name),
    isConcurrencySafe: () => ["lookup", "summarize"].includes(name),
    requiresUserInteraction: () => name === "ask_user_question",
    checkPermissions: async () => {
      push("permission.request", { toolName: name, mode: scenario.permission?.mode ?? "default", canPrompt: scenario.permission?.canPrompt ?? false });
      const deniedByRule = scenario.permission?.deny?.includes(name) ?? false;
      const deniedByAnswer = scenario.permission?.ask?.includes(name) && scenario.permission?.answer === "deny";
      const denied = deniedByRule || deniedByAnswer;
      if (scenario.permission?.ask?.includes(name)) {
        push("permission.answer", { toolName: name, allowed: !denied, code: denied ? "PERMISSION_DENIED" : undefined });
      }
      push("permission.decision", { toolName: name, allowed: !denied });
      return denied
        ? {
            type: "deny",
            message: "Deterministic permission denial.",
            reason: { type: "tool", toolName: name, message: "denied" },
          }
        : {
            type: "allow",
            reason: { type: "tool", toolName: name, message: "allowed" },
          };
    },
    execute: async (input, context) => {
      const concurrencySafe = ["lookup", "summarize"].includes(name);
      const toolCallId = context.currentToolCallId;
      push("tool.call", { name, arguments: input, toolCallId, concurrencySafe, sideEffectCount: 0 });
      push("tool.start", { name, toolCallId, concurrencySafe, sideEffectCount: 0 });
      markToolStarted();
      const forwardCancellation = () => {
        void post("/control/cancel", { runKey }).catch(() => undefined);
      };
      context.abortSignal?.addEventListener("abort", forwardCancellation, { once: true });
      const result = await post("/tools/execute", {
        scenarioId: scenario.scenarioId,
        q: scenario.q,
        name,
        arguments: input,
        permissionAllowed: true,
        delays: scenario.delays,
        toolDelays: scenario.toolDelays,
        faults: scenario.faults,
        runKey,
      }, context.abortSignal).finally(() => {
        context.abortSignal?.removeEventListener("abort", forwardCancellation);
      });
      push("tool.finish", { name, toolCallId, concurrencySafe, success: result.type === "success", error: result.error, sideEffectCount: result.data?.sideEffectCount ?? 0 });
      push("tool.result", { result: { ...result, toolCallId }, toolCallId, concurrencySafe, sideEffectCount: result.data?.sideEffectCount ?? 0 });
      if (result.type === "error") {
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data) }], data: result.data };
    },
  }));
}

function createParityReadFileTool() {
  return {
    name: "read_file",
    description: "Reads a deterministic parity file.",
    kind: "filesystem",
    inputSchema: { type: "object", required: ["file_path"], properties: { file_path: { type: "string" } } },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    checkPermissions: async (input, context) => {
      const allowed = (context.allowedReadFiles ?? []).some((file) => String(file).endsWith(String(input.file_path ?? "")));
      push("permission.decision", { toolName: "read_file", allowed });
      return allowed ? { type: "allow", reason: { type: "tool", toolName: "read_file" } } : { type: "deny", message: "File is not in allowedReadFiles." };
    },
    execute: async (input) => ({ content: [{ type: "text", text: "deterministic file content" }], data: { path: input.file_path, content: "deterministic file content" } }),
  };
}

class MessageQueue {
  values = [];
  waiters = [];
  failure;

  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  fail(error) {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async shift() {
    if (this.values.length) return this.values.shift();
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

class StdioAgentLoopRunner {
  constructor(config, dependencies, seedState) {
    this.config = config;
    this.dependencies = dependencies;
    this.seedState = seedState;
    // Reuse the session bundle's durable host ports. They own the ordered
    // model/tool/permission records consumed by the session projection.
    this.modelPort = dependencies.ports?.model ?? createRouterModelInvokerPort(dependencies.router, {
      isMainAgent: true,
      projectPath: config.cwd,
    });
    this.toolPort = dependencies.ports?.tools
      ?? createToolSchedulerPort(dependencies.tools.registry, dependencies.tools.scheduler);
    this.preparedModelInvocations = new Map();
    this.latestPreparedByOperation = new Map();
  }

  snapshotFileState() {
    return this.seedState ?? { allowedReadFiles: [] };
  }

  async *run(input) {
    if (input.abortSignal?.aborted) return abortedTerminal(input);
    const child = spawn(process.execPath, [path.join(sidecarRoot, "dist/src/cli/pilotdeck-agent-loop-sidecar.js")], {
      cwd: sidecarRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const queue = new MessageQueue();
    const errors = [];
    const pendingModuleDispatches = new Set();
    let projectedTurnCompleted;
    const reader = createInterface({ input: child.stdout });
    let terminalSeen = false;
    const requestId = `request-${input.turnId}`;
    const runId = input.execution?.runId ?? input.turnId;
    const operationId = input.execution?.operationId ?? input.turnId;
    // Preserve the selected AgentRuntimeConfig exactly. In particular, a
    // native child may intentionally omit inherited token caps; injecting a
    // catalog output cap into its sidecar payload changes its budget semantics.
    const maxContextTokens = this.config.maxContextTokens;
    const maxOutputTokens = this.config.maxOutputTokens;
    const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    let executeWritten = false;
    let cancelSent = false;

    child.stderr.on("data", (chunk) => errors.push(String(chunk)));
    child.on("error", (error) => queue.fail(error));
    child.on("exit", (code) => {
      debug("sidecar exit", code);
      if (!terminalSeen) {
        queue.fail(new Error(`AgentLoop sidecar exited before terminal result (${code}): ${errors.join("")}`));
      }
    });
    reader.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        queue.fail(error);
        return;
      }
      if (message.kind === "request" && message.method === "module_call") {
        debug("module call", message.module, message.messageId);
        const dispatch = this.dispatchModule(message, input, queue).then(write, (error) => {
          write({
            kind: "response",
            messageId: `module-error-${message.messageId}`,
            inReplyTo: message.messageId,
            requestId: message.requestId,
            ok: false,
            code: error?.code ?? "MODULE_ERROR",
            error: { message: error?.message ?? String(error) },
          });
        });
        pendingModuleDispatches.add(dispatch);
        void dispatch.finally(() => pendingModuleDispatches.delete(dispatch));
        return;
      }
      debug("sidecar message", message.kind, message.method ?? message.eventType ?? message.outcome ?? "", JSON.stringify({
        final: message.final,
        runId: message.runId,
        operationId: message.operationId,
        requestId: message.requestId,
        expected: { runId, operationId, requestId },
      }));
      queue.push(message);
    });

    const abort = () => {
      if (!executeWritten || cancelSent || child.exitCode !== null) return;
      cancelSent = true;
      debug("forward cancel", operationId);
      write({
        kind: "request",
        messageId: `cancel-${input.turnId}`,
        method: "cancel",
        runId,
        operationId,
        requestId,
        reason: String(input.abortSignal?.reason ?? "host_cancelled"),
      });
    };
    input.abortSignal?.addEventListener("abort", abort, { once: true });

    write({
      kind: "request",
      messageId: `execute-${input.turnId}`,
      method: "execute",
      runId,
      operationId,
      requestId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      idempotencyKey: input.execution?.idempotencyKey,
      operationDeadline: input.execution?.operationDeadline,
      payload: {
        agent: {
          provider: this.config.provider,
          model: this.config.model,
          cwd: this.config.cwd,
          systemPrompt: this.config.systemPrompt,
          isSubagent: this.config.isSubagent === true,
          ...(this.config.subagentModel
            ? { subagentModel: this.config.subagentModel }
            : {}),
          maxOutputTokens,
          maxContextTokens,
          runMode: input.runMode ?? this.config.runMode,
          permissionMode: input.permissionMode ?? this.config.permissionMode,
          maxTurns: input.maxTurns,
          modelOverride: input.modelOverride,
        },
        messages: input.messages,
        tools: this.dependencies.tools.registry.list().map((tool) => ({
          name: tool.name,
          description: tool.description,
          kind: tool.kind,
          inputSchema: tool.inputSchema,
          readOnly: tool.isReadOnly({}),
          concurrencySafe: tool.isConcurrencySafe({}),
          requiresUserInteraction: requiresPromptCapability(tool, {}),
          requiredRuntimeCapabilities: tool.requiredRuntimeCapabilities,
        })),
        hostModules: {
          model: { methods: ["prepare", "stream"] },
          ...(this.dependencies.context ? {
            context: {
              methods: [
                "prepare_for_model",
                ...(typeof this.dependencies.context.applyToolResults === "function" ? ["apply_tool_results"] : []),
                ...(typeof this.dependencies.context.recoverFromModelError === "function" ? ["recover_from_model_error"] : []),
                ...(typeof this.dependencies.context.captureTurn === "function" ? ["capture_turn"] : []),
                ...(typeof this.dependencies.context.tryAutoCompact === "function" ? ["try_auto_compact"] : []),
              ],
            },
          } : {}),
          capability: { methods: ["execute", "execute_batch"] },
        },
        permissionContext: {
          ...this.config.permissionContext,
          mode: input.permissionMode ?? this.config.permissionMode,
          canPrompt: input.canPrompt ?? this.config.permissionContext.canPrompt,
          rules: input.permissionRules ?? this.config.permissionContext.rules,
        },
        seedState: this.seedState,
        executionContext: this.config.metadata,
      },
    });
    executeWritten = true;
    // Abort may have happened before the listener was attached while the
    // stdio child was spawning. Send cancel only after execute is on the wire.
    if (input.abortSignal?.aborted) abort();

    try {
      while (true) {
        const message = await queue.shift();
        if (message.kind === "host_event") {
          yield message.payload;
          continue;
        }
        // An operation deadline can expire before the server accepts a stream.
        // That valid final execute response has no stream identity or event.
        if (message.kind === "response") {
          if (
            message.inReplyTo === `execute-${input.turnId}`
            && message.requestId === requestId
            && message.ok === false
            && message.final === true
            && message.outcome === "failed"
          ) {
            terminalSeen = true;
            await Promise.allSettled([...pendingModuleDispatches]);
            const terminalResult = this.rejectedExecuteTerminal(message, input);
            yield {
              type: "turn_completed",
              sessionId: input.sessionId,
              turnId: input.turnId,
              result: terminalResult.result,
            };
            return terminalResult;
          }
          continue;
        }
        if (message.kind !== "event") continue;
        if (message.runId !== runId || message.operationId !== operationId || message.requestId !== requestId) continue;
        if (!message.final) {
          if (message.payload?.type === "turn_completed") {
            projectedTurnCompleted = message.payload;
            continue;
          }
          if (input.abortSignal?.aborted) continue;
          yield message.payload;
          continue;
        }
        terminalSeen = true;
        debug("sidecar terminal", message.outcome);
        // Cancellation may terminalize the sidecar before its host-owned
        // capability call has written its durable result. Preserve the native
        // ordering: settle host module work before publishing the turn result.
        await Promise.allSettled([...pendingModuleDispatches]);
        const payload = message.payload ?? {};
        let terminalResult;
        if (payload.result && Array.isArray(payload.messages)) {
          terminalResult = { result: payload.result, messages: payload.messages };
        } else if (projectedTurnCompleted?.result) {
          terminalResult = { result: projectedTurnCompleted.result, messages: input.messages };
        } else if (message.outcome === "cancelled") {
          const now = new Date().toISOString();
          terminalResult = {
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
            },
            messages: input.messages,
          };
        } else if (message.outcome === "failed") {
          const now = new Date().toISOString();
          terminalResult = {
            result: {
              type: "error",
              sessionId: input.sessionId,
              turnId: input.turnId,
              stopReason: "model_error",
              usage: {},
              permissionDenials: [],
              turns: 0,
              startedAt: now,
              completedAt: now,
              errors: [{
                code: message.code ?? message.error?.code ?? "sidecar_execution_failed",
                message: message.error?.message ?? "Sidecar execution failed.",
              }],
            },
            messages: input.messages,
          };
        } else {
          throw new Error(`Invalid sidecar terminal payload: ${JSON.stringify(message)}`);
        }
        const durableMessages = terminalResult.messages.slice(input.messages.length);
        for (const durableMessage of durableMessages) {
          await input.onDurableMessage?.(durableMessage);
        }
        yield {
          type: "turn_completed",
          sessionId: input.sessionId,
          turnId: input.turnId,
          result: terminalResult.result,
        };
        return terminalResult;
      }
    } finally {
      debug("runner cleanup");
      input.abortSignal?.removeEventListener("abort", abort);
      reader.close();
      this.clearPreparedInvocations(runId, operationId);
      if (child.exitCode === null) child.kill();
    }
  }

  rejectedExecuteTerminal(message, input) {
    const error = message.error && typeof message.error === "object" ? message.error : {};
    const code = message.code ?? (typeof error.code === "string" ? error.code : undefined);
    const failureMessage = typeof error.message === "string"
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
        stopReason: code === "DEADLINE_EXCEEDED" ? "aborted_streaming" : "model_error",
        usage: {},
        permissionDenials: [],
        turns: 0,
        startedAt: now,
        completedAt: now,
        errors: [{
          code: "agent_execution_rejected",
          message: failureMessage,
          ...(code ? { sidecarCode: code } : {}),
          ...(message.error === undefined ? {} : { sidecarError: message.error }),
        }],
      },
      messages: input.messages,
    };
  }

  async dispatchModule(message, input, queue) {
    const payload = message.payload ?? {};
    if (message.module === "model") {
      const context = { ...(payload.context ?? {}), abortSignal: input.abortSignal };
      if (payload.operation === "prepare") {
        const prepared = await this.modelPort.prepare({ request: payload.request, context });
        this.rememberPreparedInvocation(message, payload.preparationId, prepared);
        return this.response(message, { prepared: this.projectPreparedInvocation(prepared) });
      }
      const prepared = this.findPreparedInvocation(message, payload.preparationId)
        ?? await this.modelPort.prepare({ request: payload.request, context });
      const events = [];
      for await (const event of this.modelPort.stream({ prepared, context })) events.push(event);
      return this.response(message, { events });
    }
    if (message.module === "capability") {
      const subagent = createNativeOneShotSubagentPort({
        config: this.config,
        dependencies: this.dependencies,
      }).createForkApi({
        sessionId: input.sessionId,
        turnId: input.turnId,
        parentReadFileState: this.seedState?.readFileState,
        parentWriteSnapshots: this.seedState?.writeSnapshots,
      });
      const toolContext = {
        ...(payload.context ?? {}),
        abortSignal: input.abortSignal,
        subagent,
        currentToolCallId: payload.toolCallId,
        auditRecorder: this.dependencies.auditRecorder,
        now: this.dependencies.now,
        elicitation: this.dependencies.elicitation,
        fileHistory: this.dependencies.fileHistory,
        fileUpdateNotifier: this.dependencies.fileUpdateNotifier,
      };
      const execution = { ...(payload.execution ?? {}), abortSignal: input.abortSignal };
      if (payload.operation === "execute_batch") {
        const calls = Array.isArray(payload.calls) ? payload.calls : [];
        const results = await this.toolPort.executeAll(calls.map((call) => ({
          id: call.toolCallId,
          name: call.name,
          input: call.arguments ?? {},
        })), toolContext, execution);
        for (const event of this.dependencies.drainEvents?.() ?? []) {
          queue.push({ kind: "host_event", payload: event });
        }
        return this.response(message, { results });
      }
      const [result] = await this.toolPort.executeAll([{
        id: payload.toolCallId,
        name: payload.name,
        input: payload.arguments ?? {},
      }], toolContext, execution);
      for (const event of this.dependencies.drainEvents?.() ?? []) {
        queue.push({ kind: "host_event", payload: event });
      }
      return this.response(message, result);
    }
    if (message.module === "context") {
      const contextRuntime = this.dependencies.context;
      if (!contextRuntime) throw new Error("Host context runtime is unavailable.");
      const contextInput = { ...(payload.input ?? {}), abortSignal: input.abortSignal };
      let result;
      if (payload.operation === "prepare_for_model") {
        result = await contextRuntime.prepareForModel(contextInput);
      } else if (payload.operation === "apply_tool_results" && typeof contextRuntime.applyToolResults === "function") {
        result = await contextRuntime.applyToolResults(contextInput);
      } else if (payload.operation === "recover_from_model_error" && typeof contextRuntime.recoverFromModelError === "function") {
        result = await contextRuntime.recoverFromModelError(contextInput);
      } else if (payload.operation === "capture_turn" && typeof contextRuntime.captureTurn === "function") {
        await contextRuntime.captureTurn(contextInput);
        result = null;
      } else if (payload.operation === "try_auto_compact" && typeof contextRuntime.tryAutoCompact === "function") {
        const { budgetProjection, ...autoCompactInput } = contextInput;
        debug("host compaction budget", {
          sessionId: autoCompactInput.sessionId,
          turnId: autoCompactInput.turnId,
          isSubagent: this.config.isSubagent === true,
          budgetProjection,
          maxContextTokens: autoCompactInput.maxContextTokens,
          reservedOutputTokens: autoCompactInput.reservedOutputTokens,
        });
        const budgetEvaluator = this.createCompactionBudgetEvaluator({
          message,
          input,
          contextRuntime,
          contextInput: autoCompactInput,
          budgetProjection,
        });
        result = await contextRuntime.tryAutoCompact({
          ...autoCompactInput,
          ...(budgetEvaluator ? { budgetEvaluator } : {}),
        });
      } else {
        throw new Error(`Unsupported host context operation: ${payload.operation}`);
      }
      return this.response(message, { result });
    }
    return this.response(message, { accepted: true });
  }

  preparedInvocationKey(message, preparationId) {
    return `${message.runId}\u0000${message.operationId}\u0000${preparationId}`;
  }

  operationKey(message) {
    return `${message.runId}\u0000${message.operationId}`;
  }

  rememberPreparedInvocation(message, preparationId, prepared) {
    if (typeof preparationId !== "string" || preparationId.length === 0) {
      throw new Error("Model prepare is missing preparationId.");
    }
    const operationKey = this.operationKey(message);
    const entry = { preparationId, prepared };
    this.preparedModelInvocations.set(this.preparedInvocationKey(message, preparationId), entry);
    this.latestPreparedByOperation.set(operationKey, entry);
  }

  findPreparedInvocation(message, preparationId) {
    if (typeof preparationId !== "string" || preparationId.length === 0) return undefined;
    return this.preparedModelInvocations.get(this.preparedInvocationKey(message, preparationId))?.prepared;
  }

  latestPreparedInvocation(message) {
    return this.latestPreparedByOperation.get(this.operationKey(message))?.prepared;
  }

  clearPreparedInvocations(runId, operationId) {
    const prefix = `${runId}\u0000${operationId}\u0000`;
    for (const key of this.preparedModelInvocations.keys()) {
      if (key.startsWith(prefix)) this.preparedModelInvocations.delete(key);
    }
    this.latestPreparedByOperation.delete(`${runId}\u0000${operationId}`);
  }

  projectPreparedInvocation(prepared) {
    return {
      request: prepared.request,
      provider: prepared.provider,
      model: prepared.model,
      ...(prepared.maxContextTokens
        ? { maxContextTokens: prepared.maxContextTokens }
        : {}),
      ...(prepared.maxOutputTokens
        ? { maxOutputTokens: prepared.maxOutputTokens }
        : {}),
    };
  }

  createCompactionBudgetEvaluator({ message, input, contextRuntime, contextInput, budgetProjection }) {
    const tokenAccounting = this.dependencies.tokenAccounting;
    if (!tokenAccounting) return undefined;
    const prepared = this.latestPreparedInvocation(message);
    const effectiveProvider = prepared?.provider ?? input.modelOverride?.provider ?? this.config.provider;
    const effectiveModel = prepared?.model ?? input.modelOverride?.model ?? this.config.model;
    // The context window comes from the host model catalog when the child
    // config intentionally omits inherited caps. Output reservation, however,
    // must remain the value selected by the sidecar AgentLoop (or zero when
    // absent), matching native child execution.
    const catalogLimits = this.dependencies.getModelTokenLimits?.(effectiveProvider, effectiveModel);
    const maxContextTokens = positiveInteger(budgetProjection?.maxContextTokens)
      ?? positiveInteger(contextInput.maxContextTokens)
      ?? positiveInteger(this.config.maxContextTokens)
      ?? positiveInteger(catalogLimits?.maxContextTokens);
    if (!maxContextTokens) return undefined;
    const reservedOutputTokens = positiveInteger(budgetProjection?.reservedOutputTokens)
      ?? positiveInteger(contextInput.reservedOutputTokens)
      ?? positiveInteger(this.config.maxOutputTokens);
    return async (messages) => {
      const request = await this.buildCompactionRequest(messages, input, contextRuntime);
      let candidate = request;
      if (prepared) {
        const patched = {
          ...prepared.request,
          messages: request.messages,
          systemPrompt: request.systemPrompt,
          tools: request.tools,
          cacheBreakpoints: request.cacheBreakpoints,
          cachePlan: request.cachePlan,
        };
        candidate = prepared.opaque && this.dependencies.router.materializeRequest
          ? this.dependencies.router.materializeRequest(prepared.opaque, patched)
          : { ...patched, provider: prepared.provider, model: prepared.model };
      }
      return tokenAccounting.evaluateRequestBudget(candidate, {
        maxContextTokens,
        reservedOutputTokens,
        signal: input.abortSignal,
      });
    };
  }

  async buildCompactionRequest(messages, input, contextRuntime) {
    const requestProvider = input.modelOverride?.provider ?? this.config.provider;
    const requestModel = input.modelOverride?.model ?? this.config.model;
    const permissionMode = input.permissionMode ?? this.config.permissionMode;
    const canPrompt = input.canPrompt ?? this.config.permissionContext.canPrompt;
    const tools = this.dependencies.tools.registry.list()
      .filter((tool) => canPrompt || !requiresPromptCapability(tool, {}))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    const prepared = await contextRuntime.prepareForModel({
      sessionId: input.sessionId,
      turnId: input.turnId,
      cwd: this.config.cwd,
      runtimeContextSurface: this.config.runtimeContextSurface,
      provider: requestProvider,
      model: requestModel,
      protocol: this.dependencies.getModelProtocol?.(requestProvider),
      supportsPromptCache: this.dependencies.getModelSupportsPromptCache?.(requestProvider, requestModel),
      permissionMode,
      runMode: input.runMode ?? this.config.runMode ?? "agent",
      additionalWorkingDirectories: this.config.permissionContext.additionalWorkingDirectories,
      messages,
      tools,
      maxMessages: this.config.maxContextMessages,
      customSystemPrompt: this.config.systemPrompt,
      abortSignal: input.abortSignal,
    });
    const materialized = await materializeMediaReferences(prepared.messages);
    return {
      provider: requestProvider,
      model: requestModel,
      messages: materialized.messages,
      systemPrompt: prepared.systemPrompt ?? this.config.systemPrompt,
      tools: prepared.tools,
      toolChoice: this.config.toolChoice,
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: input.modelOverride?.temperature ?? this.config.temperature,
      speed: input.modelOverride?.speed,
      thinking: input.modelOverride?.thinking ?? this.config.thinking,
      stream: true,
      metadata: this.config.metadata,
      cacheBreakpoints: prepared.cacheBreakpoints,
      cachePlan: prepared.cachePlan,
    };
  }

  response(message, payload) {
    return {
      kind: "response",
      messageId: `response-${message.messageId}`,
      inReplyTo: message.messageId,
      requestId: message.requestId,
      ok: true,
      payload,
    };
  }
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function abortedTerminal(input) {
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
    },
    messages: input.messages,
  };
}

const configuredRuntimeRoot = process.env.PARITY_RUNTIME_ROOT;
const runtimeRoot = configuredRuntimeRoot
  ? path.resolve(configuredRuntimeRoot)
  : await mkdtemp(path.join(tmpdir(), `pilotdeck-full-${mode}-`));
await mkdir(runtimeRoot, { recursive: true });
const pilotHome = path.join(runtimeRoot, "home");
await mkdir(pilotHome, { recursive: true });
process.env.PILOT_HOME = pilotHome;
const projectRoot = pilotHome;
const configuredContextTokens = scenario.limits?.maxContextTokens ?? 65536;
await writeFile(path.join(pilotHome, "pilotdeck.yaml"), `schemaVersion: 1\nagent:\n  model: parity/deterministic\n  maxContextTokens: ${configuredContextTokens}\n  maxOutputTokens: 8192\nmodel:\n  providers:\n    parity:\n      protocol: openai\n      url: ${mockBaseUrl}\n      apiKey: parity-test\n      models:\n        deterministic:\n          capabilities:\n            supportsToolUse: true\n            maxContextTokens: ${configuredContextTokens}\n            maxOutputTokens: 8192\ntelemetry:\n  enabled: false\n`, "utf8");
await writeFile(path.join(projectRoot, "parity-input.txt"), "deterministic file content\n", "utf8");

  const local = createLocalGateway({
  projectRoot,
  pilotHome,
  permissionMode: scenario.permission?.mode ?? "default",
    extraTools: [
      ...createTools(),
    ],
  __testModelFactory: () => new MockModelRuntime(),
  autoElicitation: scenario.permission?.answer === "allow",
  ...(mode === "sidecar" ? {
    __testAgentLoopFactory: ({ config, dependencies, seedState }) =>
      new StdioAgentLoopRunner(config, dependencies, seedState),
  } : {}),
});
const server = await startPilotDeckServer({
  gateway: local.gateway,
  host: "127.0.0.1",
  port: 0,
  staticAssetsPath: path.join(sourceRoot, "ui", "dist"),
});
local.bindServer(server);

if (process.env.PARITY_SERVE_ONLY === "1") {
  console.log(JSON.stringify({ url: server.url, wsUrl: server.wsUrl, token: server.token }));
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  await local.dispose();
  if (!keepRuntime) await rm(runtimeRoot, { recursive: true, force: true });
  process.exit(0);
}

const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
const controlClient = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test-control" });
try {
  await client.connect();
  await controlClient.connect();
  // Keep the same project cwd/model-visible runtime context for both adapters
  // while isolating their durable session histories. A prior adapter can still
  // be flushing its transcript when the next one begins.
  const sessionKey = `full-${scenario.scenarioId}-${mode}`;
  if (scenario.scenarioId === "checkpoint_resume") {
    for await (const _event of client.stream("submit_turn", {
      sessionKey,
      channelKey: "test",
      message: "Previous deterministic result",
      mode: "default",
      canPrompt: false,
    })) {
      // Populate the real transcript before the resumed turn.
    }
  }
  const attachments = [];
  if ((scenario.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((item) => item.type === "image_url"))) {
    const block = scenario.messages?.at(-1)?.content?.find((item) => item.type === "image_url");
    const match = /^data:([^;]+);base64,(.+)$/.exec(block?.image_url?.url ?? "");
    if (!match) throw new Error("Image scenario is missing a data URL.");
    const imagePath = path.join(projectRoot, "parity-image.png");
    await writeFile(imagePath, Buffer.from(match[2], "base64"));
    attachments.push({ type: "image", name: "parity-image.png", path: imagePath, mimeType: match[1] });
  }
  const limits = scenario.limits ?? {};
  const stream = client.stream("submit_turn", {
    sessionKey,
    channelKey: "test",
    message: scenario.q,
    attachments,
    mode: scenario.permission?.mode ?? "default",
    canPrompt: scenario.permission?.canPrompt ?? false,
    maxTurns: limits.maxTurns,
    timeoutMs: limits.deadlineMs,
  });
  const cancelAfterMs = limits.cancelAfterToolStartMs ?? limits.cancelAfterMs;
  const cancelAnchor = limits.cancelAfterToolStartMs ? toolStarted : modelStarted;
  const cancelTask = cancelAfterMs
    ? cancelAnchor.then(() => new Promise((resolve) => setTimeout(resolve, cancelAfterMs))).then(async () => {
        push("cancel.requested", { sessionKey });
        await post("/control/cancel", { runKey });
        return controlClient.request("abort_turn", { sessionKey, reason: "parity_cancel" }).then(
          () => push("cancel.acknowledged", { sessionKey }),
          (error) => push("cancel.error", { message: error?.message ?? String(error) }),
        );
      })
    : undefined;
  const closeAfterChildModel = scenario.lifecycle?.closeSessionAfterSubagentModel === true;
  const closeTask = closeAfterChildModel
    ? waitForSubagentModelRequest({ timeoutMs: Number(scenario.limits?.closeWaitMs) || 5000 }).then(async (subagentModelRequests) => {
        push("sidecar.lifecycle", {
          state: "parent_close_requested",
          stage: "child_model_started",
          subagentModelRequests,
        });
        await local.gateway.closeSession({ sessionKey, reason: "parity_parent_close" });
        push("sidecar.lifecycle", {
          state: "parent_closed",
          stage: "child_first_drain",
          parentClosed: true,
          subagentModelRequests,
        });
      })
    : undefined;
  const abortAfterChildModel = scenario.lifecycle?.abortTurnAfterSubagentModel === true;
  const abortTask = abortAfterChildModel
    ? waitForSubagentModelRequest({ timeoutMs: Number(scenario.limits?.abortWaitMs) || 5000 }).then(async (subagentModelRequests) => {
        push("sidecar.lifecycle", {
          state: "parent_abort_requested",
          stage: "child_model_started",
          subagentModelRequests,
        });
        await post("/control/cancel", { runKey });
        await controlClient.request("abort_turn", { sessionKey, reason: "parity_parent_abort_after_child_admission" });
        push("sidecar.lifecycle", {
          state: "parent_abort_acknowledged",
          stage: "child_model_started",
          parentAborted: true,
          subagentModelRequests,
        });
      })
    : undefined;
  let visibleOutput = "";
  let terminal;
  let terminalCount = 0;
  const builtinToolLifecycleNames = new Set(["agent", "read_file", "subagent", "send_message"]);
  for await (const event of stream) {
    // These built-ins emit lifecycle only through the Gateway stream. Keep
    // their port-level effects in the same trace vocabulary as parity tools.
    if (event.type === "tool_call_started" && builtinToolLifecycleNames.has(event.name)) {
      push("tool.call", {
        name: event.name,
        toolCallId: event.toolCallId,
        ...(event.name === "read_file" && event.argsPreview
          ? { arguments: { preview: event.argsPreview } }
          : {}),
      });
      push("tool.start", { name: event.name, toolCallId: event.toolCallId });
    }
    if (event.type === "tool_call_finished" && builtinToolLifecycleNames.has(event.toolName)) {
      if (event.toolName === "read_file") {
        const denied = event.errorCode === "permission_denied" || event.errorCode === "permission_required";
        push("permission.decision", { toolName: event.toolName, allowed: event.ok && !denied });
      }
      push("tool.finish", {
        name: event.toolName,
        toolCallId: event.toolCallId,
        success: event.ok,
        error: event.errorCode ? { code: event.errorCode, message: event.resultPreview } : undefined,
      });
      push("tool.result", {
        toolCallId: event.toolCallId,
        result: event.ok
          ? { type: "success", data: { preview: event.resultPreview } }
          : { type: "error", error: { code: event.errorCode, message: event.resultPreview } },
      });
    }
    if (event.type === "permission_request") {
      push("permission.request", { requestId: event.requestId, toolName: event.toolName, payload: event.payload });
    }
    if (event.type === "assistant_text_delta") {
      visibleOutput += event.text;
      push("user.output", { text: event.text });
    }
    if (event.type === "turn_completed") {
      terminal = event;
      terminalCount += 1;
    }
    if (event.type === "error") push("gateway.error", { code: event.code, message: event.message });
  }
  if (cancelTask) await cancelTask;
  if (closeTask) await closeTask;
  if (abortTask) {
    await abortTask;
    push("sidecar.lifecycle", {
      state: "parent_abort_settled",
      stage: "turn_terminal",
      parentAborted: true,
      terminalCount,
    });
  }
  const mockState = await post("/control/state", { runKey });
  const sideEffectCounts = mockState.sideEffects ?? {};
  push("side_effect.state", {
    counts: sideEffectCounts,
    sideEffectCount: Object.values(sideEffectCounts).reduce((total, value) => total + Number(value || 0), 0),
  });
  debug("gateway stream closed", terminal?.finishReason ?? "without terminal");
  const finishReason = terminal?.finishReason ?? "unknown";
  push("terminal", {
    outcome: finishReason === "completed" ? "completed" : finishReason.includes("abort") ? "cancelled" : "failed",
    code: finishReason === "max_turns" ? "agent_max_turns_reached" : undefined,
    stopReason: finishReason,
    output: visibleOutput,
  });
  await writeFile(traceOut, `${trace.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
} finally {
  debug("closing deployment");
  client.close();
  controlClient.close();
  await server.close();
  await local.dispose();
  if (!keepRuntime) await rm(runtimeRoot, { recursive: true, force: true });
}
