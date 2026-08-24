import assert from "node:assert/strict";
import test from "node:test";

import { resolveRoutedModelMaxContextTokens } from "../../../src/agent/runtime/modelContextWindow.js";

test("resolveRoutedModelMaxContextTokens prefers the matching agent override", () => {
  let lookups = 0;
  const result = resolveRoutedModelMaxContextTokens({
    modelRuntime: { getCapabilities: () => { lookups += 1; return { maxContextTokens: 999 }; } },
    agentModel: { provider: "openai", model: "agent" },
    agentMaxContextTokens: 123,
    provider: "openai",
    model: "agent",
  });
  assert.equal(result, 123);
  assert.equal(lookups, 0);
});

test("resolveRoutedModelMaxContextTokens looks up a routed model when it differs", () => {
  const result = resolveRoutedModelMaxContextTokens({
    modelRuntime: { getCapabilities: (provider, model) => ({ maxContextTokens: provider === "anthropic" && model === "routed" ? 456 : 0 }) },
    agentModel: { provider: "openai", model: "agent" },
    agentMaxContextTokens: 123,
    provider: "anthropic",
    model: "routed",
  });
  assert.equal(result, 456);
});

test("resolveRoutedModelMaxContextTokens fails closed for unknown models", () => {
  const result = resolveRoutedModelMaxContextTokens({
    modelRuntime: { getCapabilities: () => { throw new Error("unknown model"); } },
    agentModel: { provider: "openai", model: "agent" },
    provider: "openai",
    model: "missing",
  });
  assert.equal(result, undefined);
});
