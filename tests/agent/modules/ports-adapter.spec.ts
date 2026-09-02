import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { ModelInvokerPort, ToolPort } from "../../../src/agent/modules/index.js";
import type { CanonicalModelEvent } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";

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

function contextDependencies(ports: { model: ModelInvokerPort; tools: ToolPort }): AgentRuntimeDependencies {
  return {
    router: {} as AgentRuntimeDependencies["router"],
    ports,
    tools: {
      registry: { list: () => [] } as unknown as AgentRuntimeDependencies["tools"]["registry"],
      scheduler: { executeAll: async () => [] },
    },
    context: {
      prepareForModel: async (input) => ({
        messages: input.messages,
        systemPrompt: undefined,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      }),
      applyToolResults: async (input) => ({
        messages: [...input.messages, input.toolResultMessage],
        appendedMessages: [input.toolResultMessage],
        diagnostics: [],
      }),
    },
  };
}

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
  const loop = new AgentLoop(config, contextDependencies({ model, tools }));
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
  const loop = new AgentLoop(config, contextDependencies({ model, tools }));
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
