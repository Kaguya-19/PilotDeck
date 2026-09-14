import assert from "node:assert/strict";
import test from "node:test";

import { SteerMailbox } from "../../../src/agent/session/SteerMailbox.js";
import type { AgentSteerMessage } from "../../../src/agent/session/SteerMailbox.js";

function steer(itemId: string, text = itemId): AgentSteerMessage {
  return {
    itemId,
    message: {
      role: "user",
      content: [{ type: "text", text }],
      metadata: { purpose: "mid_turn_steer", queueItemId: itemId },
    },
  };
}

test("steer mailbox accepts only the active turn and deduplicates retries", async () => {
  const mailbox = new SteerMailbox();
  assert.deepEqual(await mailbox.enqueue("turn-1", steer("item-1")), {
    accepted: false,
    reason: "no_active_turn",
  });

  mailbox.start("turn-1");
  assert.deepEqual(await mailbox.enqueue("turn-2", steer("item-1")), {
    accepted: false,
    reason: "turn_mismatch",
  });
  assert.deepEqual(await mailbox.enqueue("turn-1", steer("item-1", "adjust direction")), {
    accepted: true,
  });
  assert.deepEqual(await mailbox.enqueue("turn-1", steer("item-1", "duplicate retry")), {
    accepted: true,
  });
  assert.deepEqual(mailbox.drain("turn-1").map((entry) => entry.itemId), ["item-1"]);
  assert.deepEqual(mailbox.drain("turn-1"), []);
});

test("drainOrClose removes the terminal race without dropping accepted guidance", async () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  await mailbox.enqueue("turn-1", steer("item-1"));

  const firstBoundary = mailbox.drainOrClose("turn-1");
  assert.equal(firstBoundary.closed, false);
  assert.deepEqual(firstBoundary.messages.map((entry) => entry.itemId), ["item-1"]);

  const terminalBoundary = mailbox.drainOrClose("turn-1");
  assert.deepEqual(terminalBoundary, { messages: [], closed: true });
  assert.deepEqual(await mailbox.enqueue("turn-1", steer("item-2")), {
    accepted: false,
    reason: "turn_closing",
  });
});

test("finish returns unconsumed guidance so callers can leave it queued", async () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  await mailbox.enqueue("turn-1", steer("item-1"));

  assert.deepEqual(mailbox.finish("turn-1").map((entry) => entry.itemId), ["item-1"]);
  assert.deepEqual(await mailbox.enqueue("turn-1", steer("item-2")), {
    accepted: false,
    reason: "no_active_turn",
  });
});

test("close returns pending guidance while rejecting late submissions as turn_closing", async () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  await mailbox.enqueue("turn-1", steer("item-1"));

  assert.deepEqual((await mailbox.close("turn-1")).map((entry) => entry.itemId), ["item-1"]);
  assert.deepEqual(await mailbox.enqueue("turn-1", steer("item-2")), {
    accepted: false,
    reason: "turn_closing",
  });
  assert.deepEqual(mailbox.finish("turn-1"), []);
});

test("pending guidance can be cancelled before a model boundary", async () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  await mailbox.enqueue("turn-1", steer("item-1"));

  assert.deepEqual(await mailbox.cancel("turn-1", "item-1"), { cancelled: true });
  assert.deepEqual(await mailbox.cancel("turn-1", "item-1"), { cancelled: true });
  assert.deepEqual(mailbox.drain("turn-1"), []);
});

test("cancel tombstones win a race with enqueue, but drained guidance is too late", async () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");

  assert.deepEqual(await mailbox.cancel("turn-1", "item-before-enqueue"), { cancelled: true });
  assert.deepEqual(await mailbox.enqueue("turn-1", steer("item-before-enqueue")), {
    accepted: false,
    reason: "cancelled",
  });

  await mailbox.enqueue("turn-1", steer("item-drained"));
  assert.deepEqual(mailbox.drain("turn-1").map((entry) => entry.itemId), ["item-drained"]);
  assert.deepEqual(await mailbox.cancel("turn-1", "item-drained"), {
    cancelled: false,
    reason: "too_late",
  });
});

test("mailbox records insert, claim, cancel, and discard before mutating state", async () => {
  const mutations: string[] = [];
  const mailbox = new SteerMailbox({
    recordMutation: async (_turnId, mutation) => {
      mutations.push(`${mutation.mutation}:${mutation.itemId}`);
    },
  });
  mailbox.start("turn-1");

  await mailbox.enqueue("turn-1", steer("claimed"));
  assert.deepEqual(mailbox.drain("turn-1").map((entry) => entry.itemId), ["claimed"]);
  await mailbox.claim("turn-1", "claimed");
  mailbox.ack("turn-1", "claimed");

  await mailbox.enqueue("turn-1", steer("cancelled"));
  await mailbox.cancel("turn-1", "cancelled");
  await mailbox.enqueue("turn-1", steer("discarded"));
  assert.deepEqual((await mailbox.close("turn-1")).map((entry) => entry.itemId), ["discarded"]);

  assert.deepEqual(mutations, [
    "insert:claimed",
    "claim:claimed",
    "insert:cancelled",
    "cancel:cancelled",
    "insert:discarded",
    "discard:discarded",
  ]);
});

test("enqueue finishing after terminal close is durably discarded and rejected", async () => {
  let releaseInsert: (() => void) | undefined;
  const insertStarted = new Promise<void>((resolve) => {
    releaseInsert = resolve;
  });
  let allowInsert: (() => void) | undefined;
  const insertBlocked = new Promise<void>((resolve) => {
    allowInsert = resolve;
  });
  const mutations: string[] = [];
  const mailbox = new SteerMailbox({
    recordMutation: async (_turnId, mutation) => {
      mutations.push(mutation.mutation);
      if (mutation.mutation === "insert") {
        releaseInsert?.();
        await insertBlocked;
      }
    },
  });
  mailbox.start("turn-1");

  const pending = mailbox.enqueue("turn-1", steer("late"));
  await insertStarted;
  const closing = mailbox.close("turn-1");
  allowInsert?.();

  assert.deepEqual(await pending, { accepted: false, reason: "turn_closing" });
  assert.deepEqual(await closing, []);
  assert.deepEqual(mutations, ["insert", "discard"]);
});
