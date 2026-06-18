import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  WeixinChannel,
  type WeixinChannelOptions,
  type WeixinIlinkClient,
} from "../../../../src/adapters/channel/weixin/WeixinChannel.js";
import type { Gateway, GatewayEvent } from "../../../../src/gateway/index.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SentText = {
  userId: string;
  text: string;
  contextToken: string;
};

type SentTyping = {
  userId: string;
  contextToken?: string;
};

class FakeWeixinClient implements WeixinIlinkClient {
  cursor = "";
  readonly sentTexts: SentText[] = [];
  readonly sentTypings: SentTyping[] = [];
  failTyping = false;

  private readonly messages: Array<{
    from_user_id: string;
    text: string;
    context_token: string;
  }> = [];

  enqueueText(input: { fromUser: string; text: string; contextToken?: string }): void {
    this.messages.push({
      from_user_id: input.fromUser,
      text: input.text,
      context_token: input.contextToken ?? `ctx_${input.fromUser}`,
    });
  }

  async poll(): Promise<{
    ret?: number;
    msgs?: Array<{
      from_user_id: string;
      message_type: number;
      context_token: string;
      item_list: Array<{ type: number; text_item: { text: string } }>;
    }>;
    get_updates_buf?: string;
  }> {
    const next = this.messages.shift();
    if (!next) {
      await wait(25);
      return { ret: 0, msgs: [], get_updates_buf: this.cursor };
    }
    await wait(5);
    this.cursor = `cursor_${Date.now()}`;
    return {
      ret: 0,
      get_updates_buf: this.cursor,
      msgs: [
        {
          from_user_id: next.from_user_id,
          message_type: 1,
          context_token: next.context_token,
          item_list: [{ type: 1, text_item: { text: next.text } }],
        },
      ],
    };
  }

  async sendTextChunked(userId: string, text: string, contextToken: string): Promise<number> {
    this.sentTexts.push({ userId, text, contextToken });
    return 1;
  }

  async sendTyping(userId: string, contextToken?: string): Promise<void> {
    this.sentTypings.push({ userId, contextToken });
    if (this.failTyping) {
      throw new Error("typing failed");
    }
  }
}

async function* events(items: GatewayEvent[]): AsyncIterable<GatewayEvent> {
  for (const item of items) {
    yield item;
  }
}

function makeGateway(
  items: GatewayEvent[] | (() => AsyncIterable<GatewayEvent>),
  options: {
    abortTurn?: Gateway["abortTurn"];
    respondElicitation?: Gateway["respondElicitation"];
  } = {},
): Gateway {
  return {
    submitTurn: () => Array.isArray(items) ? events(items) : items(),
    abortTurn: options.abortTurn ?? (async () => undefined),
    respondElicitation: options.respondElicitation ?? (async () => ({ delivered: true })),
  } as unknown as Gateway;
}

function makeCredentialsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-weixin-test-"));
  const credentialsPath = join(dir, "weixin-credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      baseUrl: "https://ilink.example.test",
      botToken: "token",
      accountId: "account",
    }),
    "utf-8",
  );
  return credentialsPath;
}

async function startChannel(input: {
  client: FakeWeixinClient;
  gateway: Gateway;
  liveReplyOptions?: WeixinChannelOptions["liveReplyOptions"];
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<{ channel: WeixinChannel; stop: () => Promise<void> }> {
  const channel = new WeixinChannel({
    credentialsPath: makeCredentialsPath(),
    clientFactory: () => input.client,
    liveReplyOptions: input.liveReplyOptions,
  });
  const handle = await channel.start({
    gateway: input.gateway,
    logger: input.logger,
  });
  return {
    channel,
    stop: () => handle.stop("test"),
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await wait(5);
  }
  assert.fail(label);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("weixin buffers assistant deltas and sends one final reply", async () => {
  const client = new FakeWeixinClient();
  client.enqueueText({ fromUser: "wx_1", text: "hi", contextToken: "ctx_1" });
  const { stop } = await startChannel({
    client,
    gateway: makeGateway([
      { type: "assistant_text_delta", text: "hello" },
      { type: "assistant_text_delta", text: " world" },
    ]),
  });

  try {
    await waitFor(() => client.sentTexts.length === 1, "expected one final Weixin message");
    assert.deepEqual(client.sentTexts, [{ userId: "wx_1", text: "hello world", contextToken: "ctx_1" }]);
  } finally {
    await stop();
  }
});

test("weixin uses native typing for long activity without sending status text", async () => {
  const client = new FakeWeixinClient();
  client.enqueueText({ fromUser: "wx_activity", text: "hi", contextToken: "ctx_activity" });
  const { stop } = await startChannel({
    client,
    liveReplyOptions: { activityDelayMs: 5, activityUpdateThrottleMs: 10_000 },
    gateway: makeGateway(async function* () {
      yield { type: "turn_started", runId: "run_activity" };
      yield { type: "model_request_started", model: "m", provider: "p" };
      yield {
        type: "agent_status",
        event: "subagent_started",
        detail: { subagentId: "s1", subagentType: "general" },
      };
      yield { type: "tool_call_started", toolCallId: "tool_1", name: "web_fetch" };
      await wait(20);
      yield { type: "assistant_text_delta", text: "done" };
    }),
  });

  try {
    await waitFor(() => client.sentTexts.length === 1, "expected final Weixin answer");
    assert.equal(client.sentTexts[0]?.text, "done");
    assert.ok(client.sentTypings.length >= 1);
    assert.equal(client.sentTexts.some((item) => item.text.includes("正在")), false);
  } finally {
    await stop();
  }
});

test("weixin watchdog aborts long turns and sends timeout guidance once", async () => {
  const client = new FakeWeixinClient();
  const releaseTurn = deferred();
  const aborts: Array<{ sessionKey: string; runId?: string }> = [];
  client.enqueueText({ fromUser: "wx_timeout", text: "hi", contextToken: "ctx_timeout" });
  const { stop } = await startChannel({
    client,
    liveReplyOptions: {
      activityDelayMs: 5,
      activityUpdateThrottleMs: 10_000,
      turnTimeoutMs: 20,
    },
    gateway: makeGateway(async function* () {
      yield { type: "turn_started", runId: "run_timeout" };
      yield { type: "model_request_started", model: "m", provider: "p" };
      await releaseTurn.promise;
    }, {
      abortTurn: async (input) => {
        aborts.push(input);
        releaseTurn.resolve();
      },
    }),
  });

  try {
    await waitFor(
      () => aborts.length === 1 && client.sentTexts.length === 1,
      "expected timeout abort and guidance",
    );
    assert.deepEqual(aborts, [{ sessionKey: "weixin:chat=wx_timeout:general", runId: "run_timeout" }]);
    assert.deepEqual(client.sentTexts, [
      { userId: "wx_timeout", text: "处理超时，请重新发送或稍后重试。", contextToken: "ctx_timeout" },
    ]);
  } finally {
    releaseTurn.resolve();
    await stop();
  }
});

test("weixin agent_aborted sends abort guidance without raw error text", async () => {
  const client = new FakeWeixinClient();
  client.enqueueText({ fromUser: "wx_abort", text: "hi", contextToken: "ctx_abort" });
  const { stop } = await startChannel({
    client,
    liveReplyOptions: { activityDelayMs: 5, activityUpdateThrottleMs: 10_000 },
    gateway: makeGateway(async function* () {
      yield { type: "turn_started", runId: "run_abort" };
      yield { type: "model_request_started", model: "m", provider: "p" };
      await wait(20);
      yield { type: "error", code: "agent_aborted", message: "Session aborted.", recoverable: true };
    }),
  });

  try {
    await waitFor(() => client.sentTexts.length === 1, "expected abort guidance");
    assert.deepEqual(client.sentTexts, [
      { userId: "wx_abort", text: "处理已中止，请重新发送或稍后重试。", contextToken: "ctx_abort" },
    ]);
  } finally {
    await stop();
  }
});

test("weixin elicitation request is sent immediately", async () => {
  const client = new FakeWeixinClient();
  client.enqueueText({ fromUser: "wx_elicit", text: "hi", contextToken: "ctx_elicit" });
  const { stop } = await startChannel({
    client,
    liveReplyOptions: { activityDelayMs: 5 },
    gateway: makeGateway([
      { type: "model_request_started", model: "m", provider: "p" },
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

  try {
    await waitFor(() => client.sentTexts.length === 1, "expected elicitation text");
    assert.match(client.sentTexts[0]?.text ?? "", /继续吗/);
    assert.equal(client.sentTexts[0]?.userId, "wx_elicit");
  } finally {
    await stop();
  }
});

test("weixin typing failures do not prevent the final reply", async () => {
  const warnings: string[] = [];
  const client = new FakeWeixinClient();
  client.failTyping = true;
  client.enqueueText({ fromUser: "wx_typing_fail", text: "hi", contextToken: "ctx_typing_fail" });
  const { stop } = await startChannel({
    client,
    liveReplyOptions: { activityDelayMs: 5, activityUpdateThrottleMs: 10_000 },
    logger: { warn: (message) => warnings.push(message) },
    gateway: makeGateway(async function* () {
      yield { type: "turn_started", runId: "run_typing_fail" };
      yield { type: "model_request_started", model: "m", provider: "p" };
      await wait(20);
      yield { type: "assistant_text_delta", text: "still works" };
    }),
  });

  try {
    await waitFor(() => client.sentTexts.length === 1, "expected final reply after typing failure");
    assert.equal(client.sentTexts[0]?.text, "still works");
    assert.ok(client.sentTypings.length >= 1);
    assert.ok(warnings.some((message) => message.includes("sendTyping failed")));
  } finally {
    await stop();
  }
});
