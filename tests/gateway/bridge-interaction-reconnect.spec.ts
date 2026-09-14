import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import { startGatewayServer } from "../../src/gateway/server/GatewayServer.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("bridge consumes a terminal question replay after a real WebSocket interaction reconnect", async (t) => {
  await verifyBridgeReconnectScenario(t, "question");
});

test("bridge consumes a terminal permission replay after a real WebSocket interaction reconnect", async (t) => {
  await verifyBridgeReconnectScenario(t, "permission");
});

async function verifyBridgeReconnectScenario(
  t: { after(callback: () => void | Promise<void>): void },
  kind: "question" | "permission",
): Promise<void> {
  // The bridge reads this setting once at module evaluation. Keep the test
  // fast while still exercising its real polling path.
  process.env.PILOTDECK_ACTIVE_TURN_REPLAY_POLL_MS = "10";
  const bridgeModulePath = "../../ui/server/pilotdeck-bridge.js";
  const { reconnectBridgeInteraction } = await import(bridgeModulePath) as {
    reconnectBridgeInteraction(input: {
      gateway: RemoteGateway;
      state: Record<string, unknown>;
      previousBinding: NonNullable<RemoteGateway["interactionBinding"]>;
      writer: { send(frame: Record<string, unknown>): void };
    }): Promise<{ outcome: string }>;
  };

  const sessionKey = `web:bridge-reconnect-${kind}`;
  const runId = `run-bridge-reconnect-${kind}`;
  const requestId = `${kind}-bridge-reconnect`;
  const releaseTurn = deferred();
  const activeTurns = new Map<string, string>();
  const router = {
    beginTurn(key: string, turn: string) {
      if (activeTurns.has(key)) return false;
      activeTurns.set(key, turn);
      return true;
    },
    endTurn(key: string) {
      activeTurns.delete(key);
    },
    activeTurnRunId(key: string) {
      return activeTurns.get(key);
    },
    sessionCount() {
      return activeTurns.size;
    },
    async getOrCreate() {
      return {
        async *submit(_input: unknown, options: { turnId: string }) {
          yield {
            type: "input_accepted",
            sessionId: sessionKey,
            turnId: options.turnId,
            messages: [],
          };
          await releaseTurn.promise;
          yield {
            type: "model_event",
            sessionId: sessionKey,
            turnId: options.turnId,
            event: { type: "text_delta", text: "after-reconnect" },
          };
          yield {
            type: "tool_calls_detected",
            sessionId: sessionKey,
            turnId: options.turnId,
            calls: [{ id: "call-after-reconnect", name: "read_file", input: { path: "note.txt" } }],
          };
          const finalMessage = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "after-reconnect" }],
          };
          yield {
            type: "turn_completed",
            sessionId: sessionKey,
            turnId: options.turnId,
            result: {
              type: "success",
              sessionId: sessionKey,
              turnId: options.turnId,
              finalMessage,
              stopReason: "completed",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            },
          };
        },
      };
    },
  };
  const gateway = new InProcessGateway(router as unknown as SessionRouter);
  const server = await startGatewayServer({ gateway, port: 0, token: "bridge-reconnect-token" });
  const clients: GatewayWsClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    gateway.dispose();
    await server.close();
  });

  const firstClient = new GatewayWsClient({
    url: server.wsUrl,
    token: server.token,
    clientName: "web",
  });
  clients.push(firstClient);
  await firstClient.connect();
  const first = new RemoteGateway(firstClient);
  const firstBinding = first.interactionBinding;
  assert.ok(firstBinding, "the first WebSocket must receive a server-issued binding");

  const firstEvents: Array<{ type: string }> = [];
  const firstStream = (async () => {
    try {
      for await (const event of first.submitTurn({
        sessionKey,
        channelKey: "web",
        projectKey: process.cwd(),
        message: "continue",
        runId,
      })) {
        firstEvents.push(event);
      }
    } catch {
      // Closing the first WebSocket is the point of this recovery test.
    }
  })();
  await waitFor(
    () => firstEvents.some((event) => event.type === "input_accepted"),
    "the first stream must reserve an active turn",
  );

  let resolved = 0;
  const settleCurrent = () => {
    resolved += 1;
    releaseTurn.resolve();
  };
  if (kind === "question") {
    gateway.getElicitationBus().register(sessionKey, {
      requestId,
      toolCallId: "call-bridge-reconnect",
      toolName: "ask_user_question",
      resolve: settleCurrent,
      reject: (error) => assert.fail(error.message),
    }, {
      payload: {
        questions: [{
          question: "Continue?",
          header: "Choice",
          options: [{ label: "Continue", description: "Continue the turn." }],
        }],
      },
    });
    assert.equal(gateway.emitForSession(sessionKey, {
      type: "elicitation_request",
      requestId,
      toolCallId: "call-bridge-reconnect",
      toolName: "ask_user_question",
      questions: [{
        question: "Continue?",
        header: "Choice",
        options: [{ label: "Continue", description: "Continue the turn." }],
      }],
    }), true);
  } else {
    gateway.getPermissionBus().register(sessionKey, {
      requestId,
      toolCallId: "call-bridge-reconnect",
      toolName: "write_file",
      resolve: settleCurrent,
      reject: (error) => assert.fail(error.message),
    }, {
      payload: { payload: { path: "note.txt", content: "continue" } },
    });
    assert.equal(gateway.emitForSession(sessionKey, {
      type: "permission_request",
      requestId,
      toolName: "write_file",
      payload: { path: "note.txt", content: "continue" },
    }), true);
  }
  await waitFor(
    () => firstEvents.some((event) => event.type === (kind === "question" ? "elicitation_request" : "permission_request")),
    "the first stream must reach the pending interaction before it disconnects",
  );

  firstClient.close();
  await waitFor(
    () => gateway.getInteractionBinding(sessionKey) === undefined,
    "Gateway must release the retired connection binding after the socket closes",
  );

  const secondClient = new GatewayWsClient({
    url: server.wsUrl,
    token: server.token,
    clientName: "web",
  });
  clients.push(secondClient);
  await secondClient.connect();
  const second = new RemoteGateway(secondClient);
  const frames: Array<Record<string, unknown>> = [];
  const state: Record<string, unknown> = {
    sessionKey,
    runId,
    active: true,
    awaitingGatewayReconnect: true,
  };

  const replay = await reconnectBridgeInteraction({
    gateway: second,
    state,
    previousBinding: firstBinding,
    writer: { send: (frame: Record<string, unknown>) => frames.push(frame) },
  });
  assert.equal(replay.outcome, "reconnected");
  assert.equal(frames.filter((frame) => frame.kind === "permission_request").length, 1);
  assert.ok(frames.some((frame) => frame.kind === "permission_request" && frame.requestId === requestId));

  if (kind === "question") {
    assert.deepEqual(
      await gateway.respondElicitation({
        sessionKey,
        requestId,
        answer: { type: "cancelled", reason: "stale" },
        interactionBinding: firstBinding,
      }),
      { delivered: false },
      "the retired binding cannot settle the Gateway-owned pending question",
    );
    assert.deepEqual(
      await second.respondElicitation({
        sessionKey,
        requestId,
        answer: { type: "cancelled", reason: "current" },
      }),
      { delivered: true },
    );
  } else {
    assert.deepEqual(
      await gateway.permissionDecide({
        sessionKey,
        requestId,
        decision: "allow",
        interactionBinding: firstBinding,
      }),
      { delivered: false },
      "the retired binding cannot settle the Gateway-owned pending permission",
    );
    assert.deepEqual(
      await second.permissionDecide({
        sessionKey,
        requestId,
        decision: "allow",
      }),
      { delivered: true },
    );
  }
  await waitFor(() => resolved === 1, "the replacement binding must settle the pending interaction");
  await waitFor(
    () => frames.some((frame) => frame.kind === "stream_delta" && frame.content === "after-reconnect"),
    "the bridge must project output produced after the replayed answer",
  );
  await waitFor(
    () => frames.some((frame) => frame.kind === "tool_use" && frame.toolId === "call-after-reconnect"),
    "the bridge must project tool events produced after the replayed answer",
  );
  await waitFor(
    () => frames.some((frame) => frame.kind === "complete"),
    "the bridge must project the terminal turn event before clearing local activity",
  );
  await waitFor(() => state.active === false, "terminal replay must clear the local active state");
  await firstStream;
}
