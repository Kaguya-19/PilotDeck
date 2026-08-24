import assert from "node:assert/strict";
import test from "node:test";

import {
  GatewayRequestError,
  GatewayWsClient,
} from "../../src/gateway/client/GatewayWsClient.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";

type Listener = (event: { data?: unknown; reason?: string; code?: number }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(message: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(message);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  message(frame: unknown): void {
    this.dispatch("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }

  fail(): void {
    this.dispatch("error", {});
  }

  private dispatch(type: string, event: { data?: unknown; reason?: string; code?: number }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

async function connectClient(t: { after(callback: () => void): void }): Promise<{ client: GatewayWsClient; socket: FakeWebSocket }> {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const client = new GatewayWsClient({ url: "ws://gateway.test/ws", token: "secret", clientName: "test" });
  const connected = client.connect();
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "0.1.0",
    token: "secret",
  });
  socket.message({
    type: "hello_ok",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    serverVersion: "test",
    serverInfo: { mode: "test" },
  });
  await assert.doesNotReject(connected);
  return { client, socket };
}

test("GatewayWsClient connects, sends hello, and exposes notifications", async (t) => {
  const { client, socket } = await connectClient(t);
  const notifications: unknown[] = [];
  client.onNotification((name, payload) => {
    notifications.push({ name, payload });
    throw new Error("handler failure must be isolated");
  });
  socket.message({ type: "notification", name: "config_changed", payload: { paths: ["agent.model"] } });
  assert.deepEqual(notifications, [{ name: "config_changed", payload: { paths: ["agent.model"] } }]);
  client.close();
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});

test("GatewayWsClient resolves successful RPCs and preserves structured failures", async (t) => {
  const { client, socket } = await connectClient(t);
  const success = client.request("describe_server", {});
  const successFrame = JSON.parse(socket.sent.at(-1)!);
  socket.message({ type: "response", id: successFrame.id, ok: true, result: { mode: "test" } });
  assert.deepEqual(await success, { mode: "test" });

  const failed = client.request("skill_validate", { slug: "demo" });
  const failedFrame = JSON.parse(socket.sent.at(-1)!);
  socket.message({
    type: "response",
    id: failedFrame.id,
    ok: false,
    error: { code: "validation_failed", message: "invalid skill", validation: { slug: "bad" }, details: { source: "test" } },
  });
  await assert.rejects(failed, (error: unknown) => {
    assert(error instanceof GatewayRequestError);
    assert.equal(error.code, "validation_failed");
    assert.equal(error.message, "invalid skill");
    assert.deepEqual(error.validation, { slug: "bad" });
    assert.deepEqual(error.details, { source: "test" });
    return true;
  });
  socket.message({ type: "response", id: "unknown", ok: true, result: {} });
});

test("GatewayWsClient streams events, buffers values, and closes on final", async (t) => {
  const { client, socket } = await connectClient(t);
  const stream = client.stream("submit_turn", { sessionKey: "s", message: "go" });
  const streamFrame = JSON.parse(socket.sent.at(-1)!);
  socket.message({ type: "event", id: streamFrame.id, seq: 0, final: false, event: { type: "assistant_text_delta", text: "one" } });
  socket.message({ type: "event", id: streamFrame.id, seq: 1, final: false, event: { type: "assistant_text_delta", text: "two" } });
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: { type: "assistant_text_delta", text: "one" } });
  assert.deepEqual(await iterator.next(), { done: false, value: { type: "assistant_text_delta", text: "two" } });
  const done = iterator.next();
  socket.message({ type: "event", id: streamFrame.id, seq: 2, final: true, event: { type: "turn_completed" } });
  assert.deepEqual(await done, { done: true, value: undefined });
  socket.message({ type: "event", id: "unknown", seq: 0, final: false, event: { type: "ignored" } });
});

test("GatewayWsClient rejects pending RPCs and streams when the socket closes", async (t) => {
  const { client, socket } = await connectClient(t);
  const request = client.request("list_sessions", {});
  const stream = client.stream("submit_turn", {});
  const next = stream[Symbol.asyncIterator]().next();
  socket.close(1006, "network lost");
  await assert.rejects(request, /Gateway WebSocket closed/);
  await assert.rejects(next, /Gateway WebSocket closed/);
  assert.throws(() => client.request("list_sessions", {}), /not connected/);
  assert.throws(() => client.stream("submit_turn", {}), /not connected/);
});

test("GatewayWsClient rejects connection errors and close-before-hello", async (t) => {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });

  const errorClient = new GatewayWsClient({ url: "ws://gateway.test/ws", token: "secret" });
  const errorConnection = errorClient.connect();
  FakeWebSocket.instances[0]!.fail();
  await assert.rejects(errorConnection, /Failed to connect/);

  const closeClient = new GatewayWsClient({ url: "ws://gateway.test/ws", token: "secret" });
  const closeConnection = closeClient.connect();
  const closeSocket = FakeWebSocket.instances[1]!;
  closeSocket.open();
  await Promise.resolve();
  closeSocket.close(4003, "unauthorized");
  await assert.rejects(closeConnection, /Gateway closed during hello: unauthorized/);
});
