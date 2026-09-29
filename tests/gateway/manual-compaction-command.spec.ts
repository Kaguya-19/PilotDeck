import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

test("/compact is a gateway projection and never submits a model turn", async () => {
  let compactCalls = 0;
  let submits = 0;
  const router = {
    compact: async (sessionKey: string, options: { turnId?: string }) => {
      compactCalls += 1;
      assert.equal(sessionKey, "session-compact");
      assert.equal(options.turnId, "run-compact");
      return {
        type: "compacted" as const,
        turnId: "run-compact",
        compactionId: "compact-1",
        preTokens: 120,
        postTokens: 30,
        messagesSummarized: 4,
        usage: { inputTokens: 12 },
      };
    },
    beginTurn: () => { submits += 1; return true; },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router);

  const events = await collect(gateway.submitTurn({
    sessionKey: "session-compact",
    channelKey: "web",
    message: "/compact",
    runId: "run-compact",
  }));

  assert.equal(compactCalls, 1);
  assert.equal(submits, 0);
  assert.deepEqual(events.map((event) => event.type), ["agent_status", "assistant_text_delta", "turn_completed"]);
  assert.equal(events[1]?.type === "assistant_text_delta" && events[1].text, "Compacted 4 history items (~120 tokens).");
});

test("/compact rejects arguments without allocating or submitting a session", async () => {
  let compactCalls = 0;
  const router = {
    compact: async () => { compactCalls += 1; throw new Error("not reached"); },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router);
  const events = await collect(gateway.submitTurn({
    sessionKey: "session-compact",
    channelKey: "web",
    message: "/compact please",
  }));

  assert.equal(compactCalls, 0);
  assert.deepEqual(events, [
    { type: "assistant_text_delta", text: "用法：/compact" },
    { type: "turn_completed", usage: {}, finishReason: "completed" },
  ]);
});

test("/compact maps router busy to an explicit non-model error", async () => {
  const router = {
    compact: async () => { throw new Error("Session has an active turn."); },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, { uuid: () => "run-busy" });
  const events = await collect(gateway.submitTurn({
    sessionKey: "session-busy",
    channelKey: "web",
    message: "/compact",
  }));

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "error",
    runId: "run-busy",
    code: "session_busy",
    message: "Compaction is unavailable because this session has an active turn or queued work.",
    recoverable: true,
    userHint: "Wait for the current work to finish, then run /compact again.",
  });
});

test("/compact forwards the command deadline as an owned maintenance abort signal", async () => {
  let observedSignal: AbortSignal | undefined;
  const router = {
    compact: async (_sessionKey: string, options: { abortSignal?: AbortSignal }) => {
      observedSignal = options.abortSignal;
      await aborted(options.abortSignal!);
      return { type: "aborted" as const, turnId: "run-timeout", error: "timeout", usage: {} };
    },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, { uuid: () => "run-timeout" });
  const events = await collect(gateway.submitTurn({
    sessionKey: "session-timeout",
    channelKey: "web",
    message: "/compact",
    timeoutMs: 1,
  }));

  assert.equal(observedSignal?.aborted, true);
  const completed = events.at(-1);
  assert.equal(completed?.type, "turn_completed");
  if (completed?.type === "turn_completed") {
    assert.equal(completed.finishReason, "aborted_streaming");
  }
});

test("/compact delegates the validated command to an injected projection provider", async () => {
  let submitted = 0;
  const router = {
    beginTurn: () => { submitted += 1; return true; },
  } as unknown as SessionRouter;
  const calls: Array<{ sessionKey: string; runId: string; timeoutMs?: number }> = [];
  const gateway = new InProcessGateway(router, {
    manualCompactionCoordinator: {
      async *execute(input) {
        calls.push(input);
        yield { type: "assistant_text_delta", text: "custom compaction" };
        yield { type: "turn_completed", runId: input.runId, usage: {}, finishReason: "completed" };
      },
    },
  });

  const events = await collect(gateway.submitTurn({
    sessionKey: "session-injected",
    channelKey: "web",
    message: "/compact",
    runId: "run-injected",
    timeoutMs: 123,
  }));

  assert.deepEqual(calls, [{ sessionKey: "session-injected", runId: "run-injected", timeoutMs: 123 }]);
  assert.equal(submitted, 0);
  assert.deepEqual(events.map((event) => event.type), ["assistant_text_delta", "turn_completed"]);
});

async function collect(source: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
