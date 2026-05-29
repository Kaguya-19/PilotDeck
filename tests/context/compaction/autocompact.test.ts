import test from "node:test";
import assert from "node:assert/strict";

import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { AutoCompactionPolicy } from "../../../src/context/compaction/AutoCompactionPolicy.js";
import { CompactionEngine } from "../../../src/context/compaction/CompactionEngine.js";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function repeatedText(words: number, prefix = "token"): string {
  return Array.from({ length: words }, (_, index) => `${prefix}${index}`).join(" ");
}

function createSummaryModel(summaries: string[]) {
  const requests: CanonicalModelRequest[] = [];
  return {
    requests,
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        const text = summaries[Math.min(requests.length - 1, summaries.length - 1)] ?? "summary";
        yield { type: "text_delta", text };
      },
    },
  };
}

test("token budget evaluation uses padded tokens for thresholds", () => {
  const tokenBudget = new TokenBudgetManager({ warningRatio: 0.8, blockingRatio: 0.95 });
  const messages = [textMessage("user", "one two three four five six seven eight nine ten")];
  const raw = tokenBudget.estimateMessagesTokens(messages);
  const padded = tokenBudget.estimateForMessagesWithPadding(messages);

  assert.ok(padded > raw);
  const snapshot = tokenBudget.evaluate(messages, Math.ceil(padded / 0.9));

  assert.equal(snapshot.tokens, padded);
  assert.equal(snapshot.state, "warning");
});

test("full auto-compaction tightens tail until padded budget is ok", async () => {
  const tokenBudget = new TokenBudgetManager({ warningRatio: 0.8, blockingRatio: 0.95 });
  const summaryModel = createSummaryModel([repeatedText(120, "summary")]);
  const compactionEngine = new CompactionEngine({
    model: summaryModel.model,
    tokenBudget,
    provider: "test",
    model_: "test-model",
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine,
    maxContextTokens: 900,
  });
  const messages = Array.from({ length: 20 }, (_, index) =>
    textMessage(index % 2 === 0 ? "user" : "assistant", repeatedText(55, `m${index}`)),
  );

  const result = await runtime.tryAutoCompact({ messages, maxContextTokens: 900 });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.equal(result.snapshot.state, "ok");
  assert.equal(summaryModel.requests.length, 1);
});

test("compaction engine selects a smaller tail when token target is tight", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryModel = createSummaryModel(["summary"]);
  const compactionEngine = new CompactionEngine({
    model: summaryModel.model,
    tokenBudget,
    provider: "test",
    model_: "test-model",
  });
  const messages = Array.from({ length: 20 }, (_, index) =>
    textMessage(index % 2 === 0 ? "user" : "assistant", repeatedText(55, `m${index}`)),
  );

  const ratioOnly = await compactionEngine.run({ trigger: "auto", messages, keepTailRatio: 0.35 });
  const tokenAware = await compactionEngine.run({
    trigger: "auto",
    messages,
    keepTailRatio: 0.35,
    targetPostTokens: 720,
  });

  assert.ok(ratioOnly.messagesToKeep.length > tokenAware.messagesToKeep.length);
  assert.equal(tokenAware.messagesToKeep.length, 1);
});

test("full auto-compaction returns last compacted result when summaries remain too large", async () => {
  const tokenBudget = new TokenBudgetManager({ warningRatio: 0.8, blockingRatio: 0.95 });
  const summaryModel = createSummaryModel([
    repeatedText(900, "summary-a"),
    repeatedText(900, "summary-b"),
    repeatedText(900, "summary-c"),
  ]);
  const compactionEngine = new CompactionEngine({
    model: summaryModel.model,
    tokenBudget,
    provider: "test",
    model_: "test-model",
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine,
    maxContextTokens: 900,
  });
  const messages = Array.from({ length: 20 }, (_, index) =>
    textMessage(index % 2 === 0 ? "user" : "assistant", repeatedText(55, `m${index}`)),
  );

  const result = await runtime.tryAutoCompact({ messages, maxContextTokens: 900 });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.notEqual(result.snapshot.state, "ok");
  assert.equal(summaryModel.requests.length, 3);
});

test("token-aware compaction keeps tool pairs intact across compact boundary", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryModel = createSummaryModel(["summary"]);
  const compactionEngine = new CompactionEngine({
    model: summaryModel.model,
    tokenBudget,
    provider: "test",
    model_: "test-model",
  });
  const messages: CanonicalMessage[] = [
    textMessage("user", repeatedText(40, "old")),
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_call", id: "call-kept", name: "read", input: { path: "a" } },
        { type: "tool_call", id: "call-dangling", name: "read", input: { path: "b" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "call-kept", content: [{ type: "text", text: "kept" }] },
        { type: "tool_result", toolCallId: "call-missing", content: [{ type: "text", text: "dangling" }] },
      ],
    },
  ];

  const result = await compactionEngine.run({
    trigger: "auto",
    messages,
    keepTailRatio: 1,
    targetPostTokens: 1_000,
  });

  const keptToolCalls = result.messagesToKeep.flatMap((message) =>
    message.content.filter((block) => block.type === "tool_call").map((block) => block.id),
  );
  const keptToolResults = result.messagesToKeep.flatMap((message) =>
    message.content.filter((block) => block.type === "tool_result").map((block) => block.toolCallId),
  );

  assert.deepEqual(keptToolCalls, ["call-kept"]);
  assert.deepEqual(keptToolResults, ["call-kept"]);
});
