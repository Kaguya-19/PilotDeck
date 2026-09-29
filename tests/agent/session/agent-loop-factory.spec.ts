import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  createAgentSessionWithStorage,
  createAgentSessionWithStorageAsync,
} from "../../../src/agent/session/createAgentSession.js";
import { PromptContributionRegistry } from "../../../src/context/index.js";
import type { AgentLoopRunResult, AgentLoopSeedState } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { SubagentProvider } from "../../../src/agent/sub/SubagentProvider.js";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import type { AgentPermissionDenial } from "../../../src/agent/protocol/result.js";
import type { LifecycleDispatchPort } from "../../../src/agent/index.js";
import type { LifecycleRuntime } from "../../../src/lifecycle/index.js";

test("createAgentSession can run a turn through an injected AgentLoop transport", async () => {
  let factoryCalls = 0;
  let runCalls = 0;
  const seedState: AgentLoopSeedState = { allowedReadFiles: ["fixture.txt"] };
  const permission = {
    async decide() {
      return { type: "allow" as const, reason: { type: "runtime" as const, message: "test" } };
    },
  };
  const transcript = new InMemoryTranscriptWriter();
  const session = createAgentSession({
    sessionId: "session-sidecar",
    config: {
      provider: "test",
      model: "test",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      permission,
      tools: { registry: { list: () => [] } as never },
    },
    seedState,
    transcript,
    agentLoopFactory: (input) => {
      factoryCalls += 1;
      assert.equal(input.seedState, seedState);
      assert.equal(input.capabilities.permission, permission);
      return {
        snapshotFileState: () => seedState,
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          runCalls += 1;
          const result: AgentLoopRunResult = {
            result: {
              type: "success",
              sessionId: options.sessionId,
              turnId: options.turnId,
              finalMessage: { role: "assistant", content: [{ type: "text", text: "sidecar" }] },
              stopReason: "completed",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-09-03T00:00:00.000Z",
              completedAt: "2026-09-03T00:00:00.001Z",
            },
            messages: options.messages,
          };
          yield {
            type: "turn_completed",
            sessionId: options.sessionId,
            turnId: options.turnId,
            result: result.result,
          };
          return result;
        },
      };
    },
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "hello" }, { turnId: "turn-sidecar" })) {
    if (event.type === "turn_completed") {
      assert.equal(transcript.entries.some((entry) => entry.type === "turn_result"), true);
      assert.equal(transcript.entries.at(-1)?.type, "session_metadata");
    }
    events.push(event);
  }

  assert.equal(factoryCalls, 1);
  assert.equal(runCalls, 1);
  assert.equal(events.some((event) => event.type === "turn_completed"), true);
  assert.deepEqual(transcript.entries
    .map((entry) => entry.type)
    .filter((type) => type === "turn_started" || type === "accepted_input" || type === "turn_result"), [
    "turn_started",
    "accepted_input",
    "turn_result",
  ]);
  assert.deepEqual(session.snapshotForRuntimeReload().fileState, seedState);
});

test("the storage-backed agent handle releases projection and persistence subscriptions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-handle-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "session-owned-storage",
  });
  const { handle } = createAgentSessionWithStorage({
    sessionId: "session-owned-storage",
    config: {
      provider: "test",
      model: "test",
      cwd: root,
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        cwd: root,
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      tools: { registry: { list: () => [] } as never },
    },
    storage,
    __agentLoopFactory: () => ({
      snapshotFileState: () => ({}),
      async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        throw new Error("not used");
      },
    }),
  });

  assert.equal(storage.persistenceBinding.active, true);
  assert.equal(storage.projectionCheckpointBinding.active, true);
  await handle.dispose();
  assert.equal(storage.persistenceBinding.active, false);
  assert.equal(storage.projectionCheckpointBinding.active, false);
  assert.equal(
    (await storage.projectionCheckpointStore.load("session-owned-storage"))?.asOfSequence,
    -1,
  );
  assert.throws(() => storage.projections.snapshot(), /projection driver is disposed/);
});

test("the session factory rolls back bundle-owned resources when configuration fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-handle-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "session-configure-rollback",
  });

  await assert.rejects(
    createAgentSessionWithStorageAsync({
      sessionId: "session-configure-rollback",
      config: {
        provider: "test",
        model: "test",
        cwd: root,
        permissionMode: "default",
        permissionContext: {
          mode: "default",
          cwd: root,
          additionalWorkingDirectories: [],
          canPrompt: false,
          bypassAvailable: false,
          rules: { allow: [], deny: [], ask: [] },
        },
      },
      dependencies: {
        router: {} as never,
        tools: { registry: { list: () => [] } as never },
      },
      storage,
      __agentLoopFactory: () => ({
        snapshotFileState: () => ({}),
        async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          throw new Error("not used");
        },
      }),
      __configure: () => {
        throw new Error("configure failed");
      },
    }),
    /configure failed/,
  );

  assert.equal(storage.persistenceBinding.active, false);
  assert.equal(storage.projectionCheckpointBinding.active, false);
  assert.throws(() => storage.projections.snapshot(), /projection driver is disposed/);
});

test("the agent handle disposes an owned prompt contribution registry", async () => {
  const promptContributions = new PromptContributionRegistry({ name: "owned-prompt" });
  const { handle } = createAgentSessionWithStorage({
    sessionId: "session-owned-prompt",
    config: {
      provider: "test",
      model: "test",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      promptContributions: { registry: promptContributions, owned: true },
      tools: { registry: { list: () => [] } as never },
    },
    __agentLoopFactory: () => ({
      snapshotFileState: () => ({}),
      async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        throw new Error("not used");
      },
    }),
  });

  assert.equal(promptContributions.state, "active");
  await handle.dispose();
  assert.equal(promptContributions.state, "disposed");
});

test("the agent handle disposes an owned lifecycle runtime through its scope", async () => {
  let disposed = 0;
  let captured: LifecycleDispatchPort | undefined;
  const lifecycle = {
    dispose: async () => {
      disposed += 1;
    },
  } as LifecycleRuntime;
  const { handle } = createAgentSessionWithStorage({
    sessionId: "session-owned-lifecycle",
    config: {
      provider: "test",
      model: "test",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      lifecycle,
      ownedLifecycle: true,
      tools: { registry: { list: () => [] } as never },
    },
    agentLoopFactory: ({ capabilities }) => {
      captured = capabilities.hooks.lifecycle;
      return {
        snapshotFileState: () => ({}),
        async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          throw new Error("not used");
        },
      };
    },
  });

  assert.notEqual(captured, lifecycle);
  assert.equal(typeof captured?.dispatch, "function");
  assert.equal("dispose" in (captured ?? {}), false);
  await handle.dispose();
  assert.equal(disposed, 1);
});

test("the session scope owns an explicitly marked subagent provider", async () => {
  let disposed = 0;
  let capturedProvider: SubagentProvider | undefined;
  const provider: SubagentProvider = {
    name: "owned-test-provider",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    run: async () => {
      throw new Error("not used");
    },
    dispose: () => {
      disposed += 1;
    },
  };
  const { handle } = createAgentSessionWithStorage({
    sessionId: "session-owned-subagent-provider",
    config: {
      provider: "test",
      model: "test",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      subagentProvider: provider,
      ownedSubagentProvider: true,
      tools: { registry: { list: () => [] } as never },
    },
    __configure: ({ dependencies }) => {
      capturedProvider = dependencies.scope?.services.subagentProvider;
    },
    __agentLoopFactory: () => {
      return {
        snapshotFileState: () => ({}),
        async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          throw new Error("not used");
        },
      };
    },
  });

  assert.equal(capturedProvider, provider);
  await handle.dispose();
  assert.equal(disposed, 1);
});

test("the session composition selects a native subagent provider by default", async () => {
  let capturedProvider: unknown;
  const { handle } = createAgentSessionWithStorage({
    sessionId: "session-default-subagent-provider",
    config: {
      provider: "test",
      model: "test",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      tools: { registry: { list: () => [] } as never },
    },
    __configure: ({ dependencies }) => {
      capturedProvider = dependencies.scope?.services.subagentProvider;
    },
    __agentLoopFactory: () => {
      return {
        snapshotFileState: () => ({}),
        async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          throw new Error("not used");
        },
      };
    },
  });

  assert.equal(typeof (capturedProvider as { start?: unknown } | undefined)?.start, "function");
  await handle.dispose();
});

test("AgentSession reads cumulative usage and permission denials from the live projection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-agent-session-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "session-projected-summary",
  });
  const priorDenial: AgentPermissionDenial = {
    toolName: "write_file",
    toolCallId: "prior-denial",
    errorCode: "denied",
  };
  await storage.events.append("session-projected-summary", "turn-prior", {
    type: "accepted_input",
    messages: [{ role: "user", content: [{ type: "text", text: "prior prompt" }] }],
  });
  await storage.events.append("session-projected-summary", "turn-prior", {
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
  });
  await storage.events.append("session-projected-summary", "turn-prior", {
    type: "session_metadata",
    metadata: { title: "Prior title", firstPrompt: "prior prompt", lastPrompt: "prior prompt" },
  });
  await storage.events.append("session-projected-summary", "turn-prior", {
    type: "turn_result",
    result: {
      type: "success",
      sessionId: "session-projected-summary",
      turnId: "turn-prior",
      stopReason: "completed",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      permissionDenials: [priorDenial],
      turns: 1,
      startedAt: "2026-09-06T00:00:00.000Z",
      completedAt: "2026-09-06T00:00:00.001Z",
    },
  });

  const currentDenial: AgentPermissionDenial = {
    toolName: "shell",
    toolCallId: "current-denial",
    errorCode: "denied",
  };
  const { session, handle } = createAgentSessionWithStorage({
    sessionId: "session-projected-summary",
    config: {
      provider: "test",
      model: "test",
      cwd: root,
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        cwd: root,
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
    dependencies: {
      router: {} as never,
      tools: { registry: { list: () => [] } as never },
    },
    storage,
    initialState: {
      sessionId: "session-projected-summary",
      messages: [{ role: "user", content: [{ type: "text", text: "stale legacy state" }] }],
      usage: { totalTokens: 999 },
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    },
    __agentLoopFactory: () => ({
      snapshotFileState: () => ({}),
      async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        assert.deepEqual(options.messages.map((message) => message.content[0]), [
          { type: "text", text: "prior prompt" },
          { type: "text", text: "prior answer" },
          { type: "text", text: "continue" },
        ]);
        const currentAssistant = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "current answer" }],
        };
        await options.onDurableMessage?.(currentAssistant);
        const result: AgentLoopRunResult = {
          result: {
            type: "success",
            sessionId: options.sessionId,
            turnId: options.turnId,
            stopReason: "completed",
            usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
            permissionDenials: [currentDenial],
            turns: 1,
            startedAt: "2026-09-06T00:00:01.000Z",
            completedAt: "2026-09-06T00:00:01.001Z",
          },
          messages: [...options.messages, currentAssistant],
        };
        yield {
          type: "turn_completed",
          sessionId: options.sessionId,
          turnId: options.turnId,
          result: result.result,
        };
        return result;
      },
    }),
  });

  assert.deepEqual(session.snapshot().usage, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    totalTokens: 5,
  });
  assert.deepEqual(session.snapshot().permissionDenials, [priorDenial]);
  assert.deepEqual(session.snapshot().messages.map((message) => message.content[0]), [
    { type: "text", text: "prior prompt" },
    { type: "text", text: "prior answer" },
  ]);
  assert.deepEqual(session.snapshotForRuntimeReload().metadata, {
    title: "Prior title",
    firstPrompt: "prior prompt",
    lastPrompt: "prior prompt",
    linkedPullRequest: undefined,
  });

  for await (const _event of session.submit({ type: "text", text: "continue" }, { turnId: "turn-current" })) {
    // Drain the turn so the durable turn result reaches the projection.
  }

  assert.deepEqual(session.snapshot().usage, {
    inputTokens: 10,
    outputTokens: 6,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    totalTokens: 16,
  });
  assert.deepEqual(session.snapshot().permissionDenials, [priorDenial, currentDenial]);
  assert.deepEqual(session.snapshot().messages.map((message) => message.content[0]), [
    { type: "text", text: "prior prompt" },
    { type: "text", text: "prior answer" },
    { type: "text", text: "continue" },
    { type: "text", text: "current answer" },
  ]);
  assert.deepEqual(session.snapshotForRuntimeReload().state.usage, session.snapshot().usage);
  const reloadedMetadata = session.snapshotForRuntimeReload().metadata;
  assert.equal(reloadedMetadata?.title, "Prior title");
  assert.equal(reloadedMetadata?.firstPrompt, "prior prompt");
  assert.equal(reloadedMetadata?.lastPrompt, "continue");
  assert.equal(reloadedMetadata?.isSnapshot, true);
  assert.equal(typeof reloadedMetadata?.updatedAt, "string");
  await handle.dispose();
});
