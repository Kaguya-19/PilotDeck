import assert from "node:assert/strict";
import test from "node:test";
import { NetworkFetchError } from "../../../src/network/fetch.js";
import { normalizeModelError } from "../../../src/model/errors/normalizeModelError.js";

function codeFor(message: string): string {
  return normalizeModelError("test", "openai", new Error(message)).code;
}

test("normalizeModelError classifies common network failures", () => {
  assert.equal(codeFor("getaddrinfo ENOTFOUND api.test"), "dns_error");
  assert.equal(codeFor("read ECONNRESET"), "connection_reset");
  assert.equal(codeFor("connect ECONNREFUSED 127.0.0.1:443"), "connection_refused");
  assert.equal(codeFor("certificate has expired"), "tls_error");
  assert.equal(codeFor("proxy CONNECT failed"), "proxy_error");
});

test("normalizeModelError marks unsupported image model errors as image-strip recoverable", () => {
  for (const message of [
    "g9v3-39a5b is not a multimodal model",
    "This model does not support image input",
    "Vision input is not supported",
  ]) {
    const error = normalizeModelError("test", "openai", new Error(message), 400);
    assert.equal(error.recoverableViaImageStrip, true, message);
  }
});

test("normalizeModelError maps invalid API key messages to auth_error", () => {
  for (const message of [
    "invalid_api_key: the supplied key is invalid",
    "Incorrect API key provided",
  ]) {
    const error = normalizeModelError("test", "openai", new Error(message));
    assert.equal(error.code, "auth_error", message);
    assert.equal(error.retryable, false, message);
  }
});

test("normalizeModelError maps exhausted quota messages to billing", () => {
  for (const message of ["quota exhausted for this account", "quota_exhausted: monthly limit reached"]) {
    const error = normalizeModelError("test", "openai", new Error(message));

    assert.equal(error.code, "billing", message);
    assert.equal(error.retryable, false, message);
  }
});

test("rate-limit signals take precedence over exhausted quota", () => {
  for (const [message, status] of [
    ["rate limit: quota exhausted", 429],
    ["quota exhausted, retry later", undefined],
  ] as const) {
    const error = normalizeModelError("test", "openai", new Error(message), status);

    assert.equal(error.code, "rate_limit_error", message);
    assert.equal(error.retryable, true, message);
  }
});

test("specific request errors remain ahead of generic retry wording", () => {
  const error = normalizeModelError(
    "test",
    "openai",
    new Error("prompt is too long; retry after reducing the request"),
  );

  assert.equal(error.code, "prompt_too_long");
});

test("normalizeModelError covers provider network codes and preserves retry metadata", () => {
  const cases = [
    ["network_dns_error", "dns_error"],
    ["network_connection_reset", "connection_reset"],
    ["network_connection_refused", "connection_refused"],
    ["network_tls_error", "tls_error"],
    ["network_proxy_error", "proxy_error"],
    ["network_rate_limited", "rate_limit_error"],
    ["network_server_error", "server_error"],
    ["network_timeout", "timeout"],
    ["network_fetch_failed", "network_fetch_failed"],
  ] as const;
  for (const [sourceCode, expected] of cases) {
    const error = normalizeModelError("modelbest", "openai", new NetworkFetchError(sourceCode, sourceCode), 503);
    assert.equal(error.code, expected, sourceCode);
    assert.equal(error.retryable, true, sourceCode);
  }
  const retried = normalizeModelError("modelbest", "openai", new Error("try again in 1.5s"));
  assert.equal(retried.retryAfterMs, 1500);
});

test("normalizeModelError covers semantic codes, status fallback and recovery fields", () => {
  const cases = [
    ["input length and max_tokens exceed context limit", "prompt_too_long"],
    ["request too large", "request_too_large"],
    ["maximum output tokens exceeded", "max_output_reached"],
    ["image exceeds the provider limit", "image_too_large"],
    ["model not found", "model_not_found"],
    ["context length exceeded", "context_overflow"],
    ["request timeout", "timeout"],
  ] as const;
  for (const [message, expected] of cases) {
    const error = normalizeModelError("test", "anthropic", new Error(message));
    assert.equal(error.code, expected, message);
  }
  assert.equal(normalizeModelError("test", "openai", new Error("bad request"), 413).code, "payload_too_large");
  assert.equal(normalizeModelError("test", "openai", new Error("bad"), 401).code, "auth_error");
  assert.equal(normalizeModelError("test", "openai", new Error("bad"), 403).code, "auth_error");
  assert.equal(normalizeModelError("test", "openai", new Error("bad"), 404).code, "model_not_found");
  assert.equal(normalizeModelError("test", "openai", new Error("bad"), 500).code, "server_error");
  assert.equal(normalizeModelError("test", "openai", new Error("bad"), 418).code, "provider_error");
  assert.equal(normalizeModelError("test", "openai", new Error("bad"), 402).code, "billing");
  assert.equal(normalizeModelError("test", "openai", new Error("usage limit, retry later"), 402).code, "rate_limit_error");

  const overflow = normalizeModelError("test", "openai", new Error("maximum context length is 1000; prompt contains 700 tokens"));
  assert.equal(overflow.maxContextTokens, 1000);
  assert.equal(overflow.recoverableViaCompact, true);
  const output = normalizeModelError("test", "openai", new Error("range of max_tokens should be [1, 4096]"));
  assert.equal(output.maxOutputTokens, 4096);
  const image = normalizeModelError("test", "openai", new Error("image too large"));
  assert.equal(image.recoverableViaImageStrip, true);
});

test("normalizeModelError emits actionable hints and sanitizes provider payloads", () => {
  const hintedCodes = [
    "billing", "auth_error", "model_not_found", "context_overflow", "prompt_too_long",
    "image_too_large", "payload_too_large", "request_too_large", "rate_limit_error",
    "overloaded_error", "max_output_reached", "timeout", "server_error",
  ];
  for (const code of hintedCodes) {
    const error = normalizeModelError("demo", "openai", { code, message: code });
    assert.equal(typeof error.userHint, "string", code);
  }
  const html = normalizeModelError("demo", "openai", new Error("<!DOCTYPE html><title>Gateway failure</title>"));
  assert.equal(html.message, "Gateway failure");
  const htmlWithoutTitle = normalizeModelError("demo", "openai", new Error("<html><body>failure</body></html>"));
  assert.equal(htmlWithoutTitle.message, "Service temporarily unavailable (HTML error page returned).");
  const long = normalizeModelError("demo", "openai", new Error(" x\n".repeat(400)));
  assert.equal(long.message.length, 300);
  const nested = normalizeModelError("demo", "openai", { error: { message: "nested", type: "invalid_request" } });
  assert.equal(nested.message, "nested");
  assert.equal(nested.code, "invalid_request");
  const arrayError = normalizeModelError("demo", "openai", ["ignored", { message: "array message", code: "custom" }]);
  assert.equal(arrayError.message, "array message");
  assert.equal(arrayError.code, "custom");
 });
