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

test("Gateway persists a timeout status before publishing it to the stream", async () => {
  const order: string[] = [];
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession([], [], async () => {
      order.push("persist:start");
      await delay(10);
      order.push("persist:done");
    }),
  });
  const gateway = new InProcessGateway(router, {
    uuid: () => "durable-timeout-run",
    resolveTurnModelSelection: async () => {
      await delay(25);
      return { source: "default" as const };
    },
  });

  for await (const event of gateway.submitTurn({
    sessionKey: "durable-timeout-session",
    channelKey: "test",
    message: "persist timeout before publishing",
    timeoutMs: 1,
  })) {
    if (event.type === "agent_status") order.push("stream:status");
    if (event.type === "error") order.push("stream:error");
  }

  assert.deepEqual(order, ["persist:start", "persist:done", "stream:status", "stream:error"]);
});

test("Gateway aborts at the deadline without waiting for the timeout status writer", async () => {
  const abortReasons: string[] = [];
  let releaseStatus!: () => void;
  let statusStarted!: () => void;
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
  const statusWriting = new Promise<void>((resolve) => { statusStarted = resolve; });
  let releaseSubmit!: () => void;
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  const session = {
    async *submit() {
      await submitGate;
    },
    abort(reason?: string) {
      abortReasons.push(reason ?? "");
      releaseSubmit();
    },
    async recordAgentStatusMessage() {
      statusStarted();
      await statusGate;
    },
    snapshot() {
      return { sessionId: "session", messages: [], usage: {}, status: "idle", permissionDenials: [] };
    },
  } as unknown as AgentSession;
  const gateway = new InProcessGateway(new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => session,
  }), { uuid: () => "stalled-status-run" });

  let completed = false;
  const pending = collect(gateway.submitTurn({
    sessionKey: "stalled-status-session",
    channelKey: "test",
    message: "abort before durable status completes",
    timeoutMs: 1,
  })).finally(() => { completed = true; });

  await statusWriting;
  assert.deepEqual(abortReasons, ["timeout:stalled-status-run"]);
  assert.equal(completed, false);
  releaseStatus();
  const events = await pending;
  assert.deepEqual(events.filter((event) => event.type === "agent_status").map((event) => event.event), ["turn_timeout"]);
  assert.deepEqual(events.filter((event) => event.type === "error").map((event) => event.code), ["turn_timeout"]);
});

test("Gateway returns turn_timeout when durable timeout status persistence fails", async () => {
  const abortReasons: string[] = [];
  let releaseSubmit!: () => void;
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  const session = {
    async *submit() {
      await submitGate;
    },
    abort(reason?: string) {
      abortReasons.push(reason ?? "");
      releaseSubmit();
    },
    async recordAgentStatusMessage() {
      throw new Error("status storage unavailable");
    },
    snapshot() {
      return { sessionId: "session", messages: [], usage: {}, status: "idle", permissionDenials: [] };
    },
  } as unknown as AgentSession;
  const gateway = new InProcessGateway(new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => session,
  }), { uuid: () => "failed-status-run" });

  const events = await collect(gateway.submitTurn({
    sessionKey: "failed-status-session",
    channelKey: "test",
    message: "return timeout even when status persistence fails",
    timeoutMs: 1,
  }));

  assert.deepEqual(abortReasons, ["timeout:failed-status-run"]);
  assert.equal(events.some((event) => event.type === "agent_status"), false);
  assert.deepEqual(events.filter((event) => event.type === "error").map((event) => event.code), ["turn_timeout"]);
  assert.equal(events.some((event) => event.type === "turn_completed"), false);
});

function fakeSession(
  submissions: AgentSubmitOptions[],
  abortReasons: string[] = [],
  recordStatus: () => void | Promise<void> = () => {},
): AgentSession {
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
    async recordAgentStatusMessage() {
      await recordStatus();
    },
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
