import assert from "node:assert/strict";
import test from "node:test";

import { GatewayManualCompactionCoordinator } from "../../src/gateway/client/GatewayManualCompactionCoordinator.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

test("manual compaction coordinator owns deadline projection but leaves Router maintenance ownership intact", async () => {
  let observedSessionKey: string | undefined;
  let observedTurnId: string | undefined;
  const coordinator = new GatewayManualCompactionCoordinator({
    router: {
      async compact(sessionKey, options) {
        observedSessionKey = sessionKey;
        observedTurnId = options.turnId;
        return {
          type: "compacted",
          turnId: "compact-run",
          compactionId: "compact-1",
          preTokens: 120,
          postTokens: 30,
          messagesSummarized: 4,
          usage: { inputTokens: 12 },
        };
      },
    },
  });

  const events = await collect(coordinator.execute({ sessionKey: "session-1", runId: "run-1" }));

  assert.equal(observedSessionKey, "session-1");
  assert.equal(observedTurnId, "run-1");
  assert.deepEqual(events.map((event) => event.type), ["agent_status", "assistant_text_delta", "turn_completed"]);
  assert.equal(events[1]?.type === "assistant_text_delta" && events[1].text, "Compacted 4 history items (~120 tokens).");
});

test("manual compaction coordinator maps a busy Router response without reporting command success", async () => {
  const coordinator = new GatewayManualCompactionCoordinator({
    router: {
      async compact() {
        throw new Error("Session has an active turn.");
      },
    },
  });

  const events = await collect(coordinator.execute({ sessionKey: "session-busy", runId: "run-busy" }));

  assert.deepEqual(events, [{
    type: "error",
    runId: "run-busy",
    code: "session_busy",
    message: "Compaction is unavailable because this session has an active turn or queued work.",
    recoverable: true,
    userHint: "Wait for the current work to finish, then run /compact again.",
  }]);
});

async function collect(source: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
