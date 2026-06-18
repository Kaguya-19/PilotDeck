import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSubmitOptions, AgentInput } from "../../src/agent/index.js";
import { InProcessGateway, type GatewayEvent, type GatewaySessionContext } from "../../src/gateway/index.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

type SubmitCall = {
  input: AgentInput;
  options: AgentSubmitOptions;
};

function makeGateway() {
  const calls: SubmitCall[] = [];
  const contexts: GatewaySessionContext[] = [];
  const session = {
    async *submit(input: AgentInput, options: AgentSubmitOptions) {
      calls.push({ input, options });
      yield { type: "turn_started", sessionId: "s", turnId: options.turnId ?? "r" };
      yield {
        type: "turn_completed",
        sessionId: "s",
        turnId: options.turnId ?? "r",
        result: {
          type: "success",
          sessionId: "s",
          turnId: options.turnId ?? "r",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(0).toISOString(),
        },
      };
    },
  };
  const router = {
    beginTurn: () => true,
    getOrCreate: async (context: GatewaySessionContext) => {
      contexts.push(context);
      return session;
    },
    endTurn: () => undefined,
  } as unknown as SessionRouter;

  const gateway = new InProcessGateway(router, {
    uuid: () => "run_1",
    telemetry: {
      trackFeatureLoopStage: () => undefined,
      trackError: () => undefined,
    } as never,
  });
  return { calls, contexts, gateway };
}

async function collect(stream: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

test("feishu ordinary turns do not allow plan mode tools", async () => {
  const { calls, gateway } = makeGateway();

  await collect(gateway.submitTurn({
    sessionKey: "feishu:chat=oc_1:general",
    channelKey: "feishu",
    message: "做一个官网",
  }));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.input, { type: "text", text: "做一个官网" });
  assert.equal(calls[0]?.options.permissionMode, undefined);
  assert.equal(calls[0]?.options.allowPlanModeTools, false);
});

test("feishu /plan turns enter plan mode and allow plan mode tools", async () => {
  const { calls, gateway } = makeGateway();

  await collect(gateway.submitTurn({
    sessionKey: "feishu:chat=oc_1:general",
    channelKey: "feishu",
    message: "/plan 做一个官网",
  }));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.input, { type: "text", text: "做一个官网" });
  assert.equal(calls[0]?.options.permissionMode, "plan");
  assert.equal(calls[0]?.options.basePermissionMode, "default");
  assert.equal(calls[0]?.options.allowPlanModeTools, true);
});

test("empty /plan returns usage without starting an agent turn", async () => {
  const { calls, gateway } = makeGateway();

  const events = await collect(gateway.submitTurn({
    sessionKey: "feishu:chat=oc_1:general",
    channelKey: "feishu",
    message: "/plan",
  }));

  assert.equal(calls.length, 0);
  assert.deepEqual(events, [
    { type: "assistant_text_delta", text: "用法：/plan <任务>\n例如：/plan 设计一个新功能" },
    { type: "turn_completed", usage: {}, finishReason: "completed" },
  ]);
});

test("web turns allow plan mode tools by default", async () => {
  const { calls, gateway } = makeGateway();

  await collect(gateway.submitTurn({
    sessionKey: "web:session=1",
    channelKey: "web",
    message: "做一个官网",
  }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options.allowPlanModeTools, true);
});
