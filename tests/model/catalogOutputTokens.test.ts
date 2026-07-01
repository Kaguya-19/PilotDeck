import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_CATALOG } from "../../src/model/catalog/providers.js";
import { parseModelConfig } from "../../src/model/config/parseModelConfig.js";

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

  it("exposes DashScope and Zhipu OpenAI-compatible catalog defaults", () => {
    const dashscope = PROVIDER_CATALOG.dashscope;
    assert.equal(dashscope?.protocol, "openai");
    assert.equal(dashscope?.defaultUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    assert.equal(dashscope?.apiKeyEnvVar, "DASHSCOPE_API_KEY");
    assert.equal(dashscope?.models["qwen3.7-plus"]?.capabilities.supportsToolUse, true);
    assert.equal(dashscope?.models["qwen3.7-plus"]?.multimodal.input.includes("image"), true);
    assert.equal(dashscope?.models["qwen3.6-flash"]?.multimodal.input.includes("image"), false);
    assert.equal(dashscope?.models["qwen-max"]?.capabilities.maxOutputTokens, 2_000);
    assert.equal(dashscope?.models["qwen-plus"]?.capabilities.maxContextTokens, 131_072);
    assert.equal(dashscope?.models["qwen-turbo"]?.aliases.includes("qwen-turbo-latest"), true);

    const zhipu = PROVIDER_CATALOG.zhipu;
    assert.equal(zhipu?.protocol, "openai");
    assert.equal(zhipu?.defaultUrl, "https://api.z.ai/api/paas/v4");
    assert.equal(zhipu?.apiKeyEnvVar, "ZAI_API_KEY");
    assert.equal(zhipu?.models["glm-5.2"]?.capabilities.supportsThinking, true);
    assert.equal(zhipu?.models["glm-4.6"]?.capabilities.maxOutputTokens, 131_072);
    assert.equal(zhipu?.models["glm-4.7"]?.capabilities.maxContextTokens, 200_000);
    assert.equal(zhipu?.models["glm-4-plus"]?.capabilities.maxOutputTokens, 8_192);
    assert.equal(zhipu?.models["glm-4-flash-250414"]?.aliases.includes("GLM-4-Flash-250414"), true);
  });

  it("infers DashScope and Zhipu protocol and URLs from the catalog", () => {
    const config = parseModelConfig({
      providers: {
        dashscope: {
          apiKey: "${DASHSCOPE_API_KEY}",
          models: { "qwen3.7-max": {} },
        },
        zhipu: {
          apiKey: "${ZAI_API_KEY}",
          models: { "glm-5.2": {} },
        },
      },
    }, {
      env: {
        DASHSCOPE_API_KEY: "dashscope-key",
        ZAI_API_KEY: "zhipu-key",
      },
    });

    assert.equal(config.providers.dashscope?.protocol, "openai");
    assert.equal(config.providers.dashscope?.url, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    assert.equal(config.providers.dashscope?.apiKey, "dashscope-key");
    assert.equal(config.providers.dashscope?.models["qwen3.7-max"]?.capabilities.maxOutputTokens, 65_536);

    assert.equal(config.providers.zhipu?.protocol, "openai");
    assert.equal(config.providers.zhipu?.url, "https://api.z.ai/api/paas/v4");
    assert.equal(config.providers.zhipu?.apiKey, "zhipu-key");
    assert.equal(config.providers.zhipu?.models["glm-5.2"]?.capabilities.maxOutputTokens, 131_072);
  });
});
