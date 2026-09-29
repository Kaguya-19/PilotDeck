import assert from "node:assert/strict";
import test from "node:test";

import { createHostAgentEventBridge } from "../../../src/agent/modules/events/index.js";

test("host agent-event bridge keeps emitter delivery ordered and non-terminal", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let attempt = 0;
  const bridge = createHostAgentEventBridge(async (request) => {
    requests.push(request as unknown as Record<string, unknown>);
    attempt += 1;
    return {
      kind: "response",
      messageId: `event-${attempt}`,
      inReplyTo: "call",
      ok: attempt !== 1,
      ...(attempt === 1 ? { code: "EVENT_UNAVAILABLE" } : {}),
    };
  }, {
    runId: "run-1",
    operationId: "operation-1",
  }, (() => {
    let sequence = 0;
    return () => String(++sequence);
  })());

  bridge.emitter({ type: "instructions_loaded", sessionId: "session-1", turnId: "turn-1", hasSystemPrompt: true });
  bridge.emitter({ type: "warning", sessionId: "session-1", turnId: "turn-1", code: "NEXT", message: "next event" });
  await bridge.flush();

  assert.deepEqual(requests.map((request) => request.payload), [
    {
      operation: "emit",
      event: { type: "instructions_loaded", sessionId: "session-1", turnId: "turn-1", hasSystemPrompt: true },
    },
    {
      operation: "emit",
      event: { type: "warning", sessionId: "session-1", turnId: "turn-1", code: "NEXT", message: "next event" },
    },
  ]);
  assert.equal(requests.every((request) => request.recordFailure === false), true);
});
