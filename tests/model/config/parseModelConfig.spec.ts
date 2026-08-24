import assert from "node:assert/strict";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";

test("catalog provider resolves api key from default env var when apiKey is omitted", () => {
  const config = parseModelConfig({
    providers: {
      openai: {
        models: { "gpt-4o-mini": {} },
      },
    },
  }, { env: { OPENAI_API_KEY: " sk-env " } });

  assert.equal(config.providers.openai.apiKey, "sk-env");
});

test("catalog provider resolves api key from default env var when apiKey is blank", () => {
  const config = parseModelConfig({
    providers: {
      google: {
        apiKey: "  ",
        models: { "gemini-2.0-flash": {} },
      },
    },
  }, { env: { GEMINI_API_KEY: " gemini-env " } });

  assert.equal(config.providers.google.apiKey, "gemini-env");
});

test("unknown custom models default to text-only input", () => {
  const config = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        models: { "text-model": {} },
      },
    },
  });

  assert.deepEqual(config.providers.custom.models["text-model"].multimodal.input, ["text"]);
});

test("custom providers do not infer image input from a cross-provider model name", () => {
  const config = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        models: { "gpt-4o-mini": {} },
      },
    },
  });

  assert.deepEqual(config.providers.custom.models["gpt-4o-mini"].multimodal.input, ["text"]);
});

test("custom models use explicitly configured image input", () => {
  const config = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        models: {
          "vision-model": {
            multimodal: { input: ["text", "image"] },
          },
        },
      },
    },
  });

  assert.deepEqual(
    config.providers.custom.models["vision-model"].multimodal.input,
    ["text", "image"],
  );
});

test("catalog models keep their catalog image capability when no override is set", () => {
  const config = parseModelConfig({
    providers: {
      openai: {
        apiKey: "test-key",
        models: { "gpt-4o-mini": {} },
      },
    },
  });

  assert.deepEqual(
    config.providers.openai.models["gpt-4o-mini"].multimodal.input,
    ["text", "image"],
  );
});

test("catalog model aliases keep their declared provider image capability", () => {
  const config = parseModelConfig({
    providers: {
      openai: {
        apiKey: "test-key",
        models: { "gpt-4o-2024-11-20": {} },
      },
    },
  });

  assert.deepEqual(
    config.providers.openai.models["gpt-4o-2024-11-20"].multimodal.input,
    ["text", "image"],
  );
});

function expectConfigError(input: unknown, code: string): void {
  assert.throws(() => parseModelConfig(input), (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
  });
}

test("parseModelConfig validates provider, model and URL boundaries", () => {
  expectConfigError(null, "invalid_model_config");
  expectConfigError({}, "missing_provider");
  expectConfigError({ providers: { custom: "bad" } }, "invalid_provider");
  expectConfigError({ providers: { custom: { models: { m: {} } } } }, "unsupported_protocol");
  expectConfigError({ providers: { custom: { protocol: "openai", models: { m: {} } } } }, "invalid_config_value");
  expectConfigError({ providers: { custom: { protocol: "openai", url: "not a url", apiKey: "x", models: { m: {} } } } }, "invalid_url");
  expectConfigError({ providers: { custom: { protocol: "openai", url: "https://api.test", apiKey: "x", models: {} } } }, "empty_models");
  expectConfigError({ providers: { custom: { protocol: "openai", url: "https://api.test", apiKey: "x", models: { m: "bad" } } } }, "invalid_model");
  expectConfigError({ providers: { custom: { protocol: "openai", url: "https://api.test", apiKey: "x", models: { m: { capabilities: [] } } } } }, "invalid_capabilities");
  expectConfigError({ providers: { custom: { protocol: "openai", url: "https://api.test", apiKey: "x", models: { m: { capabilities: { supportsThinking: "yes" } } } } } }, "invalid_capabilities");
  expectConfigError({ providers: { custom: { protocol: "openai", url: "https://api.test", apiKey: "x", models: { m: { capabilities: { maxContextTokens: 0 } } } } } }, "invalid_config_value");
  expectConfigError({ providers: { custom: { protocol: "openai", url: "https://api.test", apiKey: "x", models: { m: { multimodal: [] } } } } }, "invalid_multimodal");
  expectConfigError({ providers: { custom: { protocol: "openai", url: "https://api.test", apiKey: "x", models: { m: { multimodal: { input: ["video"] } } } } } }, "invalid_multimodal_input");
});

test("parseModelConfig applies advanced provider and model options", () => {
  const config = parseModelConfig({
    providers: {
      google: {
        protocol: "openai",
        apiKey: "key",
        models: {
          custom: {
            displayName: "Custom",
            aliases: ["c"],
            capabilities: {
              supportsThinking: false,
              supportsToolUse: false,
              contextWindow: 10_000,
              maxOutputTokens: 1_000,
            },
            multimodal: {
              input: ["text", "image"],
              maxImagesPerRequest: 2,
              maxImageBytes: 10,
              supportedImageMimeTypes: ["image/png"],
              maxPdfPages: 3,
              maxPdfBytes: 20,
              maxAudioSeconds: 4,
              imageDetail: "high",
            },
          },
        },
        headers: { "x-test": "yes" },
        extraBody: { stream_options: { include_usage: true } },
        timeoutMs: 5_000,
        retry: {
          requestMaxRetries: 1,
          streamMaxRetries: 2,
          streamIdleTimeoutMs: 3,
          maxStreamingDurationMs: 4,
          repeatedChunkLimit: 5,
          baseDelayMs: 6,
          maxDelayMs: 7,
          jitter: 0.2,
        },
      },
      ollama: {
        models: { llama: {} },
      },
    },
  });
  assert.equal(config.providers.google.url, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(config.providers.google.models.custom.displayName, "Custom");
  assert.deepEqual(config.providers.google.models.custom.aliases, ["c"]);
  assert.equal(config.providers.google.models.custom.capabilities.maxContextTokens, 10_000);
  assert.equal(config.providers.google.models.custom.capabilities.supportsThinking, false);
  assert.equal(config.providers.google.models.custom.multimodal.maxImagesPerRequest, 2);
  assert.equal(config.providers.google.models.custom.multimodal.imageDetail, "high");
  assert.equal(config.providers.google.retry?.jitter, 0.2);
  assert.equal(config.providers.google.headers["x-test"], "yes");
  assert.equal(config.providers.ollama.apiKey, "ollama");
});

test("parseModelConfig rejects malformed optional fields and retry values", () => {
  const base = {
    providers: {
      custom: { protocol: "openai", url: "https://api.test", apiKey: "x", models: { m: {} } },
    },
  };
  const variants: Array<[unknown, string]> = [
    [{ ...base, providers: { custom: { ...base.providers.custom, timeoutMs: 0 } } }, "invalid_config_value"],
    [{ ...base, providers: { custom: { ...base.providers.custom, headers: { bad: 1 } } } }, "invalid_config_value"],
    [{ ...base, providers: { custom: { ...base.providers.custom, retry: { baseDelayMs: -1 } } } }, "invalid_config_value"],
    [{ ...base, providers: { custom: { ...base.providers.custom, models: { m: { aliases: [1] } } } } }, "invalid_config_value"],
    [{ ...base, providers: { custom: { ...base.providers.custom, models: { m: { multimodal: { input: [], imageDetail: "bad" } } } } } }, "invalid_multimodal"],
    [{ ...base, providers: { custom: { ...base.providers.custom, models: { m: { multimodal: { input: "text" } } } } } }, "invalid_multimodal_input"],
    [{ ...base, providers: { custom: { ...base.providers.custom, models: { m: { multimodal: { input: ["text"], maxImagesPerRequest: 0 } } } } } }, "invalid_config_value"],
  ];
  for (const [input, code] of variants) expectConfigError(input, code);
});
