import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { buildCachePlan, type CachePlanInput } from "../../src/context/cache/CachePlan.js";
import { PromptCacheCoordinator } from "../../src/context/cache/PromptCacheCoordinator.js";
import type { PromptCacheCoordinatorPort } from "../../src/context/cache/PromptCacheCoordinatorPort.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";

const cacheInput: CachePlanInput = {
  provider: "anthropic",
  model: "claude-test",
  systemPrompt: "system",
  tools: [],
  messages: [{ role: "user", content: [{ type: "text", text: "request" }] }],
  enabled: true,
};

test("PromptCacheCoordinator owns stable per-session generations and consumes disabled reset markers", () => {
  const coordinator = new PromptCacheCoordinator();
  assert.equal(coordinator.createPlan("cache-session", cacheInput)?.generation, 1);
  assert.equal(coordinator.createPlan("cache-session", cacheInput)?.generation, 1);

  coordinator.reset("cache-session");
  assert.equal(coordinator.createPlan("cache-session", { ...cacheInput, enabled: false }), undefined);
  assert.equal(
    coordinator.createPlan("cache-session", cacheInput)?.generation,
    1,
    "a disabled materialization consumes the pending reset just as the legacy runtime did",
  );

  coordinator.reset("cache-session");
  assert.equal(coordinator.createPlan("cache-session", cacheInput)?.generation, 2);
  assert.equal(
    coordinator.createPlan("cache-session", {
      ...cacheInput,
      messages: [{ role: "user", content: [{ type: "text", text: "changed" }] }],
    })?.generation,
    3,
  );
});

test("PromptCacheCoordinator releases session-local generations and pending resets", () => {
  const coordinator = new PromptCacheCoordinator();
  assert.equal(coordinator.createPlan("released-session", cacheInput)?.generation, 1);
  coordinator.reset("released-session");
  coordinator.release("released-session");

  assert.equal(
    coordinator.createPlan("released-session", cacheInput)?.generation,
    1,
    "a recreated session starts with no prior generation or reset marker",
  );
});

test("DefaultContextRuntime delegates cache-plan materialization to an injected coordinator", async () => {
  const calls: string[] = [];
  const coordinator: PromptCacheCoordinatorPort = {
    createPlan: (sessionId, input) => {
      calls.push(`create:${sessionId}`);
      return buildCachePlan(input, 42);
    },
    reset: (sessionId) => { calls.push(`reset:${sessionId}`); },
    release: (sessionId) => { calls.push(`release:${sessionId}`); },
  };
  const runtime = new DefaultContextRuntime({ promptCacheCoordinator: coordinator });
  const result = await runtime.prepareForModel(contextInput());

  assert.equal(result.cachePlan?.generation, 42);
  assert.deepEqual(calls, ["create:cache-session"]);
  runtime.dispose();
  assert.deepEqual(calls, ["create:cache-session", "release:cache-session"]);
});

function contextInput(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return {
    sessionId: "cache-session",
    turnId: "cache-turn",
    cwd: "/workspace",
    provider: "anthropic",
    model: "claude-test",
    protocol: "anthropic",
    supportsPromptCache: true,
    permissionMode: "default",
    runMode: "agent",
    additionalWorkingDirectories: [],
    messages: [{ role: "user", content: [{ type: "text", text: "request" }] }],
    tools: [],
    ...overrides,
  };
}
