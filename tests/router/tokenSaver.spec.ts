import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { ModelProviderError, ModelRequestError } from "../../src/model/index.js";
import { classifyAndRoute } from "../../src/router/index.js";

test("records the normalized judge error when token-saver falls back", async () => {
  let attempts = 0;
  const judgeRuntime = {
    complete: async () => {
      attempts += 1;
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "auth_error",
        message: "API key rejected by the provider.",
        retryable: false,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result?.failure, {
    reason: "model_error",
    attempts: 1,
    code: "auth_error",
    message: "API key rejected by the provider.",
  });
});

test("retries a retryable judge provider error before falling back", async () => {
  let attempts = 0;
  const judgeRuntime = {
    complete: async () => {
      attempts += 1;
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "server_error",
        message: "Provider temporarily unavailable.",
        retryable: true,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(attempts, 3);
  assert.equal(result?.failure?.attempts, 3);
});

test("redacts credentials from a judge error before returning diagnostics", async () => {
  const judgeRuntime = {
    complete: async () => {
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "auth_error",
        message: "Authorization: Bearer super-secret-token apiKey=also-secret",
        retryable: false,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(
    result?.failure?.message,
    "Authorization: Bearer <redacted> apiKey=<redacted>",
  );
});

test("records a plain network error message when the judge request fails", async () => {
  const judgeRuntime = {
    complete: async () => {
      throw new TypeError("fetch failed");
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(result?.failure?.message, "fetch failed");
});

test("omits temperature for an Anthropic judge", async () => {
  let request: CanonicalModelRequest | undefined;
  const judgeRuntime = {
    getProviderProtocol: () => "anthropic",
    complete: async (nextRequest: CanonicalModelRequest) => {
      request = nextRequest;
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "<tier>medium</tier>" }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(result?.tier, "medium");
  assert.equal(request?.temperature, undefined);
});

test("omits temperature for an OpenAI-compatible judge", async () => {
  let request: CanonicalModelRequest | undefined;
  const judgeRuntime = {
    getProviderProtocol: () => "openai",
    complete: async (nextRequest: CanonicalModelRequest) => {
      request = nextRequest;
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "<tier>medium</tier>" }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(request?.temperature, undefined);
});

test("aborts the judge request when its classification timeout expires", async () => {
  let aborted = false;
  const judgeRuntime = {
    complete: async (_request: unknown, options?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(options.signal?.reason);
        }, { once: true });
      }),
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: { ...config(), judgeTimeoutMs: 500 },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(aborted, true);
  assert.deepEqual(result?.failure, {
    reason: "timeout",
    attempts: 1,
    code: "judge_timeout",
  });
});

test("token saver fails open when disabled, misconfigured, or missing a user message", async () => {
  const runtime = { complete: async () => ({ role: "assistant", content: [{ type: "text", text: "medium" }], finishReason: "stop" }) } as unknown as ModelRuntime;
  assert.equal(await classifyAndRoute({ config: { ...config(), enabled: false }, messages: [], judgeRuntime: runtime }), undefined);
  assert.equal(await classifyAndRoute({ config: { ...config(), defaultTier: "missing" }, messages: [], judgeRuntime: runtime }), undefined);
  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "assistant", content: [{ type: "text", text: "no user" }] }],
    judgeRuntime: runtime,
  });
  assert.deepEqual(result, {
    tier: "medium",
    selection: { id: "main/main-model", provider: "main", model: "main-model" },
    resolvedFrom: "default",
  });
});

test("token saver sends a canonical judge request and parses a successful tier", async () => {
  let request: CanonicalModelRequest | undefined;
  const result = await classifyAndRoute({
    config: config(),
    previousTier: "low",
    sessionId: "session",
    messages: [{ role: "user", content: [{ type: "text", text: "classify me" }] }],
    judgeRuntime: {
      complete: async (nextRequest: CanonicalModelRequest) => {
        request = nextRequest;
        return { role: "assistant", content: [{ type: "text", text: "<tier>medium</tier>" }], finishReason: "stop" };
      },
    } as unknown as ModelRuntime,
  });
  assert.equal(result?.resolvedFrom, "judge");
  assert.equal(request?.maxOutputTokens, 256);
  assert.deepEqual(request?.thinking, { enabled: false });
  assert.equal(request?.stream, false);
  assert.match(request?.messages[0]?.content[0]?.type === "text" ? request.messages[0].content[0].text : "", /classify me/);
});

test("token saver retries empty and malformed judge responses before parse fallback", async () => {
  for (const text of ["", "unknown-tier"]) {
    let attempts = 0;
    const result = await classifyAndRoute({
      config: config(),
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      judgeRuntime: {
        complete: async () => {
          attempts += 1;
          return { role: "assistant", content: [{ type: "text", text }], finishReason: "stop" };
        },
      } as unknown as ModelRuntime,
    });
    assert.equal(attempts, 3);
    assert.equal(result?.failureReason, "parse_error");
    assert.equal(result?.failure?.attempts, 3);
  }
});

test("token saver does not retry a local model request validation error", async () => {
  let attempts = 0;
  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime: {
      complete: async () => {
        attempts += 1;
        throw new ModelRequestError("unsupported_model", "judge model is unavailable");
      },
    } as unknown as ModelRuntime,
  });
  assert.equal(attempts, 1);
  assert.deepEqual(result?.failure, {
    reason: "model_error",
    attempts: 1,
    code: "unsupported_model",
    message: "judge model is unavailable",
  });
});

function config() {
  return {
    enabled: true,
    judge: { id: "judge-provider/judge-model", provider: "judge-provider", model: "judge-model" },
    defaultTier: "medium",
    judgeTimeoutMs: 5_000,
    tiers: {
      medium: { model: { id: "main/main-model", provider: "main", model: "main-model" } },
    },
  };
}
