import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { GatewayTurnCompletionFence } from "../../src/gateway/client/GatewayTurnCompletionFence.js";
import type {
  GatewayTurnCompletionFencePort,
  GatewayTurnCompletionHandle,
} from "../../src/gateway/client/GatewayTurnCompletionFencePort.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("GatewayTurnCompletionFence waits for the exact in-flight turn and preserves a newer handle", async () => {
  const fence = new GatewayTurnCompletionFence();
  const first = fence.begin("web:fence");
  const firstWait = fence.waitForCompletion("web:fence");
  const second = fence.begin("web:fence");

  fence.complete("web:fence", first);
  await firstWait;
  assert.equal(fence.isCurrent("web:fence", second), true);

  let secondSettled = false;
  const secondWait = fence.waitForCompletion("web:fence").then(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(secondSettled, false);
  fence.complete("web:fence", second);
  await secondWait;
  assert.equal(fence.isCurrent("web:fence", second), false);
});

test("InProcessGateway delegates submit drain and abort waiting to an injected completion fence", async () => {
  const calls: string[] = [];
  const handle: GatewayTurnCompletionHandle = { done: Promise.resolve() };
  const fence: GatewayTurnCompletionFencePort = {
    begin: () => {
      calls.push("begin");
      return handle;
    },
    isCurrent: () => {
      calls.push("current");
      return true;
    },
    complete: () => { calls.push("complete"); },
    waitForCompletion: async () => { calls.push("wait"); },
  };
  const activeTurns = new Map<string, string>();
  const session = {
    async *submit(_input: unknown, options: AgentSubmitOptions = {}) {
      const turnId = options.turnId ?? "turn-fence";
      yield { type: "input_accepted", sessionId: "web:fence", turnId, messages: [] } as const;
      yield {
        type: "turn_completed",
        sessionId: "web:fence",
        turnId,
        result: {
          type: "success",
          sessionId: "web:fence",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-10T00:00:00.000Z",
          completedAt: "2026-09-10T00:00:01.000Z",
        },
      } as const;
    },
  } as unknown as AgentSession;
  const router = {
    beginTurn(sessionKey: string, runId: string) {
      if (activeTurns.has(sessionKey)) return false;
      activeTurns.set(sessionKey, runId);
      return true;
    },
    endTurn(sessionKey: string) { activeTurns.delete(sessionKey); },
    async getOrCreate() { return session; },
    async abort() { calls.push("router-abort"); },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, { turnCompletionFence: fence });

  for await (const _event of gateway.submitTurn({
    sessionKey: "web:fence",
    channelKey: "web",
    message: "continue",
    runId: "turn-fence",
  })) {
    // Drain the complete native submit path.
  }
  await gateway.abortTurn({ sessionKey: "web:fence", runId: "turn-fence" });

  assert.ok(calls.includes("begin"));
  assert.ok(calls.includes("current"));
  assert.ok(calls.includes("complete"));
  assert.deepEqual(calls.slice(-2), ["router-abort", "wait"]);
});
