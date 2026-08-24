import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createWebSocketAcceptValue,
  TextWebSocketConnection,
} from "../../src/gateway/server/websocket.js";

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  ended = false;

  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

function maskedFrame(payload: Buffer, opcode = 0x1, mask = Buffer.from([1, 2, 3, 4])): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const encoded = Buffer.from(payload);
  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] ^= mask[index % mask.length]!;
  }
  return Buffer.concat([header, mask, encoded]);
}

test("createWebSocketAcceptValue follows the RFC example", () => {
  assert.equal(
    createWebSocketAcceptValue("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

test("TextWebSocketConnection receives fragmented text and answers ping", () => {
  const socket = new FakeSocket();
  const connection = new TextWebSocketConnection(socket as never);
  const messages: string[] = [];
  const closes: number[] = [];
  connection.onMessage((message) => messages.push(message));
  connection.onClose(() => closes.push(1));
  const frame = maskedFrame(Buffer.from("hello"));
  socket.emit("data", frame.subarray(0, 3));
  assert.deepEqual(messages, []);
  socket.emit("data", frame.subarray(3));
  assert.deepEqual(messages, ["hello"]);

  socket.emit("data", maskedFrame(Buffer.from("ping"), 0x9));
  assert.equal(socket.writes.at(-1)?.[0], 0x8a);
  assert.equal(socket.writes.at(-1)?.subarray(2).toString(), "ping");

  socket.emit("close");
  socket.emit("error", new Error("late error"));
  assert.deepEqual(closes, [1]);
});

test("TextWebSocketConnection handles extended payload lengths and outbound frames", () => {
  const socket = new FakeSocket();
  const connection = new TextWebSocketConnection(socket as never);
  const messages: string[] = [];
  connection.onMessage((message) => messages.push(message));
  const medium = Buffer.alloc(126, "m");
  socket.emit("data", maskedFrame(medium));
  assert.equal(messages[0]?.length, 126);

  connection.sendText("short");
  assert.equal(socket.writes.at(-1)?.[0], 0x81);
  assert.equal(socket.writes.at(-1)?.[1], 5);
  connection.sendText("x".repeat(126));
  assert.deepEqual([...socket.writes.at(-1)!.subarray(0, 4)], [0x81, 126, 0, 126]);
  connection.sendText("x".repeat(65_536));
  assert.equal(socket.writes.at(-1)?.[1], 127);
  assert.equal(socket.writes.at(-1)?.readBigUInt64BE(2), 65_536n);
});

test("TextWebSocketConnection closes on client close and rejects invalid frames", () => {
  const socket = new FakeSocket();
  const connection = new TextWebSocketConnection(socket as never);
  socket.emit("data", maskedFrame(Buffer.alloc(0), 0x8));
  assert.equal(socket.ended, true);
  assert.equal(socket.writes.at(-1)?.[0], 0x88);

  const unmaskedSocket = new FakeSocket();
  new TextWebSocketConnection(unmaskedSocket as never);
  assert.throws(() => unmaskedSocket.emit("data", Buffer.from([0x81, 0x01, 0x78])), /masked/);

  const hugeSocket = new FakeSocket();
  new TextWebSocketConnection(hugeSocket as never);
  const hugeHeader = Buffer.alloc(10);
  hugeHeader[0] = 0x81;
  hugeHeader[1] = 0xff;
  hugeHeader.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 2);
  assert.throws(() => hugeSocket.emit("data", hugeHeader), /too large/);
});
