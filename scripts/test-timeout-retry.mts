/**
 * Direct test: call complete() with mock-slow provider to verify
 * timeout detection, retry, and userHint generation.
 */
import { complete, streamModel } from "../src/model/streaming/streamModel.js";
import { normalizeModelError } from "../src/model/errors/normalizeModelError.js";
import type { ModelConfig } from "../src/model/protocol/canonical.js";

const config: ModelConfig = {
  providers: {
    "mock-slow": {
      id: "mock-slow",
      protocol: "openai",
      url: "http://127.0.0.1:9999/v1",
      apiKey: "mock-key",
      timeoutMs: 3000, // 3s timeout, mock delays 8s → will timeout
      headers: {},
      retry: {
        requestMaxRetries: 2,
        baseDelayMs: 500,
      },
      models: {
        "mock-slow": {
          id: "mock-slow",
          capabilities: {
            supportsToolUse: false,
            supportsStreaming: true,
            supportsParallelToolCalls: false,
            supportsThinking: false,
            supportsJsonSchema: false,
            supportsSystemPrompt: true,
            supportsPromptCache: false,
            maxContextTokens: 8192,
            maxOutputTokens: 4096,
          },
          multimodal: { input: ["text"] },
        },
      },
    },
  },
};

console.log("=== Test 1: Non-streaming complete() with 3s timeout vs 8s delay ===");
console.log("Expected: timeout after 3s, retry 2 times, then throw with timeout code\n");

const start = Date.now();
try {
  const result = await complete(
    {
      model: "mock-slow",
      provider: "mock-slow",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    },
    config,
  );
  console.log("Unexpected success:", result);
} catch (error: any) {
  const elapsed = Date.now() - start;
  console.log(`Caught error after ${(elapsed / 1000).toFixed(1)}s:`);
  if (error.error) {
    const e = error.error;
    console.log(`  code:      ${e.code}`);
    console.log(`  message:   ${e.message}`);
    console.log(`  retryable: ${e.retryable}`);
    console.log(`  userHint:  ${e.userHint ?? "(none)"}`);
    if (e.settingsFix) {
      console.log(`  settingsFix: ${JSON.stringify(e.settingsFix)}`);
    }
  } else {
    console.log(`  ${error.message}`);
  }
}

console.log("\n=== Test 2: normalizeModelError on 'fetch failed' ===");
const err = normalizeModelError("mock-slow", "openai", new Error("fetch failed"), undefined);
console.log(`  code:      ${err.code}`);
console.log(`  retryable: ${err.retryable}`);
console.log(`  userHint:  ${err.userHint ?? "(none)"}`);

console.log("\n=== Test 3: normalizeModelError on 'ETIMEDOUT' ===");
const err2 = normalizeModelError("mock-slow", "openai", new Error("connect ETIMEDOUT 10.0.0.1:443"), undefined);
console.log(`  code:      ${err2.code}`);
console.log(`  retryable: ${err2.retryable}`);
console.log(`  userHint:  ${err2.userHint ?? "(none)"}`);

console.log("\n=== Test 4: normalizeModelError on 'socket hang up' ===");
const err3 = normalizeModelError("mock-slow", "openai", new Error("socket hang up"), undefined);
console.log(`  code:      ${err3.code}`);
console.log(`  retryable: ${err3.retryable}`);
console.log(`  userHint:  ${err3.userHint ?? "(none)"}`);

console.log("\nDone.");
process.exit(0);
