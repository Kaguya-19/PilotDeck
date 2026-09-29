import assert from "node:assert/strict";
import test from "node:test";

import type {
  ChannelAdapter,
  FeishuChannel,
  FeishuChannelOptions,
  QQChannel,
  QQChannelOptions,
  WeComChannel,
  WeComChannelOptions,
  WeixinChannel,
  WeixinChannelOptions,
} from "../../src/adapters/index.js";
import {
  ChannelAdapterBundle,
  type ChannelAdapterBundleOptions,
} from "../../src/cli/ChannelAdapterBundle.js";
import type { PilotConfig } from "../../src/pilot/index.js";

type CapturedOptions = {
  feishu: FeishuChannelOptions[];
  weixin: WeixinChannelOptions[];
  qq: QQChannelOptions[];
  wecom: WeComChannelOptions[];
};

function fakeChannel(channelKey: string): ChannelAdapter {
  return {
    channelKey: channelKey as ChannelAdapter["channelKey"],
    async start() {
      return { async stop() {} };
    },
  };
}

function enabledAdapterConfig(): Pick<PilotConfig, "adapters"> {
  return {
    adapters: {
      feishu: {
        enabled: true,
        appId: "feishu-app",
        appSecret: "feishu-secret",
        defaultSessionLabel: "default",
      },
      weixin: { enabled: true },
      qq: {
        enabled: true,
        appId: "qq-app",
        clientSecret: "qq-secret",
        allowGroups: ["team"],
      },
      wecom: {
        enabled: true,
        token: "wecom-token",
        extra: { webhook: "https://example.test/wecom" },
      },
      telegram: { enabled: true },
    },
  };
}

function createBundle(events: string[], captured: CapturedOptions): ChannelAdapterBundle {
  const state = new Map<string, unknown>([
    ["feishu", { activeByChatId: {}, projectByChatId: {} }],
    ["weixin", { activeByChatId: {} }],
    ["qq", { activeByChatKey: {} }],
    ["wecom", { activeByChatId: {} }],
  ]);
  const options: ChannelAdapterBundleOptions = {
    pilotHome: "/tmp/pilotdeck-channel-adapter-bundle",
    statePersistence: {
      async load<T>(key: string): Promise<T | undefined> {
        events.push(`load:${key}`);
        return state.get(key) as T | undefined;
      },
      save(key: string, value: unknown): void {
        events.push(`save:${key}`);
        state.set(key, value);
      },
      async flush(): Promise<void> {
        events.push("flush");
      },
    },
    async loadEnabledChannels(adapters) {
      events.push("load:configured");
      return adapters?.telegram?.enabled ? [fakeChannel("telegram")] : [];
    },
    createFeishu(input) {
      captured.feishu.push(input);
      return fakeChannel("feishu") as FeishuChannel;
    },
    createWeixin(input) {
      captured.weixin.push(input);
      return fakeChannel("weixin") as WeixinChannel;
    },
    createQQ(input) {
      captured.qq.push(input);
      return fakeChannel("qq") as QQChannel;
    },
    createWeCom(input) {
      captured.wecom.push(input);
      return fakeChannel("wecom") as WeComChannel;
    },
  };
  return new ChannelAdapterBundle(options);
}

test("channel adapter bundle maps startup configuration and restores mapper state", async () => {
  const events: string[] = [];
  const captured: CapturedOptions = { feishu: [], weixin: [], qq: [], wecom: [] };
  const bundle = createBundle(events, captured);

  const startup = await bundle.createStartupAdapters(enabledAdapterConfig());

  assert.equal(startup.feishu?.channelKey, "feishu");
  assert.equal(startup.weixin?.channelKey, "weixin");
  assert.equal(startup.qq?.channelKey, "qq");
  assert.deepEqual(startup.channels.map((channel) => channel.channelKey), ["telegram", "wecom"]);
  assert.deepEqual(events, [
    "load:feishu", "load:weixin", "load:qq", "load:wecom", "load:configured",
  ]);
  assert.equal(captured.feishu[0]?.appId, "feishu-app");
  assert.equal(captured.qq[0]?.clientSecret, "qq-secret");
  assert.equal(captured.wecom[0]?.botKey, "wecom-token");
  assert.deepEqual(captured.weixin[0]?.mapper?.snapshot(), {
    activeByChatId: {},
    projectByChatId: {},
  });

  captured.weixin[0]?.onStateChange?.({ activeByChatId: { conversation: "session" } });
  assert.equal(events.at(-1), "save:weixin");
});

test("channel adapter bundle hot-reloads in a stable order, supports Weixin re-login, and flushes state", async () => {
  const events: string[] = [];
  const captured: CapturedOptions = { feishu: [], weixin: [], qq: [], wecom: [] };
  const bundle = createBundle(events, captured);
  const started: string[] = [];
  const reconcileInputs: Array<{
    channels: readonly ChannelAdapter[];
    managedChannelKeys: readonly ChannelAdapter["channelKey"][];
  }> = [];
  const server = {
    async hotStartChannel(channel: ChannelAdapter): Promise<void> {
      started.push(channel.channelKey);
    },
    async reconcileChannels(input: {
      channels: readonly ChannelAdapter[];
      managedChannelKeys: readonly ChannelAdapter["channelKey"][];
    }) {
      reconcileInputs.push(input);
      started.push(...input.channels.map((channel) => channel.channelKey));
      return {
        started: input.channels.map((channel) => channel.channelKey),
        stopped: [],
      };
    },
  };

  const result = await bundle.reload(server, enabledAdapterConfig());
  assert.deepEqual(started, ["feishu", "weixin", "qq", "wecom", "telegram"]);
  assert.deepEqual(result, [
    "feishu=started", "weixin=started", "qq=started", "wecom=started", "telegram=started",
  ]);
  assert.deepEqual([...reconcileInputs[0]!.managedChannelKeys].sort(), [
    "feishu", "qq", "telegram", "wecom", "weixin",
  ]);

  await bundle.reload(server, { adapters: { telegram: { enabled: false } } });
  assert.equal(reconcileInputs[1]!.channels.length, 0);
  assert.ok(reconcileInputs[1]!.managedChannelKeys.includes("telegram"));

  await bundle.hotStartWeixin(server);
  await bundle.flush();
  assert.deepEqual(started, ["feishu", "weixin", "qq", "wecom", "telegram", "weixin"]);
  assert.equal(events.at(-1), "flush");
  assert.equal(captured.weixin.length, 2);
});
