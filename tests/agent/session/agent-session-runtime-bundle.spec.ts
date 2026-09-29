import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentSessionRuntimeBundle } from "../../../src/agent/session/AgentSessionRuntimeBundle.js";
import { createDurableContextRuntime } from "../../../src/agent/modules/context/durableContextRuntime.js";
import { createDurablePermissionAuditRecorder } from "../../../src/agent/modules/permission/durablePermissionAudit.js";
import { AgentSessionEventRecorder } from "../../../src/agent/session/AgentSessionEventRecorder.js";
import { AgentRuntimeScope } from "../../../src/agent/scope/AgentRuntimeScope.js";
import { createNativeInteractionReconnectPort } from "../../../src/interaction/index.js";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";

const config = {
  provider: "test",
  model: "test",
  cwd: process.cwd(),
  permissionMode: "default" as const,
  permissionContext: {
    mode: "default" as const,
    cwd: process.cwd(),
    additionalWorkingDirectories: [],
    canPrompt: false,
    bypassAvailable: false,
    rules: { allow: [], deny: [], ask: [] },
  },
};

const registry = { list: () => [] } as never;

test("the native session runtime bundle owns its fallback scope and in-memory projection", async () => {
  const resources = new AgentSessionRuntimeBundle({
    sessionId: "fallback-session",
    config,
    dependencies: {
      router: {} as never,
      tools: { registry },
    },
  }).compose();

  assert.equal(resources.scope.state, "active");
  assert.ok(resources.projections);
  assert.equal(typeof resources.dependencies.drainEvents, "function");

  await resources.dispose();

  assert.equal(resources.scope.state, "disposed");
  assert.throws(() => resources.projections?.snapshot(), /projection driver is disposed/);
});

test("the session-owned fallback reconnect provider clears pending interaction state on dispose", async () => {
  const resources = new AgentSessionRuntimeBundle({
    sessionId: "fallback-reconnect",
    config,
    dependencies: {
      router: {} as never,
      tools: { registry },
    },
  }).compose();
  const reconnect = resources.dependencies.interactionReconnect!;
  reconnect.register({
    ownerId: "fallback-reconnect",
    requestId: "request-1",
    kind: "question",
  });
  assert.equal(reconnect.snapshot("fallback-reconnect").length, 1);

  await resources.dispose();

  assert.deepEqual(reconnect.snapshot("fallback-reconnect"), []);
});

test("the session runtime bundle preserves caller ownership of an injected reconnect provider", async () => {
  const reconnect = createNativeInteractionReconnectPort();
  reconnect.register({
    ownerId: "external-reconnect",
    requestId: "request-1",
    kind: "permission",
  });
  const resources = new AgentSessionRuntimeBundle({
    sessionId: "external-reconnect",
    config,
    dependencies: {
      router: {} as never,
      interactionReconnect: reconnect,
      tools: { registry },
    },
  }).compose();

  await resources.dispose();

  assert.equal(reconnect.snapshot("external-reconnect").length, 1);
  reconnect.dispose();
});

test("the session runtime bundle releases an explicitly transferred reconnect provider", async () => {
  const reconnect = createNativeInteractionReconnectPort();
  reconnect.register({
    ownerId: "owned-reconnect",
    requestId: "request-1",
    kind: "question",
  });
  const resources = new AgentSessionRuntimeBundle({
    sessionId: "owned-reconnect",
    config,
    dependencies: {
      router: {} as never,
      interactionReconnect: reconnect,
      tools: { registry },
    },
    ownedInteractionReconnect: true,
  }).compose();

  await resources.dispose();

  assert.deepEqual(reconnect.snapshot("owned-reconnect"), []);
});

test("the session runtime bundle transfers an explicitly owned subagent provider to its registry", async () => {
  let disposed = 0;
  const resources = new AgentSessionRuntimeBundle({
    sessionId: "owned-subagent-provider",
    config,
    dependencies: {
      router: {} as never,
      subagentProvider: {
        name: "owned-provider",
        capabilities: { continuation: false, depthLimit: true, toolFilter: true },
        dispose() { disposed += 1; },
      },
      ownedSubagentProvider: true,
      tools: { registry },
    },
  }).compose();

  await resources.dispose();

  assert.equal(disposed, 1);
  await resources.dispose();
  assert.equal(disposed, 1);
});

test("the session runtime bundle does not dispose an injected scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-runtime-bundle-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const scope = AgentRuntimeScope.createRoot({
    router: {} as never,
    permission: {} as never,
    toolRegistry: registry,
    toolScheduler: {} as never,
  });
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "injected-scope",
  });
  const resources = new AgentSessionRuntimeBundle({
    sessionId: "injected-scope",
    config: { ...config, cwd: root, permissionContext: { ...config.permissionContext, cwd: root } },
    dependencies: {
      router: {} as never,
      scope,
      tools: { registry },
    },
    storage,
  }).compose();

  assert.equal(resources.scope, scope);
  assert.equal(resources.storage, storage);
  await resources.dispose();

  assert.equal(scope.state, "active");
  assert.equal(storage.persistenceBinding.active, false);
  assert.equal(storage.projectionCheckpointBinding.active, false);
  await scope.dispose();
});

test("the session runtime bundle releases an explicitly owned Context provider through scope disposal", async () => {
  let disposed = 0;
  const resources = new AgentSessionRuntimeBundle({
    sessionId: "owned-context",
    config,
    dependencies: {
      router: {} as never,
      context: {
        async prepareForModel() {
          return { messages: [], systemPromptParts: [], tools: [], diagnostics: [], boundaries: [] };
        },
        dispose() { disposed += 1; },
      },
      ownedContext: true,
      tools: { registry },
    },
  }).compose();

  await resources.dispose();
  assert.equal(disposed, 1);
  await resources.dispose();
  assert.equal(disposed, 1, "provider disposal remains idempotent through the scope");
});

test("the session runtime bundle rebinds inherited durable context and audit to its own recorder", async () => {
  const parentTranscript = new InMemoryTranscriptWriter();
  const parentRecorder = new AgentSessionEventRecorder(parentTranscript);
  await parentRecorder.startTurn("parent-session", "parent-turn");
  const hostAudit = {
    async recordPermission() {},
    async recordTool() {},
  };
  const inheritedContext = createDurableContextRuntime({
    async prepareForModel() {
      return {
        messages: [],
        systemPromptParts: [],
        tools: [],
        diagnostics: [],
        boundaries: [],
        materialization: { runtimeContexts: [] },
      };
    },
  }, parentRecorder);
  const inheritedAudit = createDurablePermissionAuditRecorder(
    hostAudit,
    parentRecorder,
    { sessionId: "parent-session" },
  );
  const childTranscript = new InMemoryTranscriptWriter();
  const resources = new AgentSessionRuntimeBundle({
    sessionId: "child-session",
    config,
    transcript: childTranscript,
    dependencies: {
      router: {} as never,
      context: inheritedContext,
      auditRecorder: inheritedAudit,
      ports: {
        model: {
          async prepare({ request }) {
            return { request, provider: request.provider, model: request.model };
          },
          async *stream() {
            yield { type: "message_end" as const, finishReason: "stop" as const };
          },
        },
      },
      tools: { registry },
    },
  }).compose();
  const execution = {
    sessionId: "child-session",
    turnId: "child-turn",
    runId: "child-run",
  };

  try {
    await resources.eventRecorder.startTurn(execution.sessionId, execution.turnId);
    await resources.context!.prepareForModel({
      ...execution,
      cwd: config.cwd,
      provider: config.provider,
      model: config.model,
      permissionMode: config.permissionMode,
      additionalWorkingDirectories: [],
      messages: [],
      tools: [],
    });
    const request = { provider: config.provider, model: config.model, messages: [], tools: [] };
    const model = resources.dependencies.ports!.model!;
    const prepared = await model.prepare({ request, context: execution });
    for await (const _event of model.stream({ prepared, context: execution })) {
      // Drain the wrapper so the child model admission is recorded.
    }
    await resources.dependencies.auditRecorder!.recordPermissionStarted!({
      type: "permission_started",
      operationId: "child-call",
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      toolCallId: "child-call",
      toolName: "read_file",
      mode: "default",
      createdAt: "2026-09-10T00:00:00.000Z",
    });
    await resources.dependencies.auditRecorder!.recordPermission({
      type: "permission",
      operationId: "child-call",
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      toolCallId: "child-call",
      toolName: "read_file",
      mode: "default",
      decision: "allow",
      reason: { type: "runtime", message: "test" },
      createdAt: "2026-09-10T00:00:00.000Z",
    });

    assert.deepEqual(parentTranscript.entries.map((entry) => entry.type), ["turn_started"]);
    assert.deepEqual(childTranscript.entries.map((entry) => entry.type), [
      "turn_started",
      "step_started",
      "context_snapshot",
      "model_request",
      "model_stream_event",
      "permission_started",
      "permission_completed",
    ]);
  } finally {
    await resources.dispose();
  }
});
