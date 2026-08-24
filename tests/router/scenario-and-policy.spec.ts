import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolSchema,
} from "../../src/model/index.js";
import { applyOrchestration } from "../../src/router/orchestrate/applyOrchestration.js";
import { generateJudgePrompt } from "../../src/router/tokenSaver/generateJudgePrompt.js";
import { SessionUsageCache } from "../../src/router/session/sessionUsageCache.js";
import { decideScenario } from "../../src/router/scenario/decideScenario.js";
import {
  detectSubagent,
  stripSubagentTagFromMessages,
} from "../../src/router/scenario/subagentDetector.js";

const agentTool: CanonicalToolSchema = {
  name: "agent",
  description: "delegate",
  inputSchema: { type: "object" },
};

function request(messages: CanonicalMessage[], tools?: CanonicalToolSchema[]): CanonicalModelRequest {
  return { provider: "main", model: "main-model", messages, tools };
}

function user(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

test("detectSubagent distinguishes main agent, missing agent tool and explicit tag", () => {
  const main = detectSubagent([user("hello")], [agentTool], true);
  assert.deepEqual(main, {
    isSubagent: false,
    modelHint: undefined,
    missingAgentTool: false,
    taggedInUserMessage: false,
  });

  const missingTool = detectSubagent([user("hello")], [{ ...agentTool, name: "read_file" }], true);
  assert.equal(missingTool.missingAgentTool, true);
  assert.equal(missingTool.isSubagent, true);

  const tagged = detectSubagent(
    [user("<pilotdeck-subagent-model>  fast-model  </pilotdeck-subagent-model> do this")],
    [agentTool],
    true,
  );
  assert.equal(tagged.isSubagent, true);
  assert.equal(tagged.modelHint, "fast-model");
  assert.equal(tagged.taggedInUserMessage, true);
});

test("detectSubagent uses the last matching user tag and ignores assistant text", () => {
  const messages: CanonicalMessage[] = [
    user("<ccr-subagent-model>first</ccr-subagent-model>"),
    { role: "assistant", content: [{ type: "text", text: "<ccr-subagent-model>ignored</ccr-subagent-model>" }] },
    user("<pilotdeck-subagent-model>second</pilotdeck-subagent-model>"),
  ];
  const result = detectSubagent(messages, undefined, true);
  assert.equal(result.modelHint, "second");
  assert.equal(result.missingAgentTool, false);
  assert.equal(result.taggedInUserMessage, true);
});

test("stripSubagentTagFromMessages only changes tagged user text", () => {
  const messages: CanonicalMessage[] = [
    user("prefix <pilotdeck-subagent-model>fast</pilotdeck-subagent-model>\n"),
    { role: "assistant", content: [{ type: "text", text: "<pilotdeck-subagent-model>keep</pilotdeck-subagent-model>" }] },
    { role: "user", content: [{ type: "image", source: "url", data: "https://example.test/a.png", mimeType: "image/png" }] },
  ];
  const stripped = stripSubagentTagFromMessages(messages);
  assert.deepEqual(stripped, [
    user("prefix"),
    messages[1],
    messages[2],
  ]);
  assert.notStrictEqual(stripped, messages);
  assert.strictEqual(stripped[1], messages[1]);
});

test("decideScenario resolves explicit, tagged subagent and default scenarios", () => {
  const scenarios = { default: { id: "main/default", provider: "main", model: "default" } };
  const explicit = decideScenario({
    request: request([user("hello")], [agentTool]),
    sessionId: "s1",
    isMainAgent: true,
    metadata: { explicitProvider: "override", explicitModel: "special" },
  }, scenarios);
  assert.deepEqual(explicit, {
    scenarioType: "explicit",
    selection: { id: "override/special", provider: "override", model: "special" },
    isSubagent: false,
  });

  const tagged = decideScenario({
    request: request([user("<ccr-subagent-model>small</ccr-subagent-model>")], [agentTool]),
    sessionId: "s1",
    isMainAgent: true,
  }, scenarios);
  assert.deepEqual(tagged, {
    scenarioType: "subagent",
    selection: undefined,
    isSubagent: true,
    subagentModelHint: "small",
  });

  const defaultSubagent = decideScenario({
    request: request([user("do it")], [agentTool]),
    sessionId: "s1",
    isMainAgent: false,
  }, scenarios);
  assert.deepEqual(defaultSubagent, {
    scenarioType: "default",
    selection: scenarios.default,
    isSubagent: true,
    subagentModelHint: undefined,
  });
});

test("SessionUsageCache ignores missing usage, refreshes LRU order and evicts oldest", () => {
  const cache = new SessionUsageCache(2);
  const first = { inputTokens: 1, totalTokens: 1 };
  const second = { inputTokens: 2, totalTokens: 2 };
  const third = { inputTokens: 3, totalTokens: 3 };
  cache.observe("ignored", undefined);
  assert.equal(cache.get("ignored"), undefined);

  cache.observe("s1", first);
  cache.observe("s2", second);
  cache.observe("s1", { ...first, outputTokens: 4 });
  cache.observe("s3", third);
  assert.equal(cache.get("s1")?.outputTokens, 4);
  assert.equal(cache.get("s2"), undefined);
  assert.deepEqual(cache.get("s3"), third);

  cache.clear();
  assert.equal(cache.get("s1"), undefined);
  assert.equal(cache.get("s3"), undefined);
});

function orchestrationConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    triggerTiers: ["complex"],
    slimSystemPrompt: true,
    ...overrides,
  } as Parameters<typeof applyOrchestration>[0]["config"];
}

test("applyOrchestration enforces enabled, main-agent and trigger-tier gates", () => {
  assert.deepEqual(applyOrchestration({
    config: orchestrationConfig({ enabled: false }),
    isMainAgent: true,
    tier: "complex",
  }), { mutations: {}, applied: false });
  assert.deepEqual(applyOrchestration({
    config: orchestrationConfig(),
    isMainAgent: false,
    tier: "complex",
  }), { mutations: {}, applied: false });
  assert.deepEqual(applyOrchestration({
    config: orchestrationConfig(),
    isMainAgent: true,
    tier: "simple",
  }), { mutations: {}, applied: false });

  assert.deepEqual(applyOrchestration({
    config: orchestrationConfig(),
    isMainAgent: true,
    tier: "complex",
  }), {
    applied: true,
    mutations: { orchestrationActivated: { tier: "complex", continued: false } },
  });
});

test("already orchestrating continues even when the new tier is outside trigger tiers", () => {
  assert.deepEqual(applyOrchestration({
    config: orchestrationConfig(),
    isMainAgent: true,
    tier: "simple",
    alreadyOrchestrating: true,
  }), {
    applied: true,
    mutations: { orchestrationActivated: { tier: "simple", continued: true } },
  });
});

test("generateJudgePrompt includes tier descriptions, rules and continuation policy", () => {
  const prompt = generateJudgePrompt({
    userMessage: "继续处理这个任务",
    previousTier: "reasoning",
    config: {
      enabled: true,
      judge: { id: "judge/model", provider: "judge", model: "model" },
      defaultTier: "medium",
      judgeTimeoutMs: 1000,
      tiers: {
        simple: { model: { id: "a/simple", provider: "a", model: "simple" }, description: "短问题" },
        reasoning: { model: { id: "a/reasoning", provider: "a", model: "reasoning" } },
      },
      rules: ["复杂任务使用 reasoning"],
    },
  });
  assert.match(prompt, /- simple: 短问题/);
  assert.match(prompt, /- reasoning\n/);
  assert.match(prompt, /Routing rules:\n- 复杂任务使用 reasoning/);
  assert.match(prompt, /previous turn was classified as: \*\*reasoning\*\*/);
  assert.match(prompt, /<tier>reasoning<\/tier>/);
  assert.match(prompt, /继续处理这个任务/);
  assert.match(prompt, /Default tier when uncertain: medium/);
});

test("generateJudgePrompt omits empty optional sections", () => {
  const prompt = generateJudgePrompt({
    userMessage: "hello",
    config: {
      enabled: true,
      judge: { id: "judge/model", provider: "judge", model: "model" },
      defaultTier: "simple",
      judgeTimeoutMs: 1000,
      tiers: { simple: { model: { id: "a/simple", provider: "a", model: "simple" } } },
    },
  });
  assert.doesNotMatch(prompt, /Routing rules:/);
  assert.doesNotMatch(prompt, /Continuation messages/);
});
