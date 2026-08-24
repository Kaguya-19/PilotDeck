import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import { createAgentSession, createAgentSessionWithStorage } from "../../../src/agent/session/createAgentSession.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies, AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../../src/model/index.js";

const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

function config(): AgentRuntimeConfig {
  return {
    provider: "openai",
    model: "test-model",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
}

function dependencies(options: { drainEvents?: () => never[]; scheduler?: AgentRuntimeDependencies["tools"]["scheduler"] } = {}): AgentRuntimeDependencies {
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "request_started", provider: "openai", model: "test-model" };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };
  return {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: options.scheduler ?? { executeAll: async () => [] },
    },
    tokenAccounting: {
      evaluateRequestBudget: async () => ({
        used: 1,
        displayUsed: 1,
        budgetUsed: 1,
        total: 32_768,
        ratio: 0,
        state: "ok",
      }),
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
    ...(options.drainEvents ? { drainEvents: options.drainEvents } : {}),
    uuid: () => "turn-fixed",
    now: () => new Date("2026-08-23T00:00:00.000Z"),
  };
}

test("createAgentSession wires the default event buffer and produces a usable session", async () => {
  const session = createAgentSession({ sessionId: "session-default", config: config(), dependencies: dependencies() });
  assert.equal(session.snapshot().sessionId, "session-default");
  assert.equal(session.snapshot().status, "idle");

  const events = [];
  for await (const event of session.submit({ type: "text", text: "hello" })) events.push(event);
  assert.equal(events.at(-1)?.type, "session_ended");
  assert.equal(session.snapshot().messages.at(-1)?.role, "assistant");
  assert.equal(session.snapshotForRuntimeReload().cwd, "/workspace/project");
  assert.equal(session.snapshotForRuntimeReload().transcriptPath, "");
});

test("createAgentSessionWithStorage preserves injected scheduler, drainEvents and initial state", async () => {
  const drained: never[] = [];
  const providedScheduler = { executeAll: async () => [] } as AgentRuntimeDependencies["tools"]["scheduler"];
  const created = createAgentSessionWithStorage({
    sessionId: "session-injected",
    config: { ...config(), isSubagent: true },
    dependencies: dependencies({ drainEvents: () => drained, scheduler: providedScheduler }),
    initialState: {
      sessionId: "session-injected",
      messages,
      usage: { inputTokens: 4 },
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    },
    replayEvents: [{ type: "session_started", sessionId: "session-injected" }],
    collectFileArtifacts: false,
  });
  assert.equal(created.storage, undefined);
  assert.deepEqual(created.session.snapshot().usage, { inputTokens: 4 });
  const replay = [];
  for await (const event of created.session.replay()) replay.push(event);
  assert.deepEqual(replay, [{ type: "session_started", sessionId: "session-injected" }]);
  assert.equal(created.session.snapshotForRuntimeReload().state.sessionId, "session-injected");

  const persisted = createAgentSessionWithStorage({
    sessionId: "web:project=/workspace/project:default",
    config: config(),
    dependencies: dependencies(),
    projectStorage: { projectRoot: "/workspace/project", pilotHome: "/tmp/pilotdeck-home" },
    initialMetadata: { title: "Restored title", tag: "restored" },
  });
  assert.ok(persisted.storage);
  assert.match(persisted.storage?.transcriptPath ?? "", /web:project=-workspace-project:default\.jsonl$/);
  assert.deepEqual(persisted.session.snapshotForRuntimeReload().metadata, {
    title: "Restored title",
    tag: "restored",
    linkedPullRequest: undefined,
  });
});
