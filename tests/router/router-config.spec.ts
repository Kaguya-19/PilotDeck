import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "../../src/router/config/parseRouterConfig.js";
import type { ModelConfig } from "../../src/model/index.js";

const modelConfig = {
  providers: {
    openai: {
      id: "openai",
      protocol: "openai",
      url: "https://example.test/v1",
      apiKey: "test",
      headers: {},
      models: {
        primary: { id: "primary", capabilities: {}, multimodal: { input: ["text"] } },
        judge: { id: "judge", capabilities: {}, multimodal: { input: ["text"] } },
      },
    },
  },
} as unknown as ModelConfig;

test("parseRouterConfig accepts disabled and partial router sections", () => {
  assert.deepEqual(parseRouterConfig(undefined, modelConfig), { diagnostics: [] });
  assert.deepEqual(parseRouterConfig({ enabled: false, scenarios: "ignored" }, modelConfig), {
    config: { enabled: false },
    diagnostics: [],
  });
  const partial = parseRouterConfig({ zeroUsageRetry: { enabled: false, maxAttempts: 0 } }, modelConfig);
  assert.equal(partial.config?.enabled, true);
  assert.deepEqual(partial.config?.zeroUsageRetry, { enabled: false, maxAttempts: 0 });
  assert.deepEqual(partial.diagnostics, []);
});

test("parseRouterConfig resolves refs and applies token saver/orchestration defaults", () => {
  const result = parseRouterConfig({
    scenarios: { default: "openai/primary" },
    fallback: { default: ["openai/judge"], maxFallbacks: 1, unknown: [] },
    tokenSaver: {
      judge: "openai/judge",
      tiers: { simple: { model: "openai/primary" } },
      defaultTier: "simple",
      subagent: { policy: "skip" },
    },
    autoOrchestrate: { enabled: true, allowedTools: [], blockedTools: ["bash"], triggerTiers: ["missing"] },
    stats: { enabled: true, baselineModel: "openai/primary" },
    customRouter: { extensionId: "plugin.router" },
  }, modelConfig);

  assert.equal(result.diagnostics.some((item) => item.code === "ROUTER_FALLBACK_UNKNOWN_SCENARIO"), true);
  assert.equal(result.diagnostics.some((item) => item.code === "ROUTER_AUTO_ORCHESTRATE_TOOLS_CONFLICT"), true);
  assert.equal(result.diagnostics.some((item) => item.code === "ROUTER_AUTO_ORCHESTRATE_TRIGGER_TIER_UNKNOWN"), true);
  assert.equal(result.config?.scenarios?.default.id, "openai/primary");
  assert.deepEqual(result.config?.autoOrchestrate?.allowedTools, []);
  assert.equal(result.config?.tokenSaver?.subagent?.policy, "skip");
  assert.equal(result.config?.customRouter?.extensionId, "plugin.router");
});

test("parseRouterConfig reports malformed values without throwing", () => {
  const result = parseRouterConfig({
    enabled: "yes",
    scenarios: { default: "missing/model" },
    zeroUsageRetry: { maxAttempts: -1 },
    fallback: { default: "not-array" },
    customRouter: {},
  }, modelConfig);

  assert.equal(result.config !== undefined, true);
  assert.ok(result.diagnostics.length >= 4);
  assert.equal(result.diagnostics.every((item) => item.severity === "fatal"), true);
});

test("parseRouterConfig exercises optional and invalid branch matrix", () => {
  const invalid = (raw: unknown) => parseRouterConfig(raw, modelConfig).diagnostics;
  assert.equal(invalid("router")[0]?.code, "ROUTER_CONFIG_INVALID");
  assert.equal(invalid({ scenarios: "bad" })[0]?.code, "ROUTER_SCENARIOS_INVALID");
  assert.equal(invalid({ fallback: "bad" })[0]?.code, "ROUTER_FALLBACK_INVALID");
  assert.equal(invalid({ fallback: { maxFallbacks: -1, default: "bad", unknown: [] } }).some((item) => item.code === "ROUTER_FALLBACK_MAX_FALLBACKS_INVALID"), true);
  assert.equal(invalid({ zeroUsageRetry: "bad" })[0]?.code, "ROUTER_ZERO_USAGE_RETRY_INVALID");
  assert.equal(invalid({ zeroUsageRetry: { maxAttempts: -1 } })[0]?.code, "ROUTER_ZERO_USAGE_RETRY_MAX_ATTEMPTS_INVALID");
  assert.equal(invalid({ tokenSaver: "bad" })[0]?.code, "ROUTER_TOKEN_SAVER_INVALID");
  assert.equal(invalid({ tokenSaver: { judge: "openai/judge", tiers: {} } }).some((item) => item.code === "ROUTER_TOKEN_SAVER_TIERS_EMPTY"), true);
  assert.equal(invalid({ tokenSaver: { judge: "openai/judge", tiers: { bad: 1 } } })[0]?.code, "ROUTER_TOKEN_SAVER_TIER_INVALID");
  assert.equal(invalid({ tokenSaver: { judge: "openai/judge", tiers: { bad: { model: "bad" } } } }).some((item) => item.code === "ROUTER_REF_FORMAT"), true);
  assert.equal(invalid({ autoOrchestrate: "bad" })[0]?.code, "ROUTER_AUTO_ORCHESTRATE_INVALID");
  assert.equal(invalid({ autoOrchestrate: { triggerTiers: [1], allowedTools: [1], blockedTools: [1], subagentMaxTokens: 0 } }).some((item) => item.code === "ROUTER_AUTO_ORCHESTRATE_TRIGGER_TIERS_INVALID"), true);
  assert.equal(invalid({ stats: "bad" })[0]?.code, "ROUTER_STATS_INVALID");
  assert.equal(invalid({ stats: { modelPricing: "bad" } })[0]?.code, "ROUTER_STATS_PRICING_INVALID");
  assert.equal(invalid({ customRouter: {} })[0]?.code, "ROUTER_CUSTOM_ROUTER_INVALID");

  const valid = parseRouterConfig({
    fallback: { maxFallbacks: 0, default: ["openai/primary"] },
    zeroUsageRetry: { enabled: true, maxAttempts: 3 },
    tokenSaver: {
      enabled: false,
      judge: "openai/judge",
      tiers: { medium: { model: "openai/primary" }, other: { model: "openai/judge", description: "other" } },
      defaultTier: "missing",
      rules: ["rule"],
      subagent: { policy: "judge" },
      judgeTimeoutMs: 100,
      cacheAwareSwitching: { enabled: false, minSavingsRatio: 0.25 },
    },
    autoOrchestrate: {
      enabled: false,
      mainAgentModel: "deprecated",
      subagentModel: "deprecated",
      triggerTiers: ["medium"],
      blockedTools: ["bash"],
      slimSystemPrompt: false,
      skillExtensionId: "skill",
      orchestrationPrompt: "prompt",
      subagentMaxTokens: 100,
    },
    stats: { enabled: false, modelPricing: { "openai/primary": { input: 1, output: 2, cacheRead: 3 }, ignored: 1 }, baselineModel: "openai/primary" },
    customRouter: { extensionId: "router" },
  }, modelConfig);
  assert.equal(valid.config?.tokenSaver?.defaultTier, "medium");
  assert.deepEqual(valid.config?.tokenSaver?.rules, ["rule"]);
  assert.equal(valid.config?.autoOrchestrate?.blockedTools?.[0], "bash");
  assert.equal(valid.config?.stats?.modelPricing?.["openai/primary"]?.cacheRead, 3);
  assert.equal(valid.diagnostics.filter((item) => item.code === "ROUTER_AUTO_ORCHESTRATE_DEPRECATED_FIELD").length, 2);
});
