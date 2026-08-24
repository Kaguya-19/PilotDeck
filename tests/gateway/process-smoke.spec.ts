import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import { startGatewayServer } from "../../src/gateway/server/GatewayServer.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";

type WireFrame = Record<string, unknown>;

function fakeGateway(aborted: string[]): Gateway {
  return {
    describeServer: async () => ({ mode: "in_process", version: "test", capabilities: [] }),
    abortTurn: async ({ sessionKey }: { sessionKey: string }) => {
      aborted.push(sessionKey);
    },
    async *submitTurn() {
      yield { type: "assistant_text_delta", text: "hello" };
      yield { type: "turn_completed", usage: { totalTokens: 1 }, finishReason: "completed" };
    },
  } as unknown as Gateway;
}

function frameQueue(socket: WebSocket): { next(): Promise<WireFrame>; close(): Promise<void> } {
  const pending: Array<(frame: WireFrame) => void> = [];
  const frames: WireFrame[] = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as WireFrame;
    const resolve = pending.shift();
    if (resolve) resolve(frame);
    else frames.push(frame);
  });
  return {
    next: async () => {
      const frame = frames.shift();
      if (frame) return frame;
      return new Promise<WireFrame>((resolve) => pending.push(resolve));
    },
    close: () => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.close();
    }),
  };
}

function open(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

test("GatewayServer smoke covers health, auth, turn framing, abort and port release", async (t) => {
  const aborted: string[] = [];
  const server = await startGatewayServer({
    gateway: fakeGateway(aborted),
    port: 0,
    token: "test-token",
    serverVersion: "test",
  });
  t.after(() => server.close().catch(() => undefined));

  const health = await fetch(`${server.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const token = await fetch(`${server.url}/auth/local-token`);
  assert.deepEqual(await token.json(), { token: "test-token" });

  const socket = new WebSocket(server.wsUrl);
  const queue = frameQueue(socket);
  await open(socket);
  socket.send(JSON.stringify({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "process-smoke",
    clientVersion: "test",
    token: "test-token",
  }));
  assert.equal((await queue.next()).type, "hello_ok");

  socket.send(JSON.stringify({
    type: "request",
    id: "turn-1",
    method: "submit_turn",
    params: { sessionKey: "web:smoke", channelKey: "web", message: "hello" },
  }));
  const first = await queue.next();
  const second = await queue.next();
  const final = await queue.next();
  assert.deepEqual(
    [first, second, final].map((frame) => [frame.type, frame.seq, frame.final]),
    [["event", 0, false], ["event", 1, false], ["event", 2, true]],
  );
  assert.equal((final.event as WireFrame).type, "turn_completed");
  await queue.close();

  await server.close();
  const replacement = await startGatewayServer({ gateway: fakeGateway([]), port: Number(new URL(server.url).port), token: "replacement" });
  await replacement.close();
});
