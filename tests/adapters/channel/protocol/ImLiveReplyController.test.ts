import assert from "node:assert/strict";
import { test } from "node:test";
import { ImLiveReplyController, type ImLiveReplyTransport } from "../../../../src/adapters/channel/protocol/ImLiveReplyController.js";

type Call =
  | { kind: "send"; text: string }
  | { kind: "edit"; handle: string; text: string };

function makeTransport(options: {
  editable?: boolean;
  failEditAt?: number;
} = {}): { calls: Call[]; transport: ImLiveReplyTransport<string> } {
  const calls: Call[] = [];
  let nextHandle = 1;
  let editCount = 0;
  return {
    calls,
    transport: {
      send: async (text) => {
        calls.push({ kind: "send", text });
        if (options.editable === false) return undefined;
        return `m${nextHandle++}`;
      },
      edit: options.editable === false
        ? undefined
        : async (handle, text) => {
            editCount++;
            if (options.failEditAt === editCount) {
              return false;
            }
            calls.push({ kind: "edit", handle, text });
            return true;
          },
    },
  };
}

test("first assistant delta sends an immediate live preview", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({ transport, throttleMs: 10_000 });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });

  assert.deepEqual(calls, [{ kind: "send", text: "hello ▉" }]);
});

test("multiple deltas are throttled into a limited edit", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    throttleMs: 10_000,
    bufferThreshold: 1_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await controller.handleEvent({ type: "assistant_text_delta", text: " " });
  await controller.handleEvent({ type: "assistant_text_delta", text: "world" });

  assert.deepEqual(calls, [{ kind: "send", text: "hello ▉" }]);

  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "hello ▉" },
    { kind: "edit", handle: "m1", text: "hello world" },
  ]);
});

test("tool boundary finalizes the current segment and starts a new one", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({ transport, throttleMs: 10_000 });

  await controller.handleEvent({ type: "assistant_text_delta", text: "before tool" });
  await controller.handleEvent({ type: "tool_call_started", toolCallId: "t1", name: "shell" });
  await controller.handleEvent({ type: "assistant_text_delta", text: "after tool" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "before tool ▉" },
    { kind: "edit", handle: "m1", text: "before tool" },
    { kind: "send", text: "after tool ▉" },
    { kind: "edit", handle: "m2", text: "after tool" },
  ]);
});

test("final flush removes cursor from the visible message", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({ transport, throttleMs: 10_000 });

  await controller.handleEvent({ type: "assistant_text_delta", text: "done" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "done ▉" },
    { kind: "edit", handle: "m1", text: "done" },
  ]);
});

test("edit failure sends only the unseen continuation", async () => {
  const { calls, transport } = makeTransport({ failEditAt: 1 });
  const controller = new ImLiveReplyController({ transport, throttleMs: 10_000 });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await controller.handleEvent({ type: "assistant_text_delta", text: " world" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "hello ▉" },
    { kind: "edit", handle: "m1", text: "hello" },
    { kind: "send", text: "world" },
  ]);
});

test("non-editable transport sends preview and final continuation", async () => {
  const { calls, transport } = makeTransport({ editable: false });
  const controller = new ImLiveReplyController({ transport, throttleMs: 10_000 });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await controller.handleEvent({ type: "assistant_text_delta", text: " world" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "hello ▉" },
    { kind: "send", text: "world" },
  ]);
});

test("long replies split into multiple live segments", async () => {
  const { calls, transport } = makeTransport();
  transport.maxMessageLength = 8;
  const controller = new ImLiveReplyController({
    transport,
    throttleMs: 10_000,
    cursor: " ▉",
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "abcdefghij" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "abcdef ▉" },
    { kind: "edit", handle: "m1", text: "abcdef" },
    { kind: "send", text: "ghij ▉" },
    { kind: "edit", handle: "m2", text: "ghij" },
  ]);
});

test("initial send failure does not mark text as visible", async () => {
  const calls: Call[] = [];
  const controller = new ImLiveReplyController<string>({
    transport: {
      send: async (text) => {
        calls.push({ kind: "send", text });
        return false;
      },
      edit: async (handle, text) => {
        calls.push({ kind: "edit", handle, text });
        return true;
      },
    },
    throttleMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await controller.handleEvent({ type: "assistant_text_delta", text: " world" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "hello ▉" },
    { kind: "send", text: "hello world" },
  ]);
});
