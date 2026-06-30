import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_CATALOG } from "../../src/model/catalog/providers.js";

describe("provider catalog output token caps", () => {
  it("uses current DeepSeek V4 compatibility caps", () => {
    const models = PROVIDER_CATALOG.deepseek?.models;
    assert.equal(models?.["deepseek-v4-flash"]?.capabilities.maxContextTokens, 1_048_576);
    assert.equal(models?.["deepseek-v4-pro"]?.capabilities.maxContextTokens, 1_048_576);
    assert.equal(models?.["deepseek-chat"]?.capabilities.maxContextTokens, 1_048_576);
    assert.equal(models?.["deepseek-reasoner"]?.capabilities.maxContextTokens, 1_048_576);

    assert.equal(models?.["deepseek-v4-flash"]?.capabilities.maxOutputTokens, 384 * 1024);
    assert.equal(models?.["deepseek-v4-pro"]?.capabilities.maxOutputTokens, 384 * 1024);
    assert.equal(models?.["deepseek-chat"]?.capabilities.maxOutputTokens, 384 * 1024);
    assert.equal(models?.["deepseek-reasoner"]?.capabilities.maxOutputTokens, 384 * 1024);
  });

  it("keeps known high-output model caps in sync", () => {
    assert.equal(PROVIDER_CATALOG.openai?.models["gpt-4.1-mini"]?.capabilities.maxOutputTokens, 32_768);
    assert.equal(PROVIDER_CATALOG.openai?.models["o3-mini"]?.capabilities.maxOutputTokens, 100_000);
    assert.equal(PROVIDER_CATALOG.google?.models["gemini-3.1-pro-preview"]?.capabilities.maxOutputTokens, 65_536);
    assert.equal(PROVIDER_CATALOG.anthropic?.models["claude-sonnet-4.6"]?.capabilities.maxOutputTokens, 128_000);
  });
});
