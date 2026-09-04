import assert from "node:assert/strict";
import test from "node:test";

import { createSidecarExecution } from "../../../src/cli/pilotdeck-agent-loop-default-factory.js";

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
          maxTurns: 2,
          runMode: "ask",
          modelOverride: { provider: "provider-b", model: "model-b" },
        },
        task: { prompt: "Inspect the input." },
        messages: [
          { role: "user", content: [{ type: "text", text: "Additional context" }, { type: "image", source: "base64", mimeType: "image/png", data: "abc" }] },
          { role: "assistant", content: "Acknowledged" },
        ],
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
  assert.equal(execution.input.canPrompt, true);
  assert.deepEqual(execution.input.modelOverride, { provider: "provider-b", model: "model-b" });
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

  const context = (execution.loop as any).dependencies.context;
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
        }],
      },
    },
    abortSignal: new AbortController().signal,
    callModule: async () => ({ kind: "response", messageId: "response-1", inReplyTo: "call-1", ok: true }),
  });

  const [tool] = (execution.loop as any).toolPort.list();
  assert.equal(tool.requiresUserInteraction?.({}), true);
});
