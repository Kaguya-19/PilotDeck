import assert from "node:assert/strict";
import test from "node:test";

import type { AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { GatewayEvent } from "../../src/gateway/protocol/types.js";

test("Gateway turns derive one operation deadline from a valid wall-clock timeout", async () => {
  const submissions: AgentSubmitOptions[] = [];
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(submissions),
  });
  const gateway = new InProcessGateway(router, {
    now: () => new Date("2026-09-11T00:00:00.000Z"),
    uuid: () => "deadline-run",
  });

  await collect(gateway.submitTurn({
    sessionKey: "deadline-session",
    channelKey: "test",
    message: "keep the execution budget bounded",
    timeoutMs: 1_500,
  }));

  assert.deepEqual(submissions[0]?.execution, {
    runId: "deadline-run",
    operationId: "deadline-run",
    operationDeadline: "2026-09-11T00:00:01.500Z",
  });
});

test("Gateway does not invent an operation deadline for an invalid timeout", async () => {
  const submissions: AgentSubmitOptions[] = [];
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(submissions),
  });
  const gateway = new InProcessGateway(router, {
    now: () => new Date("2026-09-11T00:00:00.000Z"),
    uuid: () => "no-deadline-run",
  });

  await collect(gateway.submitTurn({
    sessionKey: "no-deadline-session",
    channelKey: "test",
    message: "preserve the existing no-timeout execution contract",
    timeoutMs: 0,
  }));

  assert.deepEqual(submissions[0]?.execution, {
    runId: "no-deadline-run",
    operationId: "no-deadline-run",
  });
});

test("Gateway does not admit a session turn after timeout fires during asynchronous admission", async () => {
  const submissions: AgentSubmitOptions[] = [];
  const abortReasons: string[] = [];
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(submissions, abortReasons),
  });
  const gateway = new InProcessGateway(router, {
    uuid: () => "admission-timeout-run",
    resolveTurnModelSelection: async () => {
      await delay(25);
      return { source: "default" as const };
    },
  });

  const events = await collect(gateway.submitTurn({
    sessionKey: "admission-timeout-session",
    channelKey: "test",
    message: "do not start after timeout",
    timeoutMs: 1,
  }));
  await delay(35);

  assert.equal(events.filter((event) => event.type === "error" && event.code === "turn_timeout").length, 1);
  assert.deepEqual(submissions, []);
  assert.deepEqual(abortReasons, ["timeout:admission-timeout-run"]);
});

function fakeSession(submissions: AgentSubmitOptions[], abortReasons: string[] = []): AgentSession {
  return {
    async *submit(_input: AgentInput, options: AgentSubmitOptions = {}) {
      submissions.push(options);
      const turnId = options.turnId ?? "turn";
      yield { type: "turn_started", sessionId: "session", turnId };
      yield {
        type: "turn_completed",
        sessionId: "session",
        turnId,
        result: {
          type: "success",
          sessionId: "session",
          turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-11T00:00:00.000Z",
          completedAt: "2026-09-11T00:00:00.001Z",
        },
      };
    },
    abort(reason?: string) {
      abortReasons.push(reason ?? "");
    },
    async recordAgentStatusMessage() {},
    snapshot() {
      return {
        sessionId: "session",
        messages: [],
        usage: {},
        status: "idle",
        permissionDenials: [],
      };
    },
  } as unknown as AgentSession;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collect(source: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
