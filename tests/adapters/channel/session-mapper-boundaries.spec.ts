import assert from "node:assert/strict";
import test from "node:test";

import { ApiServerSessionMapper } from "../../../src/adapters/channel/api-server/ApiServerSessionMapper.js";
import { BlueBubblesSessionMapper } from "../../../src/adapters/channel/bluebubbles/BlueBubblesSessionMapper.js";
import { DiscordSessionMapper } from "../../../src/adapters/channel/discord/DiscordSessionMapper.js";
import { DingTalkSessionMapper } from "../../../src/adapters/channel/dingtalk/DingTalkSessionMapper.js";
import { EmailSessionMapper } from "../../../src/adapters/channel/email/EmailSessionMapper.js";
import { HomeAssistantSessionMapper } from "../../../src/adapters/channel/homeassistant/HomeAssistantSessionMapper.js";
import { MatrixSessionMapper } from "../../../src/adapters/channel/matrix/MatrixSessionMapper.js";
import { MattermostSessionMapper } from "../../../src/adapters/channel/mattermost/MattermostSessionMapper.js";
import { SignalSessionMapper } from "../../../src/adapters/channel/signal/SignalSessionMapper.js";
import { SlackSessionMapper } from "../../../src/adapters/channel/slack/SlackSessionMapper.js";
import { SmsSessionMapper } from "../../../src/adapters/channel/sms/SmsSessionMapper.js";
import { TelegramSessionMapper } from "../../../src/adapters/channel/telegram/TelegramSessionMapper.js";
import { WebhookSessionMapper } from "../../../src/adapters/channel/webhook/WebhookSessionMapper.js";
import { WeComCallbackSessionMapper } from "../../../src/adapters/channel/wecom-callback/WeComCallbackSessionMapper.js";
import { WhatsAppSessionMapper } from "../../../src/adapters/channel/whatsapp/WhatsAppSessionMapper.js";
import { FeishuSessionMapper } from "../../../src/adapters/channel/feishu/FeishuSessionMapper.js";
import { WeixinSessionMapper } from "../../../src/adapters/channel/weixin/WeixinSessionMapper.js";
import { WeComSessionMapper } from "../../../src/adapters/channel/wecom/WeComSessionMapper.js";
import { QQSessionMapper } from "../../../src/adapters/channel/qq/QQSessionMapper.js";

type CommonMapper = {
  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: string; message: string };
  snapshot(): { activeByChatId: Record<string, string> };
};

const commonMappers: Array<[string, () => CommonMapper]> = [
  ["api-server", () => new ApiServerSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["bluebubbles", () => new BlueBubblesSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["discord", () => new DiscordSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["dingtalk", () => new DingTalkSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["email", () => new EmailSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["homeassistant", () => new HomeAssistantSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["matrix", () => new MatrixSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["mattermost", () => new MattermostSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["signal", () => new SignalSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["slack", () => new SlackSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["sms", () => new SmsSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["telegram", () => new TelegramSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["webhook", () => new WebhookSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["wecom-callback", () => new WeComCallbackSessionMapper({ activeByChatId: {} }, () => "fixed")],
  ["whatsapp", () => new WhatsAppSessionMapper({ activeByChatId: {} }, () => "fixed")],
];

const sessionPrefixes: Record<string, string> = {
  "api-server": "api_server",
  "wecom-callback": "wecom_callback",
};

for (const [name, create] of commonMappers) {
  test(`${name} session mapper keeps a stable default and handles /new`, () => {
    const mapper = create();
    const prefix = sessionPrefixes[name] ?? name;
    const initial = mapper.resolve({ chatId: "chat-1", text: "  hello  " });
    assert.equal(initial.sessionKey, `${prefix}:chat=chat-1:general`);
    assert.equal(initial.message, "hello");

    const created = mapper.resolve({ chatId: "chat-1", text: " /new  next prompt " });
    assert.equal(created.command, "new");
    assert.equal(created.sessionKey, `${prefix}:chat=chat-1:s_fixed`);
    assert.equal(created.message, "next prompt");
    assert.equal(mapper.resolve({ chatId: "chat-1", text: "follow up" }).sessionKey, created.sessionKey);

    const snapshot = mapper.snapshot();
    snapshot.activeByChatId["chat-1"] = "mutated";
    assert.equal(mapper.snapshot().activeByChatId["chat-1"], created.sessionKey);
  });
}

test("Feishu session mapper handles project commands and snapshot isolation", () => {
  const mapper = new FeishuSessionMapper({ activeByChatId: {}, projectByChatId: {} }, () => "fixed");
  mapper.bindProject("chat", "project-a");
  assert.equal(mapper.getProject("chat"), "project-a");
  assert.deepEqual(mapper.resolve({ chatId: "chat", text: "/projects" }), {
    sessionKey: "feishu:chat=chat:general", projectKey: "project-a", command: "projects", message: "",
  });
  assert.deepEqual(mapper.resolve({ chatId: "chat", text: "/switch-project project-b" }), {
    sessionKey: "feishu:chat=chat:general", projectKey: "project-a", command: "switch-project", commandArg: "project-b", message: "",
  });
  assert.equal(mapper.resolve({ chatId: "chat", text: "/new hello" }).sessionKey, "feishu:chat=chat:s_fixed");
  assert.equal(mapper.getSession("chat"), "feishu:chat=chat:s_fixed");
  const snapshot = mapper.snapshot();
  snapshot.activeByChatId.chat = "mutated";
  assert.equal(mapper.getSession("chat"), "feishu:chat=chat:s_fixed");
});

test("Weixin session mapper preserves project bindings and new-session messages", () => {
  const mapper = new WeixinSessionMapper({ activeByChatId: {}, projectByChatId: {} }, () => "fixed");
  mapper.bindProject("chat", "project-a");
  assert.equal(mapper.getProject("chat"), "project-a");
  assert.deepEqual(mapper.resolve({ chatId: "chat", text: "hello" }), {
    sessionKey: "weixin:chat=chat:general", projectKey: "project-a", message: "hello",
  });
  assert.deepEqual(mapper.resolve({ chatId: "chat", text: "/new work" }), {
    sessionKey: "weixin:chat=chat:s_fixed", projectKey: "project-a", command: "new", message: "work",
  });
  assert.equal(mapper.getSession("chat"), "weixin:chat=chat:s_fixed");
});

test("WeCom session mapper isolates group sessions by user when configured", () => {
  const mapper = new WeComSessionMapper({ activeByChatId: {} }, () => "fixed");
  const userScope = { chatId: "group", userId: "user", chatType: "group" as const };
  assert.equal(mapper.resolve({ ...userScope, text: "hello" }).sessionKey, "wecom:group=group:user=user:general");
  mapper.bindProject(userScope, "project-a");
  assert.equal(mapper.getProject(userScope), "project-a");
  assert.equal(mapper.resolve({ ...userScope, text: "/new next" }).sessionKey, "wecom:group=group:user=user:s_fixed");
  assert.equal(mapper.resolve({ chatId: "group", chatType: "group", groupSessionsPerUser: false, text: "shared" }).sessionKey, "wecom:group=group:general");
  assert.equal(mapper.resolve({ chatId: "dm", userId: "user", chatType: "dm", text: "dm" }).sessionKey, "wecom:dm=user:general");
});

test("QQ session mapper keeps group/user keys separate and handles /new", () => {
  const mapper = new QQSessionMapper({ activeByChatKey: {} }, () => "fixed");
  assert.equal(mapper.resolve({ groupId: "group", userId: "user", text: "hello" }).sessionKey, "qq:group=group:user=user:general");
  const created = mapper.resolve({ groupId: "group", userId: "user", text: "/new  task" });
  assert.deepEqual(created, {
    sessionKey: "qq:group=group:user=user:s_fixed", command: "new", message: "task",
  });
  assert.equal(mapper.snapshot().activeByChatKey["group:user"], created.sessionKey);
});
