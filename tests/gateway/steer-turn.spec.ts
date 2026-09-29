import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { GatewayAttachmentTurnComposerPort } from "../../src/gateway/dialog/GatewayAttachmentTurnComposerPort.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("gateway turns guidance into a canonical user message for the active run", async () => {
  let received: {
    turnId: string;
    itemId: string;
    message: CanonicalMessage;
    allowedReadFiles?: string[];
  } | undefined;
  let cancelled: { turnId: string; itemId: string } | undefined;
  const session = {
    steer(input: typeof received) {
      received = input;
      return { accepted: true } as const;
    },
    cancelSteer(input: typeof cancelled) {
      cancelled = input;
      return { cancelled: true } as const;
    },
    abort() {},
    snapshot() {
      return { sessionId: "session-1", messages: [], usage: {}, status: "running", permissionDenials: [] };
    },
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => session,
  });
  await router.getOrCreate({ sessionKey: "session-1", channelKey: "web" });
  assert.equal(router.beginTurn("session-1", "run-1"), true);

  const composerCalls: Array<{ message: string; projectRoot?: string }> = [];
  const attachmentTurnComposer: GatewayAttachmentTurnComposerPort = {
    async prepare(input) {
      composerCalls.push({ message: input.message, projectRoot: input.projectRoot });
      return {
        agentInput: {
          type: "blocks",
          content: [{ type: "text", text: "prepared steer input" }],
        },
        allowedReadFiles: ["/approved/attachment.txt"],
      };
    },
  };
  const gateway = new InProcessGateway(router, { attachmentTurnComposer });
  const result = await gateway.steerTurn({
    sessionKey: "session-1",
    runId: "run-1",
    itemId: "queue-1",
    message: "Use HTML instead",
    projectKey: "/tmp/project",
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(received?.turnId, "run-1");
  assert.equal(received?.itemId, "queue-1");
  assert.equal(received?.message.role, "user");
  assert.deepEqual(received?.message.metadata, {
    purpose: "mid_turn_steer",
    queueItemId: "queue-1",
  });
  assert.deepEqual(received?.message.content, [{ type: "text", text: "prepared steer input" }]);
  assert.deepEqual(received?.allowedReadFiles, ["/approved/attachment.txt"]);
  assert.deepEqual(composerCalls, [{
    message: "Use HTML instead",
    projectRoot: "/tmp/project",
  }]);

  assert.deepEqual(await gateway.steerTurn({
    sessionKey: "session-1",
    runId: "stale-run",
    itemId: "queue-2",
    message: "stale",
  }), { accepted: false, reason: "turn_mismatch" });

  assert.deepEqual(await gateway.cancelSteer({
    sessionKey: "session-1",
    runId: "run-1",
    itemId: "queue-1",
  }), { cancelled: true });
  assert.deepEqual(cancelled, { turnId: "run-1", itemId: "queue-1" });

  assert.deepEqual(await gateway.cancelSteer({
    sessionKey: "session-1",
    runId: "stale-run",
    itemId: "queue-1",
  }), { cancelled: false, reason: "turn_mismatch" });
});
