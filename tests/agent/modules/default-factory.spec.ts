import assert from "node:assert/strict";
import test from "node:test";

import { createSidecarExecution } from "../../../src/cli/pilotdeck-agent-loop-default-factory.js";
import { createPlanTodoSnapshot } from "../../../src/plan-todo/projection/PlanTodoProjection.js";

test("default sidecar factory maps host-neutral execution payloads", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      sessionId: "session-1",
      turnId: "turn-1",
      operationDeadline: "2026-09-02T00:01:00.000Z",
      payload: {
        agent: {
          provider: "provider-a",
          model: "model-a",
          cwd: "/workspace",
          systemPrompt: "Use the host tools.",
          runtimeContextSurface: "system_prompt",
          maxTurns: 2,
          runMode: "ask",
          modelOverride: { provider: "provider-b", model: "model-b" },
        },
        task: { prompt: "Inspect the input." },
        messages: [
          { role: "user", content: [{ type: "text", text: "Additional context" }, { type: "image", source: "base64", mimeType: "image/png", data: "abc" }] },
          { role: "assistant", content: "Acknowledged" },
        ],
        allowPlanModeTools: true,
        permissionContext: {
          mode: "plan",
          canPrompt: true,
          bypassAvailable: false,
          rules: { deny: [{ toolName: "shell" }] },
        },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.equal(execution.input.sessionId, "session-1");
  assert.equal(execution.input.turnId, "turn-1");
  assert.equal(execution.input.maxTurns, 2);
  assert.equal(execution.input.runMode, "ask");
  assert.equal(execution.input.permissionMode, "plan");
  assert.equal(execution.input.allowPlanModeTools, true);
  assert.equal(execution.input.canPrompt, true);
  assert.deepEqual(execution.input.modelOverride, { provider: "provider-b", model: "model-b" });
  assert.equal((execution.loop as any).config.runtimeContextSurface, "system_prompt");
  assert.deepEqual(execution.input.execution, {
    runId: "run-1",
    operationId: "operation-1",
    idempotencyKey: undefined,
    operationDeadline: "2026-09-02T00:01:00.000Z",
  });
  assert.deepEqual(execution.input.messages, [
    { role: "user", content: [{ type: "text", text: "Additional context" }, { type: "image", source: "base64", mimeType: "image/png", data: "abc" }] },
    { role: "assistant", content: [{ type: "text", text: "Acknowledged" }] },
  ]);
});

test("default sidecar factory preserves canonical message lifecycle metadata", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-metadata",
      method: "execute",
      runId: "run-metadata",
      operationId: "operation-metadata",
      requestId: "request-metadata",
      payload: {
        messages: [{
          role: "user",
          content: "Injected runtime context",
          metadata: {
            synthetic: true,
            transient: true,
            transientId: "runtime-context-1",
            purpose: "runtime_context",
            queueItemId: "queued-input-1",
            forkCarryover: { sourceSessionId: "parent-session", sourceTurnId: "parent-turn" },
            hostPrivate: "must not cross the protocol boundary",
          },
        }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-metadata", inReplyTo: "call-metadata", ok: true }),
  });

  assert.deepEqual(execution.input.messages, [{
    role: "user",
    content: [{ type: "text", text: "Injected runtime context" }],
    metadata: {
      synthetic: true,
      transient: true,
      transientId: "runtime-context-1",
      purpose: "runtime_context",
      queueItemId: "queued-input-1",
      forkCarryover: { sourceSessionId: "parent-session", sourceTurnId: "parent-turn" },
    },
  }]);
});

test("default sidecar factory preserves generic subagent runtime identity and token baseline", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-subagent",
      method: "execute",
      runId: "run-subagent",
      operationId: "operation-subagent",
      requestId: "request-subagent",
      payload: {
        agent: {
          provider: "parent-provider",
          model: "parent-model",
          isSubagent: true,
          subagentModel: {
            provider: "child-provider",
            model: "child-model",
            maxContextTokens: 128_000,
            maxOutputTokens: 32_768,
          },
        },
        task: { prompt: "Run as a child." },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-subagent", inReplyTo: "call-subagent", ok: true }),
  });

  const runtimeConfig = (execution.loop as any).config;
  assert.equal(runtimeConfig.isSubagent, true);
  assert.deepEqual(runtimeConfig.subagentModel, {
    provider: "child-provider",
    model: "child-model",
    maxContextTokens: 128_000,
    maxOutputTokens: 32_768,
  });
});

test("default sidecar factory rejects malformed generic subagent model metadata", async () => {
  await assert.rejects(
    async () => createSidecarExecution({
      request: {
        kind: "request",
        messageId: "message-subagent-invalid",
        method: "execute",
        runId: "run-subagent-invalid",
        operationId: "operation-subagent-invalid",
        requestId: "request-subagent-invalid",
        payload: {
          agent: {
            isSubagent: true,
            subagentModel: { provider: "child-provider", model: "child-model", maxContextTokens: 0 },
          },
        },
      },
      abortSignal: new AbortController().signal,
      callModule: async () => ({ kind: "response", messageId: "response-subagent-invalid", inReplyTo: "call-subagent-invalid", ok: true }),
    }),
    /agent\.subagentModel\.maxContextTokens/,
  );
});

test("default sidecar factory falls back to the shared runtime-context profile", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-surface",
      method: "execute",
      runId: "run-surface",
      operationId: "operation-surface",
      requestId: "request-surface",
      payload: {
        agent: { runtimeContextSurface: "unsupported" },
        task: { prompt: "Check profile fallback." },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-surface", inReplyTo: "call-surface", ok: true }),
  });

  assert.equal((execution.loop as any).config.runtimeContextSurface, "user_message");
});

test("default sidecar factory validates and restores generic seed state", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        task: { prompt: "Resumed task" },
        seedState: { allowedReadFiles: ["/workspace/input.txt"] },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.equal(execution.input.sessionId, "operation-1");
  assert.deepEqual(execution.input.messages, [
    { role: "user", content: [{ type: "text", text: "Resumed task" }] },
  ]);
  assert.deepEqual(execution.loop.snapshotFileState().allowedReadFiles, ["/workspace/input.txt"]);
});

test("default sidecar factory rejects malformed generic seed state", async () => {
  await assert.rejects(
    async () => createSidecarExecution({
      request: {
        kind: "request",
        messageId: "message-1",
        method: "execute",
        runId: "run-1",
        operationId: "operation-1",
        requestId: "request-1",
        payload: { seedState: { allowedReadFiles: [42] } },
      },
      abortSignal: new AbortController().signal,
      callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
    }),
    /allowedReadFiles/,
  );
});

test("default sidecar factory gives contextOverride precedence and merges metadata", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        agent: { systemPrompt: "agent prompt" },
        task: { prompt: "fallback" },
        messages: [{ role: "user", content: "ordinary" }],
        tools: [{ name: "ordinary", inputSchema: { type: "object" } }],
        executionContext: { source: "execution", shared: "old" },
        contextOverride: {
          systemPrompt: "host prompt",
          messages: [{ role: "assistant", content: "host history" }],
          metadata: { shared: "new", iteration: 2 },
          tools: [{ name: "host-tool", inputSchema: { type: "object" } }],
        },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.deepEqual(execution.input.messages, [
    { role: "assistant", content: [{ type: "text", text: "host history" }] },
  ]);
  const runtimeConfig = (execution.loop as any).config;
  assert.equal(runtimeConfig.systemPrompt, "host prompt");
  assert.deepEqual(runtimeConfig.metadata, {
    source: "execution",
    shared: "new",
    iteration: 2,
  });
});

test("default sidecar factory delegates context preparation to an advertised host module", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        hostModules: {
          context: { methods: ["prepare_for_model"] },
        },
        messages: [{ role: "user", content: "hello" }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (request) => {
      calls.push(request as unknown as Record<string, unknown>);
      return {
        kind: "response",
        messageId: "response-1",
        inReplyTo: "call-1",
        ok: true,
        payload: {
          result: {
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            systemPrompt: "host system prompt",
            systemPromptParts: ["host system prompt"],
            tools: [],
            diagnostics: [],
            boundaries: [],
          },
        },
      };
    },
  });

  const context = (execution.loop as any).capabilities.context;
  const prepared = await context.prepareForModel({
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/workspace",
    provider: "provider-a",
    model: "model-a",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [],
    tools: [],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.module, "context");
  assert.equal((calls[0]?.payload as Record<string, unknown>).operation, "prepare_for_model");
  assert.equal(prepared.systemPrompt, "host system prompt");
});

test("default sidecar factory initializes an advertised host-owned plan/todo mirror", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-plan-todo",
      method: "execute",
      runId: "run-plan-todo",
      operationId: "operation-plan-todo",
      requestId: "request-plan-todo",
      sessionId: "session-plan-todo",
      turnId: "turn-plan-todo",
      payload: {
        hostModules: { capability: { methods: ["plan_todo"] } },
        messages: [{ role: "user", content: "Follow the approved plan." }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      calls.push(moduleCall as unknown as Record<string, unknown>);
      const payload = moduleCall.payload as Record<string, unknown>;
      assert.equal(moduleCall.module, "capability");
      assert.equal(payload.operation, "plan_todo");
      assert.equal(payload.method, "read");
      return {
        kind: "response",
        messageId: "plan-todo-snapshot",
        inReplyTo: "call",
        ok: true,
        payload: {
          snapshot: {
            ...createPlanTodoSnapshot(),
            approvedPlan: "# Approved plan\nInspect then implement.",
            requiresInitialization: true,
          },
        },
      };
    },
  });

  const planTodo = (execution.loop as any).capabilities.tools.planTodoManager.forSession("session-plan-todo");
  assert.match(planTodo.buildPromptAddendum() ?? "", /Before using any non-read-only tool/);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0]?.payload as Record<string, unknown>), {
    operation: "plan_todo",
    method: "read",
    sessionId: "session-plan-todo",
    turnId: "turn-plan-todo",
  });
});

test("default sidecar factory injects an advertised host lifecycle runtime", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-lifecycle",
      method: "execute",
      runId: "run-lifecycle",
      operationId: "operation-lifecycle",
      requestId: "request-lifecycle",
      sessionId: "session-lifecycle",
      turnId: "turn-lifecycle",
      payload: {
        hostModules: { lifecycle: { methods: ["dispatch"] } },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      calls.push(moduleCall as unknown as Record<string, unknown>);
      return {
        kind: "response",
        messageId: "lifecycle-response",
        inReplyTo: "call",
        ok: true,
        payload: {
          result: {
            effects: [],
            messages: [],
            events: [],
            blockingErrors: [],
            nonBlockingErrors: [],
          },
        },
      };
    },
  });

  const lifecycle = (execution.loop as any).capabilities.hooks.lifecycle;
  assert.equal(typeof lifecycle?.dispatch, "function");
  await lifecycle.dispatch({
    event: "Stop",
    baseInput: { sessionId: "ignored", transcriptPath: "ignored", cwd: "ignored" },
    payload: { lastAssistantMessage: "complete" },
  });
  assert.deepEqual((calls[0]?.payload as Record<string, unknown>), {
    operation: "dispatch",
    event: "Stop",
    payload: { lastAssistantMessage: "complete" },
  });
});

test("default sidecar factory forwards advertised volatile AgentLoop events before final", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-event",
      method: "execute",
      runId: "run-event",
      operationId: "operation-event",
      requestId: "request-event",
      sessionId: "session-event",
      turnId: "turn-event",
      payload: {
        hostModules: { event: { methods: ["emit"] } },
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      calls.push(moduleCall as unknown as Record<string, unknown>);
      return { kind: "response", messageId: "event-response", inReplyTo: "call", ok: true };
    },
  });

  (execution.loop as any).capabilities.events.emit({
    type: "instructions_loaded",
    sessionId: "session-event",
    turnId: "turn-event",
    hasSystemPrompt: true,
  });
  await execution.flush?.();
  assert.deepEqual((calls[0]?.payload as Record<string, unknown>), {
    operation: "emit",
    event: {
      type: "instructions_loaded",
      sessionId: "session-event",
      turnId: "turn-event",
      hasSystemPrompt: true,
    },
  });
  assert.equal(calls[0]?.module, "event");
});

test("default sidecar factory preserves host model preparation identity after AgentLoop normalizes the prepared request", async () => {
  const calls: Array<{ operation?: string; preparationId?: string; request?: unknown }> = [];
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-model-preparation",
      method: "execute",
      runId: "run-model-preparation",
      operationId: "operation-model-preparation",
      requestId: "request-model-preparation",
      sessionId: "session-model-preparation",
      turnId: "turn-model-preparation",
      payload: {
        agent: { provider: "provider-a", model: "model-a" },
        hostModules: { model: { methods: ["prepare", "stream"] } },
        messages: [{ role: "user", content: "preserve preparation" }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async (moduleCall) => {
      const payload = moduleCall.payload as Record<string, unknown>;
      calls.push({
        operation: payload.operation as string | undefined,
        preparationId: payload.preparationId as string | undefined,
        request: structuredClone(payload.request),
      });
      if (payload.operation === "prepare") {
        return {
          kind: "response",
          messageId: "prepared-model-preparation",
          inReplyTo: moduleCall.requestId,
          ok: true,
          payload: {
            prepared: {
              request: payload.request,
              provider: "provider-a",
              model: "model-a",
            },
          },
        };
      }
      return {
        kind: "response",
        messageId: "streamed-model-preparation",
        inReplyTo: moduleCall.requestId,
        ok: true,
        payload: {
          events: [
            { type: "text_delta", text: "done" },
            { type: "message_end", finishReason: "stop" },
          ],
        },
      };
    },
  });

  for await (const _event of execution.loop.run(execution.input)) {
    // Consume the full sidecar execution so both model module calls occur.
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.operation), ["prepare", "stream"]);
  assert.equal(typeof calls[0]?.preparationId, "string");
  assert.equal(calls[1]?.preparationId, calls[0]?.preparationId);
  assert.deepEqual(calls[1]?.request, calls[0]?.request);
});

test("default sidecar factory injects only an advertised host permission module", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        hostModules: { permission: { methods: ["decide", "unknown"] } },
        messages: [{ role: "user", content: "hello" }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  assert.equal(typeof (execution.loop as any).capabilities.tools.permission?.decide, "function");
});

test("default sidecar factory preserves host tool interaction metadata", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-1",
      method: "execute",
      runId: "run-1",
      operationId: "operation-1",
      requestId: "request-1",
      payload: {
        messages: [{ role: "user", content: "hello" }],
        tools: [{
          name: "host-interactive-tool",
          inputSchema: { type: "object" },
          requiresUserInteraction: true,
          requiredRuntimeCapabilities: ["plan_workflow"],
        }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  const [tool] = (execution.loop as any).toolPort.list();
  assert.equal(tool.requiresUserInteraction?.({}), true);
  assert.deepEqual(tool.requiredRuntimeCapabilities, ["plan_workflow", "user_interaction"]);
});

test("default sidecar factory retains agent capability requirements", async () => {
  const execution = await createSidecarExecution({
    request: {
      kind: "request",
      messageId: "message-agent-capability",
      method: "execute",
      runId: "run-agent-capability",
      operationId: "operation-agent-capability",
      requestId: "request-agent-capability",
      payload: {
        messages: [{ role: "user", content: "delegate this task" }],
        tools: [{
          name: "host-subagent",
          kind: "agent",
          inputSchema: { type: "object" },
          requiredRuntimeCapabilities: ["plan_workflow"],
        }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-agent-capability", inReplyTo: "call-agent-capability", ok: true }),
  });

  const [tool] = (execution.loop as any).toolPort.list();
  assert.equal(tool.kind, "agent");
  assert.deepEqual(tool.requiredRuntimeCapabilities, ["plan_workflow", "subagent_fork"]);
});
