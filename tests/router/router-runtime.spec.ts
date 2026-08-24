import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
  ModelRuntimeOptions,
  ModelDefinition,
  MultimodalConstraints,
} from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type {
  RouterConfig,
  RouterModelRef,
} from "../../src/router/config/schema.js";
import type { RouterEvent } from "../../src/router/protocol/events.js";
import type { RouterDecision } from "../../src/router/protocol/decision.js";
import { SessionRouterStore } from "../../src/router/session/SessionRouterStore.js";
import { ModelRequestError } from "../../src/model/protocol/errors.js";

const caps = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: false,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: true,
  maxContextTokens: 128_000,
  maxOutputTokens: 64,
};

type ScriptItem = CanonicalModelEvent | { throw: Error };

function ref(id: string): RouterModelRef {
  const slash = id.indexOf("/");
  return { id, provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: ref("primary/main") },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    stats: { enabled: false },
    ...overrides,
  };
}

function request(
  provider = "primary",
  model = "main",
  messages: CanonicalModelRequest["messages"] = [{ role: "user", content: [{ type: "text", text: "hello" }] }],
): CanonicalModelRequest {
  return {
    provider,
    model,
    messages,
    tools: [{ name: "agent", inputSchema: { type: "object" } }],
    maxOutputTokens: 128,
    stream: true,
  };
}

function eventBus(): { events: RouterEvent[]; emit: (event: RouterEvent) => void } {
  const events: RouterEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

function fakeRuntime(
  scripts: Record<string, ScriptItem[][]>,
  modalities: Record<string, MultimodalConstraints> = {},
  completeResponse?: CanonicalModelResponse,
  completeError?: Error,
): { runtime: ModelRuntime; calls: CanonicalModelRequest[] } {
  const calls: CanonicalModelRequest[] = [];
  const remaining = new Map(Object.entries(scripts).map(([key, value]) => [key, [...value]]));
  const runtime: ModelRuntime = {
    async *stream(input: CanonicalModelRequest, _options?: ModelRuntimeOptions) {
      calls.push(input);
      const queue = remaining.get(`${input.provider}/${input.model}`) ?? [];
      const script = queue.shift() ?? [];
      remaining.set(`${input.provider}/${input.model}`, queue);
      for (const item of script) {
        if ("throw" in item) throw item.throw;
        yield item;
      }
    },
    async complete() {
      if (completeError) throw completeError;
      if (completeResponse) return completeResponse;
      throw new Error("complete is not used by RouterRuntime tests");
    },
    getCapabilities() {
      return caps;
    },
    getMultimodal(provider, model) {
      return modalities[`${provider}/${model}`] ?? { input: ["text", "image", "pdf", "audio"] };
    },
    getProviderProtocol() {
      return "openai";
    },
    getProviderBaseUrl(provider) {
      return `https://${provider}.invalid/v1`;
    },
  };
  return { runtime, calls };
}

function success(text = "ok"): ScriptItem[] {
  return [
    { type: "request_started", provider: "primary", model: "main" },
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text },
    { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
    { type: "message_end", finishReason: "stop" },
  ];
}

function providerError(code = "server_error", retryable = true): CanonicalModelEvent {
  return {
    type: "error",
    error: {
      provider: "primary",
      protocol: "openai",
      code,
      message: code,
      retryable,
    },
  };
}

async function collect(iterable: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("disabled RouterRuntime passes through model and preserves subagent identity", async () => {
  const { runtime, calls } = fakeRuntime({ "primary/main": [success()] });
  const router = createRouterRuntime({ enabled: false }, { modelRuntime: runtime });
  const decision = await router.decide({ request: request(), sessionId: "s", isMainAgent: false });
  assert.deepEqual(decision, {
    provider: "primary", model: "main", scenarioType: "default", isSubagent: true,
    orchestrating: false, resolvedFrom: "scenario", mutations: {},
  });
  const materialized = router.materializeRequest(decision, request());
  assert.equal(materialized.maxOutputTokens, 64);
  const streamed = await collect(router.execute(decision, request(), { sessionId: "s", turnId: "t" }));
  assert.equal(streamed.some((event) => event.type === "text_delta"), true);
  assert.equal(calls[0]?.provider, "primary");
  await router.shutdown();
});

test("decide honors explicit provider/model and records a decision event", async () => {
  const { runtime } = fakeRuntime({});
  const bus = eventBus();
  const router = createRouterRuntime(config(), { modelRuntime: runtime, events: bus, now: () => new Date(0) });
  const decision = await router.decide({
    request: request(), sessionId: "explicit", isMainAgent: true,
    metadata: { explicitProvider: "other", explicitModel: "fast" },
  });
  assert.equal(decision.provider, "other");
  assert.equal(decision.model, "fast");
  assert.equal(decision.scenarioType, "explicit");
  assert.equal(decision.resolvedFrom, "explicit");
  assert.equal(bus.events[0]?.type, "pilotdeck_router_decision");
  await router.shutdown();
});

test("decide strips subagent tag, resolves hinted model and persists sticky state", async () => {
  const { runtime } = fakeRuntime({});
  const router = createRouterRuntime(config(), { modelRuntime: runtime });
  const tagged = request("primary", "main", [{
    role: "user",
    content: [{ type: "text", text: "do it <pilotdeck-subagent-model>worker/deep</pilotdeck-subagent-model>" }],
  }]);
  const decision = await router.decide({ request: tagged, sessionId: "sub", isMainAgent: true });
  assert.equal(decision.provider, "worker");
  assert.equal(decision.model, "deep");
  assert.equal(decision.isSubagent, true);
  assert.equal(decision.mutations.subagentTagStripped, true);
  const applied = router.materializeRequest(decision, tagged);
  assert.equal(applied.messages[0]?.content[0]?.type, "text");
  assert.equal((applied.messages[0]?.content[0] as { text: string }).text, "do it");
  const sticky = router.invalidateSticky("sub");
  assert.equal(sticky.previousProvider, "worker");
  assert.equal(sticky.previousModel, "deep");
  await router.shutdown();
});

test("custom router selection wins and a custom failure falls back to scenario", async () => {
  const { runtime } = fakeRuntime({});
  const bus = eventBus();
  const registry = {
    lookupRouter: () => ({
      id: "custom",
      decide: async () => { throw new Error("custom unavailable"); },
    }),
  };
  const router = createRouterRuntime(config({ customRouter: { extensionId: "custom" } }), {
    modelRuntime: runtime, customRouterRegistry: registry, events: bus,
  });
  const decision = await router.decide({ request: request(), sessionId: "custom", isMainAgent: true });
  assert.equal(decision.provider, "primary");
  assert.equal(decision.resolvedFrom, "scenario");
  assert.equal(bus.events.some((event) => event.type === "pilotdeck_router_custom_failed"), true);
  await router.shutdown();

  const successRegistry = { lookupRouter: () => ({ id: "custom", decide: async () => ({ provider: "custom", model: "fast" }) }) };
  const customRouter = createRouterRuntime(config({ customRouter: { extensionId: "custom" } }), {
    modelRuntime: runtime, customRouterRegistry: successRegistry,
  });
  const customDecision = await customRouter.decide({ request: request(), sessionId: "custom-ok", isMainAgent: true });
  assert.deepEqual({ provider: customDecision.provider, model: customDecision.model, resolvedFrom: customDecision.resolvedFrom }, {
    provider: "custom", model: "fast", resolvedFrom: "custom",
  });
  await customRouter.shutdown();
});

test("token saver classifies once, then reuses the main-session sticky selection", async () => {
  const judge = fakeRuntime({}, {}, {
    role: "assistant",
    content: [{ type: "text", text: "<tier>simple</tier>" }],
    finishReason: "stop",
  });
  const tokenSaver = {
    enabled: true,
    judge: ref("judge/classifier"),
    defaultTier: "medium",
    tiers: {
      simple: { model: ref("cheap/fast") },
      medium: { model: ref("primary/main") },
    },
    judgeTimeoutMs: 500,
    subagent: { policy: "judge" as const },
  };
  const router = createRouterRuntime(config({ tokenSaver }), { modelRuntime: judge.runtime, judgeRuntime: judge.runtime });
  const first = await router.decide({ request: request(), sessionId: "tier", isMainAgent: true });
  assert.deepEqual({ provider: first.provider, model: first.model, tokenSaverTier: first.tokenSaverTier, resolvedFrom: first.resolvedFrom }, {
    provider: "cheap", model: "fast", tokenSaverTier: "simple", resolvedFrom: "tokenSaver",
  });
  const second = await router.decide({ request: request("primary", "main", [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ]), sessionId: "tier", isMainAgent: true });
  assert.equal(second.resolvedFrom, "tokenSaver");
  assert.equal(second.model, "fast");
  await router.shutdown();
});

test("cache-aware token saver records both keep and switch decisions", async () => {
  const judge = fakeRuntime({}, {}, {
    role: "assistant",
    content: [{ type: "text", text: "<tier>simple</tier>" }],
    finishReason: "stop",
  });
  const tokenSaver = {
    enabled: true,
    judge: ref("judge/classifier"),
    defaultTier: "medium",
    tiers: { simple: { model: ref("cheap/fast") }, medium: { model: ref("primary/main") } },
    judgeTimeoutMs: 500,
    cacheAwareSwitching: { enabled: true, minSavingsRatio: 0 },
  };
  const pricing = {
    "old/expensive": { input: 10, cacheRead: 0.1 },
    "cheap/fast": { input: 0.01 },
    "old/cheap": { input: 0.01, cacheRead: 0.001 },
  };
  const router = createRouterRuntime(config({ tokenSaver, stats: { enabled: false, modelPricing: pricing } }), {
    modelRuntime: judge.runtime, judgeRuntime: judge.runtime,
  });
  router.observeUsage("switch", { inputTokens: 1_000, cacheReadTokens: 900 });
  const switched = await router.decide({
    request: request("old", "expensive"), sessionId: "switch", isMainAgent: true,
    metadata: { previousProvider: "old", previousModel: "expensive" },
  });
  assert.equal(switched.mutations.cacheAwareSwitch?.action, "switched");

  router.observeUsage("keep", { inputTokens: 1_000, cacheReadTokens: 900 });
  const kept = await router.decide({
    request: request("old", "cheap"), sessionId: "keep", isMainAgent: true,
    metadata: { previousProvider: "old", previousModel: "cheap" },
  });
  assert.equal(kept.mutations.cacheAwareSwitch?.action, "kept_sticky");
  assert.equal(kept.model, "cheap");
  await router.shutdown();
});

test("token saver failure is observable and auto-orchestration applies its policy", async () => {
  const judge = fakeRuntime({}, {}, undefined, new ModelRequestError("judge_failed", "judge unavailable"));
  const bus = eventBus();
  const router = createRouterRuntime(config({
    tokenSaver: {
      enabled: true,
      judge: ref("judge/classifier"),
      defaultTier: "simple",
      tiers: { simple: { model: ref("primary/main") } },
      judgeTimeoutMs: 500,
    },
    autoOrchestrate: {
      enabled: true,
      triggerTiers: ["simple"],
      allowedTools: ["agent"],
      slimSystemPrompt: true,
      orchestrationPrompt: "plan only",
    },
  }), { modelRuntime: judge.runtime, judgeRuntime: judge.runtime, events: bus });
  const decision = await router.decide({ request: request(), sessionId: "orch", isMainAgent: true });
  assert.equal(decision.orchestrating, true);
  assert.equal(decision.mutations.subagentTagStripped, undefined);
  assert.equal(bus.events.some((event) => event.type === "pilotdeck_router_token_saver_failed"), true);
  await router.shutdown();
});

test("decide rejects a malformed subagent hint and missing default explicitly", async () => {
  const { runtime } = fakeRuntime({});
  const router = createRouterRuntime(config({ scenarios: undefined }), { modelRuntime: runtime });
  await assert.rejects(
    router.decide({ request: request("primary", "main", [{ role: "user", content: [{ type: "text", text: "<pilotdeck-subagent-model>invalid</pilotdeck-subagent-model>" }] }]), sessionId: "missing", isMainAgent: true }),
    /no default scenario configured/,
  );
  await router.shutdown();
});

test("decide reroutes media to a compatible fallback and records the mutation", async () => {
  const { runtime } = fakeRuntime(
    {},
    { "primary/main": { input: ["text"] }, "vision/model": { input: ["text", "image"] } },
  );
  const router = createRouterRuntime(config({ fallback: { default: [ref("vision/model")], maxFallbacks: 1 } }), { modelRuntime: runtime });
  const imageRequest = request("primary", "main", [{ role: "user", content: [{ type: "image", source: "base64", data: "AQ==", mimeType: "image/png" }] }]);
  const decision = await router.decide({ request: imageRequest, sessionId: "media", isMainAgent: true });
  assert.equal(decision.provider, "vision");
  assert.equal(decision.model, "model");
  assert.deepEqual(decision.mutations.mediaCapabilityRerouted, {
    required: ["image"], from: "primary/main", to: "vision/model",
  });
  await router.shutdown();
});

test("execute streams live content, clamps output tokens and records usage", async () => {
  const { runtime, calls } = fakeRuntime({ "primary/main": [success("hello")] });
  const router = createRouterRuntime(config(), { modelRuntime: runtime });
  const decision = await router.decide({ request: request(), sessionId: "stream", isMainAgent: true });
  const events = await collect(router.execute(decision, request(), { sessionId: "stream", turnId: "turn" }));
  assert.deepEqual(events.map((event) => event.type), ["request_started", "message_start", "text_delta", "usage", "message_end"]);
  assert.equal(calls[0]?.maxOutputTokens, 64);
  await router.shutdown();
});

test("execute hides failed primary attempt and uses the first fallback", async () => {
  const { runtime, calls } = fakeRuntime({
    "primary/main": [[providerError("server_error")]],
    "backup/fallback": [success("fallback")],
  });
  const bus = eventBus();
  const router = createRouterRuntime(config({ fallback: { default: [ref("backup/fallback")], maxFallbacks: 1 } }), { modelRuntime: runtime, events: bus });
  const decision = await router.decide({ request: request(), sessionId: "fallback", isMainAgent: true });
  const events = await collect(router.execute(decision, request(), { sessionId: "fallback", turnId: "turn" }));
  assert.equal(calls.length, 2);
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "fallback"), true);
  assert.equal(bus.events.some((event) => event.type === "pilotdeck_router_fallback"), true);
  await router.shutdown();
});

test("execute downgrades unsupported media before a text-only attempt", async () => {
  const { runtime, calls } = fakeRuntime({ "primary/main": [success()] }, { "primary/main": { input: ["text"] } });
  const router = createRouterRuntime(config(), { modelRuntime: runtime });
  const decision = await router.decide({ request: request(), sessionId: "unsupported", isMainAgent: true });
  const imageRequest = request("primary", "main", [{ role: "user", content: [{ type: "image", source: "base64", data: "AQ==", mimeType: "image/png" }] }]);
  const events = await collect(router.execute(decision, imageRequest, { sessionId: "unsupported", turnId: "turn" }));
  assert.equal(events.some((event) => event.type === "text_delta"), true);
  assert.equal(calls[0]?.messages[0]?.content[0]?.type, "text");
  assert.match((calls[0]?.messages[0]?.content[0] as { text: string }).text, /does not support image input/);
  await router.shutdown();
});

test("execute retries a transient pre-content error without exposing the failed attempt", async () => {
  const { runtime, calls } = fakeRuntime({
    "primary/main": [[providerError("server_error")], success("recovered")],
  });
  const bus = eventBus();
  const router = createRouterRuntime(config({
    transientRetry: { enabled: true, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  }), { modelRuntime: runtime, events: bus });
  const decision = await router.decide({ request: request(), sessionId: "retry", isMainAgent: true });
  const events = await collect(router.execute(decision, request(), { sessionId: "retry", turnId: "turn" }));
  assert.equal(calls.length, 2);
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "recovered"), true);
  assert.equal(bus.events.some((event) => event.type === "pilotdeck_router_transient_retry"), true);
  await router.shutdown();
});

test("execute retries a mid-stream rate limit with a continuation request", async () => {
  const { runtime, calls } = fakeRuntime({
    "primary/main": [
      [
        { type: "message_start", role: "assistant" },
        { type: "text_delta", text: "partial" },
        providerError("rate_limit_error"),
      ],
      success("continued"),
    ],
  });
  const bus = eventBus();
  const router = createRouterRuntime(config({ transientRetry: { enabled: true, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }), { modelRuntime: runtime, events: bus });
  const decision = await router.decide({ request: request(), sessionId: "mid", isMainAgent: true });
  const events = await collect(router.execute(decision, request(), { sessionId: "mid", turnId: "turn" }));
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("partial"))), true);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
  assert.equal(bus.events.some((event) => event.type === "pilotdeck_router_retry_progress"), true);
  await router.shutdown();
});

test("execute emits the final provider error and preserves framing when fallback is disabled", async () => {
  const { runtime } = fakeRuntime({ "primary/main": [[{ type: "request_started", provider: "primary", model: "main" }, providerError("auth_error", false)]] });
  const router = createRouterRuntime(config({ transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }), { modelRuntime: runtime });
  const decision = await router.decide({ request: request(), sessionId: "error", isMainAgent: true });
  const events = await collect(router.execute(decision, request(), { sessionId: "error", turnId: "turn" }));
  assert.deepEqual(events.map((event) => event.type), ["request_started", "error"]);
  assert.equal((events[1] as { error: { code: string } }).error.code, "auth_error");
  await router.shutdown();
});

test("execute canonicalizes a thrown network failure and enforces subagent token budget", async () => {
  const thrown = fakeRuntime({ "primary/main": [[{ throw: new Error("fetch failed") }]] });
  const router = createRouterRuntime(config({ autoOrchestrate: {
    enabled: true, triggerTiers: [], slimSystemPrompt: true, subagentMaxTokens: 1,
  } }), { modelRuntime: thrown.runtime });
  const decision = await router.decide({ request: request(), sessionId: "throw", isMainAgent: false });
  const subagentRequest = request("primary", "main", [{ role: "user", content: [{ type: "text", text: "This deliberately long subagent request exceeds the tiny token budget and must be rejected before model access." }] }]);
  const subagentDecision = await router.decide({ request: subagentRequest, sessionId: "throw", isMainAgent: false });
  const events = await collect(router.execute(subagentDecision, subagentRequest, { sessionId: "throw", turnId: "turn" }));
  assert.equal((events.find((event) => event.type === "error") as { error: { code: string } }).error.code, "subagent_budget_exceeded");
  await router.shutdown();

  const network = createRouterRuntime(config(), { modelRuntime: thrown.runtime });
  const networkDecision = await network.decide({ request: request(), sessionId: "network", isMainAgent: true });
  const networkEvents = await collect(network.execute(networkDecision, request(), { sessionId: "network", turnId: "turn" }));
  assert.equal((networkEvents.find((event) => event.type === "error") as { error: { code: string } }).error.code, "network_error");
  await network.shutdown();
});

test("execute stops before model access when the context is already aborted", async () => {
  const { runtime, calls } = fakeRuntime({ "primary/main": [success()] });
  const router = createRouterRuntime(config(), { modelRuntime: runtime });
  const decision = await router.decide({ request: request(), sessionId: "abort", isMainAgent: true });
  const controller = new AbortController();
  controller.abort("stop");
  const events = await collect(router.execute(decision, request(), { sessionId: "abort", turnId: "turn", abortSignal: controller.signal }));
  assert.deepEqual(events, []);
  assert.equal(calls.length, 0);
  await router.shutdown();
});

test("external session store survives shutdown and invalidateSticky preserves orchestration", async () => {
  const { runtime } = fakeRuntime({});
  const store = new SessionRouterStore({ now: () => 1 });
  store.set({ sessionId: "persist", isSubagent: false, tokenSaverTier: "complex", stickyProvider: "primary", stickyModel: "main", orchestrating: true, updatedAt: 1 });
  const router = createRouterRuntime(config(), { modelRuntime: runtime, sessionStore: store });
  const result = router.invalidateSticky("persist");
  assert.deepEqual(result, { previousTier: "complex", previousProvider: "primary", previousModel: "main", orchestrating: true });
  await router.shutdown();
  assert.equal(store.get("persist", false)?.orchestrating, true);
  assert.equal(store.get("persist", false)?.tokenSaverTier, "complex");
});
