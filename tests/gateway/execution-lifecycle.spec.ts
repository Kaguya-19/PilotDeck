import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function completedSession(): AgentSession {
  return {
    async *submit() {
      yield { type: "model_event", sessionId: "session", turnId: "turn", event: { type: "text_delta", text: "working" } };
      yield {
        type: "turn_completed",
        sessionId: "session",
        turnId: "turn",
        result: { type: "success", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "", completedAt: "" },
      };
    },
    abort: () => undefined,
    snapshot: () => ({ sessionId: "session", messages: [], usage: {}, permissionDenials: [], status: "idle", abortController: new AbortController() }),
  } as unknown as AgentSession;
}

test("execution-lifecycle: submits a turn and keeps session serialization at the router boundary", async () => {
  const router = new SessionRouter({ createSession: async () => completedSession() });
  const gateway = new InProcessGateway(router, { uuid: () => "run" });
  const events = await collect(gateway.submitTurn({ sessionKey: "s", channelKey: "test", message: "go" }));
  assert.deepEqual(events.map((event) => (event as { type: string }).type), [
    "assistant_text_delta", "turn_completed",
  ]);

  assert.equal(router.beginTurn("s", "active"), true);
  const busy = await collect(gateway.submitTurn({ sessionKey: "s", channelKey: "test", message: "again" }));
  assert.equal((busy[0] as { type: string }).type, "agent_status");
  assert.deepEqual(busy[1], {
    type: "error",
    code: "session_busy",
    message: "Session s already has an active turn.",
    recoverable: true,
    userHint: "Wait for the current turn to finish or stop it before sending another message.",
  });
  router.endTurn("s", "active");
  router.shutdown();
});

test("execution-lifecycle: abort delegates to the active session and completes before reuse", async () => {
  let abortReason: string | undefined;
  const router = new SessionRouter({
    createSession: async () => ({
      abort: (reason?: string) => { abortReason = reason; },
      snapshot: () => ({ sessionId: "s", messages: [], usage: {}, permissionDenials: [], status: "idle", abortController: new AbortController() }),
    } as unknown as AgentSession),
  });
  await router.getOrCreate({ sessionKey: "s", channelKey: "test" });
  assert.equal(router.beginTurn("s", "run"), true);
  const gateway = new InProcessGateway(router);
  await gateway.abortTurn({ sessionKey: "s", runId: "run", reason: "user_stop" });
  assert.equal(abortReason, "user_stop");
  router.endTurn("s", "run");
  assert.equal(router.beginTurn("s", "next"), true);
  router.shutdown();
});

test("execution-lifecycle: abort waits for the stream cleanup before releasing the session slot", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let release!: () => void;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const router = new SessionRouter({
    createSession: async () => ({
      async *submit() {
        resolveStarted();
        yield { type: "model_event", sessionId: "s", turnId: "run", event: { type: "text_delta", text: "waiting" } };
        await new Promise<void>((resolve) => { release = resolve; resolveReady(); });
        yield {
          type: "turn_completed",
          sessionId: "s",
          turnId: "run",
          result: { type: "success", stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: "", completedAt: "" },
        };
      },
      abort: () => release(),
      snapshot: () => ({ sessionId: "s", messages: [], usage: {}, permissionDenials: [], status: "idle", abortController: new AbortController() }),
    } as unknown as AgentSession),
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run" });
  const eventsPromise = collect(gateway.submitTurn({ sessionKey: "s", channelKey: "test", message: "go" }));
  await started;
  await ready;

  let abortSettled = false;
  const abortPromise = gateway.abortTurn({ sessionKey: "s", runId: "run", reason: "user_stop" }).then(() => { abortSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(abortSettled, true, "abort resolves after the session stream has released its slot");
  await abortPromise;
  await eventsPromise;
  assert.equal(router.beginTurn("s", "next"), true);
  router.endTurn("s", "next");
  router.shutdown();
});

test("execution-lifecycle: active replay keeps only pending permission and elicitation requests", async () => {
  const gateway = new InProcessGateway({} as SessionRouter);
  const replays = (gateway as unknown as { activeTurnReplays: Map<string, unknown> }).activeTurnReplays;
  replays.set("s", {
    sessionKey: "s",
    runId: "run",
    events: [
      { type: "assistant_text_delta", text: "history" },
      { type: "permission_request", requestId: "pending-permission", toolName: "bash", payload: {} },
      { type: "permission_request", requestId: "answered-permission", toolName: "bash", payload: {} },
      { type: "elicitation_request", requestId: "pending-elicitation", toolCallId: "call", toolName: "ask_user_question", questions: [] },
      { type: "elicitation_request", requestId: "answered-elicitation", toolCallId: "call", toolName: "ask_user_question", questions: [] },
      { type: "elicitation_cancelled", requestId: "cancelled" },
    ],
    bytes: 0,
    truncated: false,
  });
  gateway.getPermissionBus().register("s", { requestId: "pending-permission", toolCallId: "call", toolName: "bash", resolve: () => undefined, reject: () => undefined });
  gateway.getElicitationBus().register("s", { requestId: "pending-elicitation", toolCallId: "call", toolName: "ask_user_question", resolve: () => undefined, reject: () => undefined });

  const events = (await gateway.getActiveTurnSnapshot({ sessionKey: "s" })).events;
  assert.deepEqual(events.map((event) => event.type), [
    "assistant_text_delta",
    "permission_request",
    "elicitation_request",
  ]);
});

test("execution-lifecycle: active snapshots and interaction buses are session scoped", async () => {
  const gateway = new InProcessGateway({} as SessionRouter);
  const replays = (gateway as unknown as { activeTurnReplays: Map<string, unknown> }).activeTurnReplays;
  replays.set("s", { sessionKey: "s", runId: "run", events: [{ type: "assistant_text_delta", text: "live" }], bytes: 4, truncated: false });
  assert.deepEqual(await gateway.getActiveTurnSnapshot({ sessionKey: "s", includeEvents: false }), { active: true, sessionKey: "s", runId: "run", events: [] });
  assert.deepEqual((await gateway.getActiveTurnSnapshot({ sessionKey: "s" })).events, [{ type: "assistant_text_delta", text: "live" }]);

  let elicitationAnswer: unknown;
  gateway.getElicitationBus().register("s", { requestId: "ask", toolCallId: "call", toolName: "ask_user_question", resolve: (answer) => { elicitationAnswer = answer; }, reject: () => undefined });
  const answer = { type: "answered" as const, answers: {} };
  assert.deepEqual(await gateway.respondElicitation({ sessionKey: "s", requestId: "ask", answer }), { delivered: true });
  assert.deepEqual(elicitationAnswer, answer);
  assert.deepEqual(await gateway.respondElicitation({ sessionKey: "s", requestId: "ask", answer }), { delivered: false });

  let permissionDecision: unknown;
  gateway.getPermissionBus().register("s", { requestId: "permission", toolCallId: "call", toolName: "bash", resolve: (decision) => { permissionDecision = decision; }, reject: () => undefined });
  assert.deepEqual(await gateway.permissionDecide({ sessionKey: "s", requestId: "permission", decision: "allow", remember: true }), { delivered: true });
  assert.deepEqual(permissionDecision, { requestId: "permission", decision: "allow", remember: true, reason: undefined });
  assert.deepEqual(await gateway.permissionDecide({ sessionKey: "s", requestId: "missing", decision: "deny" }), { delivered: false });
});
