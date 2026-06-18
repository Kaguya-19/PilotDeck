import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { FeishuChannel } from "../../../../src/adapters/channel/feishu/FeishuChannel.js";
import type { Gateway, GatewayEvent } from "../../../../src/gateway/index.js";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function makeResponse(): PassThrough {
  const response = new PassThrough() as PassThrough & {
    writeHead(statusCode: number, headers?: Record<string, string>): void;
    statusCode?: number;
    headers?: Record<string, string>;
  };
  response.writeHead = (statusCode: number, headers?: Record<string, string>) => {
    response.statusCode = statusCode;
    response.headers = headers;
  };
  return response;
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function* events(items: GatewayEvent[]): AsyncIterable<GatewayEvent> {
  for (const item of items) {
    yield item;
  }
}

function makeGateway(items: GatewayEvent[]): Gateway {
  return {
    submitTurn: () => events(items),
  } as unknown as Gateway;
}

async function runWebhook(channel: FeishuChannel, body: unknown): Promise<void> {
  const req = new PassThrough();
  const res = makeResponse();
  await channel.handleWebhook(req as any, res as any, JSON.stringify(body));
  await new Promise((resolve) => setImmediate(resolve));
}

test("feishu live reply sends assistant delta before turn completion", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (init?.method === "POST" && String(url).includes("/im/v1/messages?")) {
      return jsonResponse({ code: 0, data: { message_id: "om_1" } });
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ code: 0 });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;

  try {
    const channel = new FeishuChannel({ appId: "cli_a", appSecret: "secret", connectionMode: "webhook" });
    await channel.start({ gateway: makeGateway([{ type: "assistant_text_delta", text: "hello" }]) });
    await runWebhook(channel, { chatId: "oc_1", text: "hi", eventId: "evt_1" });

    const send = calls.find((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?"));
    const edit = calls.find((call) => call.init?.method === "PATCH");

    assert.ok(send, "expected Feishu create message call");
    assert.ok(edit, "expected Feishu update message call");
    assert.deepEqual(JSON.parse(String(send.init?.body)), {
      receive_id: "oc_1",
      msg_type: "text",
      content: JSON.stringify({ text: "hello ▉" }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("feishu live reply falls back to final continuation when update fails", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ code: 99991672, msg: "permission denied" });
    }
    if (init?.method === "POST" && String(url).includes("/im/v1/messages?")) {
      const messageNo = calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?")).length;
      return jsonResponse({ code: 0, data: { message_id: `om_${messageNo}` } });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;

  try {
    const channel = new FeishuChannel({ appId: "cli_a", appSecret: "secret", connectionMode: "webhook" });
    await channel.start({
      gateway: makeGateway([
        { type: "assistant_text_delta", text: "hello" },
        { type: "assistant_text_delta", text: " world" },
      ]),
      logger: { warn: () => undefined },
    });
    await runWebhook(channel, { chatId: "oc_2", text: "hi", eventId: "evt_2" });

    const sends = calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?"));
    assert.equal(sends.length, 2);
    assert.equal(JSON.parse(String(sends[0]?.init?.body)).content, JSON.stringify({ text: "hello ▉" }));
    assert.equal(JSON.parse(String(sends[1]?.init?.body)).content, JSON.stringify({ text: "world" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("feishu elicitation request is delivered by existing immediate path", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    send: async (message) => {
      sent.push(message);
    },
  });
  await channel.start({
    gateway: makeGateway([
      {
        type: "elicitation_request",
        requestId: "req_1",
        toolCallId: "tool_1",
        toolName: "ask_user_question",
        questions: [
          {
            header: "确认",
            question: "继续吗？",
            options: [{ label: "继续", description: "执行下一步" }],
          },
        ],
      },
    ]),
  });

  await runWebhook(channel, { chatId: "oc_3", text: "hi", eventId: "evt_3" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chatId, "oc_3");
  assert.match(sent[0]?.text ?? "", /继续吗/);
});
