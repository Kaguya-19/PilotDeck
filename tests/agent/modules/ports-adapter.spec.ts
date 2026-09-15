import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import {
  createAgentTurnCapabilities,
  createSidecarAgentTurnCapabilities,
} from "../../../src/agent/loop/AgentTurnCapabilities.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { ModelInvokerPort, ToolPort } from "../../../src/agent/modules/index.js";
import type { CanonicalModelEvent } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import type { LifecycleDispatchInput } from "../../../src/lifecycle/index.js";

const config: AgentRuntimeConfig = {
  provider: "openai",
  model: "test-model",
  cwd: "/workspace/project",
  maxContextTokens: 32_768,
  maxOutputTokens: 1_024,
  permissionMode: "bypassPermissions",
  permissionContext: createDefaultPermissionContext({
    cwd: "/workspace/project",
    mode: "bypassPermissions",
    canPrompt: false,
    bypassAvailable: true,
  }),
};

function contextDependencies(
  ports: { model: ModelInvokerPort; tools: ToolPort },
  onPrepare?: (input: Parameters<NonNullable<AgentRuntimeDependencies["context"]>["prepareForModel"]>[0]) => void,
): AgentRuntimeDependencies {
  return {
    router: {} as AgentRuntimeDependencies["router"],
    ports,
    tools: {
      registry: { list: () => [] } as unknown as AgentRuntimeDependencies["tools"]["registry"],
      scheduler: { executeAll: async () => [] },
    },
    context: {
      prepareForModel: async (input) => {
        onPrepare?.(input);
        return {
          messages: input.messages,
          systemPrompt: undefined,
          systemPromptParts: [],
          tools: input.tools,
          diagnostics: [],
          boundaries: [],
        };
      },
      applyToolResults: async (input) => ({
        messages: [...input.messages, input.toolResultMessage],
        appendedMessages: [input.toolResultMessage],
        diagnostics: [],
      }),
    },
  };
}

test("AgentLoop capability adapters expose only turn context and lifecycle dispatch", async () => {
  const marker = Symbol("runtime-marker");
  const context = {
    marker,
    async prepareForModel(this: { marker: symbol }, input: Parameters<NonNullable<AgentRuntimeDependencies["context"]>["prepareForModel"]>[0]) {
      assert.equal(this.marker, marker);
      return {
        messages: input.messages,
        systemPrompt: undefined,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      };
    },
    async recoverFromModelError(this: { marker: symbol }) {
      assert.equal(this.marker, marker);
      throw new Error("context failure");
    },
    dispose() {},
  } as unknown as NonNullable<AgentRuntimeDependencies["context"]>;
  const lifecycle = {
    marker,
    async dispatch(this: { marker: symbol }, input: LifecycleDispatchInput) {
      assert.equal(this.marker, marker);
      return { marker: input.event };
    },
    dispose() {},
    subscribeHookExecutionEvents() {},
  } as unknown as NonNullable<AgentRuntimeDependencies["lifecycle"]>;
  const capabilities = createAgentTurnCapabilities(config, {
    router: {} as AgentRuntimeDependencies["router"],
    tools: {
      registry: { list: () => [] } as never,
      scheduler: { executeAll: async () => [] },
    },
    context,
    lifecycle,
  });

  assert.ok(Object.isFrozen(capabilities.context));
  assert.notEqual(capabilities.context, context);
  assert.equal("dispose" in (capabilities.context ?? {}), false);
  assert.deepEqual(
    Object.keys(capabilities.context ?? {}).sort(),
    ["prepareForModel", "recoverFromModelError"],
  );
  const recover = capabilities.context?.recoverFromModelError;
  assert.ok(recover);
  await assert.rejects(recover({} as never), /context failure/);

  const dispatch = capabilities.hooks.lifecycle;
  assert.ok(Object.isFrozen(dispatch));
  assert.notEqual(dispatch, lifecycle);
  assert.deepEqual(Object.keys(dispatch ?? {}), ["dispatch"]);
  assert.deepEqual(await dispatch?.dispatch({ event: "session_start" } as never), {
    marker: "session_start",
  });
});

test("AgentLoop capability adapters expose consumer-specific ports and retain a read-only legacy view", () => {
  const permission = { async decide() { return { type: "allow" as const, reason: { type: "runtime" as const, message: "allowed" } }; } };
  const elicitation = { async askUser() { return { type: "cancelled" as const }; } };
  const planFileManager = {
    getPlanDirectoryPath: () => "/workspace/project/.pilotdeck/plans",
    resolvePlanFilePath: () => undefined,
    readPlanFile: () => undefined,
  };
  const planTodoManager = { forSession: () => ({}) } as never;
  const oneShot = { createForkApi: () => ({}) } as never;
  const goal = { forSession: () => ({}) } as never;
  const capabilities = createAgentTurnCapabilities(config, {
    router: {} as AgentRuntimeDependencies["router"],
    permission,
    elicitation,
    planFileManager,
    planTodoManager,
    oneShotSubagentPort: oneShot,
    goalManager: goal,
    tools: {
      registry: { list: () => [] } as never,
      scheduler: { executeAll: async () => [] },
    },
  });

  assert.ok(Object.isFrozen(capabilities.toolExecution));
  assert.ok(Object.isFrozen(capabilities.tools));
  assert.ok(Object.isFrozen(capabilities.model.metadata));
  assert.equal(capabilities.model.execution, capabilities.model.invoker);
  assert.equal(capabilities.model.budget, capabilities.model.tokenAccounting);
  assert.ok(Object.isFrozen(capabilities.interaction));
  assert.ok(Object.isFrozen(capabilities.planMode));
  assert.ok(Object.isFrozen(capabilities.subagent));
  assert.equal(capabilities.permission, permission);
  assert.equal(capabilities.interaction.elicitation, elicitation);
  assert.equal(capabilities.planMode.planFileManager, planFileManager);
  assert.equal(capabilities.planMode.planTodoManager, planTodoManager);
  assert.equal(capabilities.subagent.oneShot, oneShot);
  assert.equal(capabilities.goal, goal);
  assert.equal(capabilities.tools.port, capabilities.toolExecution);
  assert.equal(capabilities.tools.permission, capabilities.permission);
  assert.equal(capabilities.tools.elicitation, capabilities.interaction.elicitation);
  assert.equal(capabilities.tools.planFileManager, capabilities.planMode.planFileManager);
  assert.equal(capabilities.tools.oneShotSubagentPort, capabilities.subagent.oneShot);
});

test("AgentLoop capabilities accept an explicit model port without a router", async () => {
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream() {
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  };
  const capabilities = createAgentTurnCapabilities(config, {
    ports: { model, tools: { list: () => [], executeAll: async () => [] } },
  });
  assert.equal(capabilities.model.execution, model);
  assert.equal(capabilities.model.routing, undefined);
  const loop = new AgentLoop(config, capabilities);
  const run = loop.run({ sessionId: "s1", turnId: "t1", messages: [] });
  while (!(await run.next()).done) {}
});

test("sidecar capabilities compose explicit ports without a router or native auxiliary fallback", () => {
  const model: ModelInvokerPort = {
    async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
    async *stream() { yield { type: "message_end", finishReason: "stop" } as const; },
  };
  const tools: ToolPort = { list: () => [], executeAll: async () => [] };
  const routing = {
    stream: () => { throw new Error("sidecar must not call router fallback"); },
  };
  const capabilities = createSidecarAgentTurnCapabilities(config, {
    ports: { model, tools, routing },
  });
  assert.equal(capabilities.model.execution, model);
  assert.equal(capabilities.model.legacyAuxiliaryFallback, false);
  assert.equal(capabilities.model.auxiliary, undefined);
});

test("AgentLoop tool execution port preserves injected method binding", async () => {
  const marker = Symbol("tool-port");
  const tools = {
    marker,
    list(this: { marker: symbol }) {
      assert.equal(this.marker, marker);
      return [];
    },
    async executeAll(this: { marker: symbol }) {
      assert.equal(this.marker, marker);
      return [];
    },
  } satisfies ToolPort & { marker: symbol };
  const capabilities = createAgentTurnCapabilities(config, {
    router: {} as AgentRuntimeDependencies["router"],
    ports: { tools },
    tools: {
      registry: { list: () => [] } as never,
      scheduler: { executeAll: async () => [] },
    },
  });

  assert.deepEqual(capabilities.toolExecution.list(), []);
  await capabilities.toolExecution.executeAll([], {} as never, {} as never);
  assert.deepEqual(capabilities.tools.port.list(), []);
  await capabilities.tools.port.executeAll([], {} as never, {} as never);
});

test("AgentLoop budget view preserves TokenAccountingRuntime method binding", () => {
  const marker = Symbol("budget");
  const tokenAccounting = {
    marker,
    estimateRequestInput(this: { marker: symbol }) {
      assert.equal(this.marker, marker);
      return 1;
    },
    async evaluateRequestBudget(this: { marker: symbol }) {
      assert.equal(this.marker, marker);
      return {};
    },
  } as never;
  const capabilities = createAgentTurnCapabilities(config, {
    router: {} as AgentRuntimeDependencies["router"],
    tokenAccounting,
    tools: {
      registry: { list: () => [] } as never,
      scheduler: { executeAll: async () => [] },
    },
  });
  assert.equal(capabilities.model.budget?.estimateRequestInput({} as never), 1);
});

test("AgentLoop capability composition supplies a no-op context port when no runtime is provided", async () => {
  const capabilities = createAgentTurnCapabilities(config, {
    router: {} as AgentRuntimeDependencies["router"],
    tools: {
      registry: { list: () => [] } as never,
      scheduler: { executeAll: async () => [] },
    },
  });

  assert.ok(Object.isFrozen(capabilities.context));
  assert.equal(typeof capabilities.context.prepareForModel, "function");
  assert.equal(capabilities.context.tryAutoCompact, undefined);
  const prepared = await capabilities.context.prepareForModel({ messages: [], tools: [] } as never);
  assert.deepEqual(prepared.messages, []);
  assert.equal(prepared.diagnostics[0]?.code, "context_budget_not_enforced");

  const toolCall = { role: "assistant" as const, content: [{ type: "tool_call" as const, id: "call-1", name: "lookup", input: {} }] };
  const toolResult = { role: "user" as const, content: [{ type: "tool_result" as const, toolCallId: "call-1", content: [] }] };
  const pairSafe = await capabilities.context.prepareForModel({
    messages: [
      { role: "user", content: [{ type: "text", text: "old" }] },
      toolCall,
      toolResult,
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ],
    tools: [],
    maxMessages: 2,
  } as never);
  assert.deepEqual(pairSafe.messages, [toolCall, toolResult, { role: "user", content: [{ type: "text", text: "latest" }] }]);
  assert.deepEqual(pairSafe.boundaries, [{ type: "compact", retainedMessages: 2 }]);
  assert.equal(pairSafe.diagnostics[0]?.code, "context_truncated");
});

test("AgentLoop forwards the profile-selected runtime context surface to ContextRuntime", async () => {
  const surfaces: Array<string | undefined> = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const tools: ToolPort = { list: () => [], executeAll: async () => [] };
  const loop = AgentLoop.fromDependencies(
    { ...config, runtimeContextSurface: "user_message" },
    contextDependencies({ model, tools }, (input) => surfaces.push(input.runtimeContextSurface)),
  );

  for await (const _event of loop.run({
    sessionId: "session-context-surface",
    turnId: "turn-context-surface",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  })) {
    // Consume the complete turn.
  }

  assert.deepEqual(surfaces, ["user_message"]);
});

test("AgentLoop consumes an injected ModelInvokerPort and propagates host runId", async () => {
  const contexts: string[] = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream({ context }): AsyncIterable<CanonicalModelEvent> {
      contexts.push(context.runId);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "plugged" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
  const tools: ToolPort = { list: () => [], executeAll: async () => [] };
  const loop = AgentLoop.fromDependencies(config, contextDependencies({ model, tools }));
  const events = [];
  for await (const event of loop.run({
    sessionId: "session-port",
    turnId: "turn-port",
    execution: { runId: "host-run-1" },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  })) events.push(event);

  assert.deepEqual(contexts, ["host-run-1"]);
  assert.equal([...events].reverse().find((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop uses injected ToolPort for tool loops without changing result pairing", async () => {
  let modelCalls = 0;
  const toolRuns: string[] = [];
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls++;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "call-1", name: "lookup", input: {} } };
        yield { type: "message_end", finishReason: "tool_call" };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", finishReason: "stop" };
      }
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "lookup",
      description: "lookup",
      kind: "custom",
      inputSchema: { type: "object" },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: [{ type: "text", text: "value" }] }),
    }],
    async executeAll(calls, _context, execution) {
      toolRuns.push(`${execution.runId}:${calls[0]?.id}`);
      return [{
        type: "success",
        toolCallId: "call-1",
        toolName: "lookup",
        content: [{ type: "text", text: "value" }],
        startedAt: "2026-09-02T00:00:00.000Z",
        completedAt: "2026-09-02T00:00:00.001Z",
      }];
    },
  };
  const loop = AgentLoop.fromDependencies(config, contextDependencies({ model, tools }));
  const events = [];
  for await (const event of loop.run({
    sessionId: "session-tool-port",
    turnId: "turn-tool-port",
    execution: { runId: "host-run-2" },
    messages: [{ role: "user", content: [{ type: "text", text: "lookup" }] }],
  })) events.push(event);

  assert.deepEqual(toolRuns, ["host-run-2:call-1"]);
  assert.equal(modelCalls, 2);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
  assert.equal([...events].reverse().find((event) => event.type === "turn_completed")?.result.type, "success");
});

test("AgentLoop obtains one-shot delegation from the composition-bound port", async () => {
  const bindings: Array<{ sessionId: string; turnId: string; parentFiles: number }> = [];
  const oneShotSubagentPort = {
    createForkApi: (input: { sessionId: string; turnId: string; parentReadFileState?: Map<string, unknown> }) => {
      bindings.push({
        sessionId: input.sessionId,
        turnId: input.turnId,
        parentFiles: input.parentReadFileState?.size ?? 0,
      });
      return {
        depth: 0,
        maxSubagentDepth: 1,
        listDefinitions: () => [],
        isAllowedDefinition: () => true,
        fork: async () => ({
          markdown: "Scope: delegated\nResult: complete",
          usage: { totalTokens: 2 },
          turns: 1,
          durationMs: 3,
        }),
      };
    },
  };
  let modelCalls = 0;
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      modelCalls += 1;
      yield { type: "message_start", role: "assistant" };
      if (modelCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "delegate-1", name: "agent", input: {} } };
        yield { type: "message_end", finishReason: "tool_call" };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", finishReason: "stop" };
      }
    },
  };
  const tools: ToolPort = {
    list: () => [{
      name: "agent",
      description: "delegate",
      kind: "agent",
      inputSchema: { type: "object" },
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: [] }),
    }],
    async executeAll(calls, context) {
      assert.ok(context.subagent, "AgentLoop must provide the composition-bound delegation port");
      const report = await context.subagent.fork({
        definitionId: "explore",
        directive: "Inspect the boundary.",
        subagentId: "child-1",
      });
      return [{
        type: "success",
        toolCallId: calls[0]!.id,
        toolName: "agent",
        content: [{ type: "text", text: report.markdown }],
        startedAt: "2026-09-02T00:00:00.000Z",
        completedAt: "2026-09-02T00:00:00.001Z",
      }];
    },
  };
  const dependencies = {
    ...contextDependencies({ model, tools }),
    oneShotSubagentPort,
  };
  const loop = new AgentLoop(config, createAgentTurnCapabilities(config, dependencies));

  for await (const _event of loop.run({
    sessionId: "session-delegation-port",
    turnId: "turn-delegation-port",
    messages: [{ role: "user", content: [{ type: "text", text: "delegate" }] }],
  })) {
    // Consume the complete turn.
  }

  assert.deepEqual(bindings, [{
    sessionId: "session-delegation-port",
    turnId: "turn-delegation-port",
    parentFiles: 0,
  }]);
});
