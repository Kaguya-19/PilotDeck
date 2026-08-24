import assert from "node:assert/strict";
import test from "node:test";

import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import { CachedMicroCompactionEngine } from "../../src/context/compaction/CachedMicroCompactionEngine.js";
import { stripMultimediaFromMessages } from "../../src/context/compaction/stripMultimedia.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import { NullContextRuntime } from "../../src/context/NullContextRuntime.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";
import type { CanonicalMessage } from "../../src/model/index.js";

test("AutoCompactionPolicy maps normal, warning, and blocking snapshots", () => {
  const budget = new TokenBudgetManager();
  const policy = new AutoCompactionPolicy({ tokenBudget: budget });

  assert.equal(policy.evaluateSnapshot(budget.snapshotFromTokens(10, 100)).type, "skip");
  const warning = policy.evaluateSnapshot(budget.snapshotFromTokens(80, 100));
  assert.deepEqual({ type: warning.type, reason: warning.type === "trigger" ? warning.reason : undefined }, {
    type: "trigger",
    reason: "warning_threshold",
  });
  const blocking = policy.evaluateSnapshot(budget.snapshotFromTokens(90, 100));
  assert.deepEqual({ type: blocking.type, reason: blocking.type === "trigger" ? blocking.reason : undefined }, {
    type: "trigger",
    reason: "blocking_threshold",
  });
});

test("AutoCompactionPolicy evaluates reserved output against the prompt budget", () => {
  const policy = new AutoCompactionPolicy({ tokenBudget: new TokenBudgetManager() });
  const decision = policy.evaluate(
    [{ role: "user", content: [{ type: "text", text: "request" }] }],
    10,
    { reservedOutputTokens: 5 },
  );

  assert.equal(decision.type, "trigger");
  assert.equal(decision.snapshot.reservedOutputTokens, 5);
  assert.equal(decision.snapshot.maxContextTokens, 5);
  assert.equal(decision.reason, "blocking_threshold");
});

test("NullContextRuntime respects an input maxMessages larger than the transcript", async () => {
  const input = nullContextInput([
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
  ]);
  const result = await new NullContextRuntime({ maxMessages: 1 }).prepareForModel({
    ...input,
    maxMessages: 3,
  });

  assert.deepEqual(result.messages, input.messages);
  assert.deepEqual(result.boundaries, []);
  assert.equal(result.diagnostics[0]?.code, "context_budget_not_enforced");
});

test("NullContextRuntime moves a cut before tool-result-only and reference messages", async () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "request" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result_reference", toolCallId: "call-1", path: "/tmp/result", originalBytes: 10, preview: "result", hasMore: false }] },
    { role: "user", content: [{ type: "media_reference", toolCallId: "call-1", path: "/tmp/image", originalBytes: 10, preview: "image", hasMore: false, mimeType: "image/png", mediaType: "image" }] },
    { role: "user", content: [{ type: "text", text: "latest" }] },
  ];
  const result = await new NullContextRuntime().prepareForModel({
    ...nullContextInput(messages),
    maxMessages: 2,
  });

  assert.equal(result.messages[0]?.role, "assistant");
  assert.equal(result.messages[1]?.role, "user");
  assert.equal(result.messages[1]?.content[0]?.type, "tool_result_reference");
  assert.equal(result.messages[2]?.content[0]?.type, "media_reference");
});

test("CachedMicroCompactionEngine short-circuits disabled, non-Anthropic, and non-compactable input", () => {
  const messages = [{ role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "ask_user_question", input: {} }] }] as CanonicalMessage[];
  assert.deepEqual(new CachedMicroCompactionEngine().apply({ messages, provider: "anthropic" }), {
    cacheBreakpoints: [],
    eligibleToolCallIds: [],
    applied: false,
  });
  assert.deepEqual(new CachedMicroCompactionEngine({ enabled: true }).apply({ messages, provider: "openai" }), {
    cacheBreakpoints: [],
    eligibleToolCallIds: [],
    applied: false,
  });
  assert.deepEqual(new CachedMicroCompactionEngine({ enabled: true }).apply({ messages, provider: "anthropic" }), {
    cacheBreakpoints: [],
    eligibleToolCallIds: [],
    applied: false,
  });
});

test("CachedMicroCompactionEngine marks aged results and reports cache hits", () => {
  const messages: CanonicalMessage[] = [];
  for (let i = 0; i < 3; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_call", id: `call-${i}`, name: "read_file", input: {} }] });
    messages.push({ role: "user", content: [{ type: "tool_result", toolCallId: `call-${i}`, content: [{ type: "text", text: `result-${i}` }] }] });
  }
  const engine = new CachedMicroCompactionEngine({ enabled: true, liveThreshold: 1 });
  const result = engine.apply({ messages, provider: "Anthropic Messages", liveThreshold: 1 });

  assert.deepEqual(result.cacheBreakpoints, [0, 2]);
  assert.deepEqual(result.eligibleToolCallIds, ["call-0", "call-1", "call-2"]);
  assert.equal(result.applied, true);
  assert.equal(engine.validateCacheHit(undefined), false);
  assert.equal(engine.validateCacheHit({ cacheReadTokens: 0 }), false);
  assert.equal(engine.validateCacheHit({ cacheReadTokens: 12 }), true);
});

test("stripMultimediaFromMessages replaces top-level and nested media without mutating clean messages", () => {
  const clean: CanonicalMessage = { role: "assistant", content: [{ type: "text", text: "keep" }] };
  const media: CanonicalMessage = {
    role: "user",
    content: [
      { type: "text", text: "before" },
      { type: "image", source: "base64", data: "image", mimeType: "image/png" },
      { type: "pdf", source: "base64", data: "pdf", mimeType: "application/pdf", bytes: 3 },
      {
        type: "tool_result",
        toolCallId: "call-1",
        content: [
          { type: "image", source: "base64", data: "nested-image", mimeType: "image/png" },
          { type: "pdf", source: "base64", data: "nested-pdf", mimeType: "application/pdf", bytes: 3 },
          { type: "text", text: "nested text" },
        ],
      },
    ],
  };
  const result = stripMultimediaFromMessages([clean, media]);

  assert.equal(result[0], clean);
  assert.notEqual(result[1], media);
  assert.deepEqual(result[1]?.content.map((block) => block.type === "text" ? block.text : block.type), [
    "before", "[image]", "[document]", "tool_result",
  ]);
  const nested = result[1]?.content[3];
  assert.equal(nested?.type, "tool_result");
  assert.deepEqual(nested?.content.map((block) => block.type === "text" ? block.text : block.type), [
    "[image]", "[document]", "nested text",
  ]);
});

function nullContextInput(messages: CanonicalMessage[]): ContextPrepareInput {
  return {
    sessionId: "session-context-boundary",
    turnId: "turn-context-boundary",
    cwd: process.cwd(),
    provider: "test",
    model: "test-model",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages,
    tools: [],
  };
}
