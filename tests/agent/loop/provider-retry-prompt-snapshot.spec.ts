import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { ModelInvokerPort } from "../../../src/agent/modules/protocol.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { DefaultContextRuntime, PromptContributionRegistry } from "../../../src/context/index.js";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { streamModel } from "../../../src/model/streaming/streamModel.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";

test("native provider retry keeps the assembled prompt snapshot while registry changes wait for the next request", async () => {
  const contributions = new PromptContributionRegistry({ name: "retry-snapshot" });
  const v1 = contributions.registerSection({
    name: "policy",
    order: 1,
    text: "policy=v1",
  });
  const requestBodies: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
  let changedRegistry = false;
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBodies.push(JSON.parse(String(init?.body)) as typeof requestBodies[number]);
    if (!changedRegistry) {
      changedRegistry = true;
      v1.dispose();
      contributions.registerSection({
        name: "policy",
        order: 1,
        text: "policy=v2",
      });
      return new Response(JSON.stringify({ error: { message: "temporary unavailable" } }), { status: 503 });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } });
  };
  const modelConfig = parseModelConfig({
    providers: {
      test: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        retry: { streamMaxRetries: 1, baseDelayMs: 1 },
        models: { "test-model": {} },
      },
    },
  });
  const model: ModelInvokerPort = {
    async prepare({ request }) {
      return { request, provider: request.provider, model: request.model };
    },
    async *stream({ prepared }) {
      yield* streamModel(prepared.request, modelConfig, {
        fetch,
        retryPolicy: { decide: () => ({ maxRetries: 1, delayMs: 0 }) },
      });
    },
  };
  const loop = AgentLoop.fromDependencies(runtimeConfig(), {
    router: inertRouter(),
    context: new DefaultContextRuntime({ promptContributions: contributions }),
    ports: { model },
    tools: {
      registry: new ToolRegistry(),
      scheduler: { async executeAll() { return []; } },
    },
  });

  await run(loop, "turn-1");

  assert.equal(requestBodies.length, 2, "the first provider request is retried exactly once");
  assert.match(systemPrompt(requestBodies[0]), /policy=v1/);
  assert.match(systemPrompt(requestBodies[1]), /policy=v1/);
  assert.doesNotMatch(systemPrompt(requestBodies[1]), /policy=v2/);

  await run(loop, "turn-2");

  assert.equal(requestBodies.length, 3);
  assert.match(systemPrompt(requestBodies[2]), /policy=v2/);
});

async function run(loop: AgentLoop, turnId: string): Promise<void> {
  for await (const _event of loop.run({
    sessionId: "provider-retry-snapshot",
    turnId,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  })) {
    // Consume the complete turn so the next request has a separate admission.
  }
}

function systemPrompt(body: { messages?: Array<{ role?: string; content?: unknown }> }): string {
  const message = body.messages?.find((candidate) => candidate.role === "system");
  return typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);
}

function runtimeConfig(): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: "/workspace/project",
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
}

function inertRouter(): AgentRouterRuntime {
  return {
    invalidateSticky: () => ({ orchestrating: false }),
    async decide({ request }) {
      return {
        provider: request.provider,
        model: request.model,
        scenarioType: "default",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "explicit",
        mutations: {},
      };
    },
    async *execute() {
      yield { type: "message_end", finishReason: "stop" } as const;
    },
    async *stream() {
      yield { type: "message_end", finishReason: "stop" } as const;
    },
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };
}
