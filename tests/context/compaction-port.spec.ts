import assert from "node:assert/strict";
import test from "node:test";

import {
  DefaultContextRuntime,
  TokenBudgetManager,
  type CompactionPort,
} from "../../src/context/index.js";
import type { AutoCompactResult } from "../../src/context/compaction/CompactionPort.js";
import type { CompactionResult } from "../../src/context/compaction/CompactionEngine.js";
import type { CanonicalMessage } from "../../src/model/index.js";

test("DefaultContextRuntime consumes a compaction provider without concrete engines", async () => {
  const tokenBudget = new TokenBudgetManager();
  let evaluations = 0;
  let summaryCalls = 0;
  const source: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "old work" }] },
    { role: "assistant", content: [{ type: "text", text: "continue" }] },
  ];
  const resultMessage: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: "compacted surface" }],
  };
  const compactionResult: CompactionResult = {
    compactionId: "provider-compaction-1",
    trigger: "auto",
    preTokens: 95,
    postTokens: 12,
    messagesSummarized: 2,
    summaryMessage: resultMessage,
    boundaryMarker: resultMessage,
    messagesToKeep: [],
    attachments: [],
    hookResults: [],
    diagnostics: [],
  };
  const port: CompactionPort = {
    budget: {
      evaluate: () => tokenBudget.snapshotFromTokens(evaluations++ === 0 ? 95 : 50, 100),
      estimateMessagesTokens: (messages) => tokenBudget.estimateMessagesTokens(messages),
    },
    policy: {
      evaluateSnapshot: (snapshot) => ({ type: "trigger", snapshot, reason: "warning_threshold" }),
    },
    summary: {
      async run() {
        summaryCalls += 1;
        return compactionResult;
      },
    },
    buildPostCompactMessages: () => [resultMessage],
    truncateHeadPreservingCheckpoint: (messages) => messages,
  };

  const runtime = new DefaultContextRuntime({ compaction: port });
  const result = await runtime.tryAutoCompact({ messages: source });

  assert.equal(summaryCalls, 1);
  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.deepEqual(result.messages[0], resultMessage);
});

test("manual force bypasses only the automatic threshold and propagates the manual trigger", async () => {
  const tokenBudget = new TokenBudgetManager();
  const source: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "small history" }] }];
  const summary: CanonicalMessage = { role: "user", content: [{ type: "text", text: "manual summary" }] };
  let policyCalls = 0;
  let summaryInput: { trigger: string; messages: CanonicalMessage[] } | undefined;
  const port: CompactionPort = {
    budget: {
      evaluate: () => tokenBudget.snapshotFromTokens(10, 100),
      estimateMessagesTokens: (messages) => tokenBudget.estimateMessagesTokens(messages),
    },
    policy: {
      evaluateSnapshot: (snapshot) => {
        policyCalls += 1;
        return { type: "skip", snapshot, reason: "below_warning_threshold" };
      },
    },
    summary: {
      async run(input) {
        summaryInput = { trigger: input.trigger, messages: input.messages };
        return {
          compactionId: "manual-compact-1",
          trigger: input.trigger,
          preTokens: 10,
          postTokens: 5,
          messagesSummarized: 1,
          summaryMessage: summary,
          boundaryMarker: summary,
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
          diagnostics: [],
        };
      },
    },
    buildPostCompactMessages: () => [summary],
    truncateHeadPreservingCheckpoint: (messages) => messages,
  };
  const runtime = new DefaultContextRuntime({ compaction: port, maxContextTokens: 100 });

  const automatic = await runtime.tryAutoCompact({ messages: source });
  const manual = await runtime.tryAutoCompact({ messages: source, trigger: "manual", manualForce: true });

  assert.equal(automatic.type, "skipped");
  assert.equal(policyCalls, 1);
  assert.equal(manual.type, "compacted");
  assert.equal(summaryInput?.trigger, "manual");
  assert.deepEqual(summaryInput?.messages, source);
});

test("DefaultContextRuntime delegates a composed high-level compaction provider", async () => {
  const expected: AutoCompactResult = {
    type: "skipped",
    snapshot: {
      tokens: 1,
      maxContextTokens: 10,
      warningRatio: 0.8,
      blockingRatio: 0.9,
      state: "ok",
      ratio: 0.1,
    },
  };
  let calls = 0;
  const port: CompactionPort = {
    autoCompact: async (input) => {
      calls += 1;
      assert.equal(input.sessionId, "high-level-session");
      return expected;
    },
    // These are intentionally invalid: the high-level provider owns stage
    // ordering, so the consumer must not inspect compatibility fields.
    budget: undefined,
    buildPostCompactMessages: () => [],
    truncateHeadPreservingCheckpoint: (messages) => messages,
  };
  const runtime = new DefaultContextRuntime({ compaction: port });
  const result = await runtime.tryAutoCompact({
    sessionId: "high-level-session",
    turnId: "high-level-turn",
    messages: [],
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, expected);
});

test("DefaultContextRuntime delegates model-error recovery to the compaction provider", async () => {
  const expected = {
    type: "compact_and_retry" as const,
    reason: "provider-policy",
  };
  const port: CompactionPort = {
    recovery: {
      decide: () => expected,
    },
    buildPostCompactMessages: () => [],
    truncateHeadPreservingCheckpoint: (messages) => messages,
  };
  const runtime = new DefaultContextRuntime({ compaction: port });

  const actual = await runtime.recoverFromModelError({
    sessionId: "session-compaction-port",
    turnId: "turn-compaction-port",
    error: {
      provider: "test",
      protocol: "openai",
      code: "context_overflow",
      message: "overflow",
      retryable: true,
    },
    messages: [],
    hasAttemptedCompact: false,
  });

  assert.deepEqual(actual, expected);
});
