import assert from "node:assert/strict";
import test from "node:test";

import {
  createSendMessageTool,
  createSubagentContinuationTool,
  type SubagentContinuationPort,
} from "../../../src/tool/builtin/subagentContinuation.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

test("subagent tool delegates start to the continuation port and returns admission identity", async () => {
  const calls: unknown[] = [];
  const port: SubagentContinuationPort = {
    async start(request) {
      calls.push(request);
      return { childSessionId: "child-1", itemId: "item-1", turnId: "turn-1" };
    },
    async followup() {
      throw new Error("unexpected followup");
    },
  };
  const controller = new AbortController();

  const result = await createSubagentContinuationTool(port).execute({
    description: "Inspect runtime",
    prompt: "Inspect the runtime composition.",
    subagent_type: "explore",
  }, { abortSignal: controller.signal } as PilotDeckToolRuntimeContext);

  assert.deepEqual(calls, [{
    label: "Inspect runtime",
    definitionId: "explore",
    prompt: "Inspect the runtime composition.",
    abortSignal: controller.signal,
  }]);
  assert.deepEqual(result.data, {
    subagentId: "child-1",
    messageId: "item-1",
    turnId: "turn-1",
  });
  assert.equal(result.content[0]?.type, "text");
});

test("send_message delegates only follow-up admission and never waits for a child result", async () => {
  const calls: unknown[] = [];
  const port: SubagentContinuationPort = {
    async start() {
      throw new Error("unexpected start");
    },
    async followup(request) {
      calls.push(request);
      return { childSessionId: "child-1", itemId: "item-2", turnId: "turn-2" };
    },
  };
  const controller = new AbortController();

  const result = await createSendMessageTool(port).execute({
    subagent_id: "child-1",
    message: "Continue with the remaining checks.",
  }, { abortSignal: controller.signal } as PilotDeckToolRuntimeContext);

  assert.deepEqual(calls, [{
    childSessionId: "child-1",
    message: "Continue with the remaining checks.",
    abortSignal: controller.signal,
  }]);
  assert.deepEqual(result.data, {
    subagentId: "child-1",
    messageId: "item-2",
    turnId: "turn-2",
  });
});

test("continuation tools do not fabricate success when the port rejects admission", async () => {
  const port: SubagentContinuationPort = {
    async start() {
      throw new Error("start admission rejected");
    },
    async followup() {
      throw new Error("follow-up admission rejected");
    },
  };

  await assert.rejects(
    createSubagentContinuationTool(port).execute({
      description: "Inspect runtime",
      prompt: "Inspect.",
    }, {} as PilotDeckToolRuntimeContext),
    /start admission rejected/,
  );
  await assert.rejects(
    createSendMessageTool(port).execute({
      subagent_id: "child-1",
      message: "Continue.",
    }, {} as PilotDeckToolRuntimeContext),
    /follow-up admission rejected/,
  );
});
