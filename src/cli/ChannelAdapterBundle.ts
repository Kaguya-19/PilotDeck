import { resolve } from "node:path";

import {
  ChannelStatePersistence,
  FeishuChannel,
  FeishuSessionMapper,
  QQChannel,
  QQSessionMapper,
  WeComChannel,
  WeComSessionMapper,
  WeixinChannel,
  WeixinSessionMapper,
  loadEnabledChannels,
  type ChannelAdapter,
  type FeishuChannelOptions,
  type FeishuSessionMapperState,
  type QQChannelOptions,
  type QQSessionMapperState,
  type WeComChannelOptions,
  type WeComSessionMapperState,
  type WeixinChannelOptions,
  type WeixinSessionMapperState,
} from "../adapters/index.js";
import type { PilotConfig } from "../pilot/index.js";
import type { ChannelLifecyclePort } from "./ChannelLifecyclePort.js";

type ChannelStateStore = Pick<ChannelStatePersistence, "load" | "save" | "flush">;

export type ChannelAdapterBundleOptions = {
  pilotHome: string;
  statePersistence?: ChannelStateStore;
  loadEnabledChannels?: (adapters: PilotConfig["adapters"] | undefined) => Promise<ChannelAdapter[]>;
  createFeishu?: (options: FeishuChannelOptions) => FeishuChannel;
  createWeixin?: (options: WeixinChannelOptions) => WeixinChannel;
  createQQ?: (options: QQChannelOptions) => QQChannel;
  createWeCom?: (options: WeComChannelOptions) => WeComChannel;
};

export type ChannelStartupAdapters = {
  feishu?: FeishuChannel;
  weixin?: WeixinChannel;
  qq?: QQChannel;
  /** Generic configured channels plus WeCom, which has no HTTP webhook route. */
  channels: ChannelAdapter[];
};

/**
 * Native adapter-composition provider for the CLI server.
 *
 * It owns configuration-to-adapter mapping and durable mapper-state wiring.
 * The server remains owner of started channel handles, while Gateway remains
 * owner of all session and turn state.
 */
export class ChannelAdapterBundle {
  private readonly state: ChannelStateStore;
  private readonly managedChannelKeys = new Set<ChannelAdapter["channelKey"]>([
    "feishu",
    "weixin",
    "qq",
    "wecom",
  ]);
  private readonly loadConfiguredChannels: NonNullable<ChannelAdapterBundleOptions["loadEnabledChannels"]>;
  private readonly makeFeishu: NonNullable<ChannelAdapterBundleOptions["createFeishu"]>;
  private readonly makeWeixin: NonNullable<ChannelAdapterBundleOptions["createWeixin"]>;
  private readonly makeQQ: NonNullable<ChannelAdapterBundleOptions["createQQ"]>;
  private readonly makeWeCom: NonNullable<ChannelAdapterBundleOptions["createWeCom"]>;

  constructor(options: ChannelAdapterBundleOptions) {
    this.state = options.statePersistence ?? new ChannelStatePersistence({
      stateDir: resolve(options.pilotHome, "channels"),
    });
    this.loadConfiguredChannels = options.loadEnabledChannels ?? loadEnabledChannels;
    this.makeFeishu = options.createFeishu ?? ((input) => new FeishuChannel(input));
    this.makeWeixin = options.createWeixin ?? ((input) => new WeixinChannel(input));
    this.makeQQ = options.createQQ ?? ((input) => new QQChannel(input));
    this.makeWeCom = options.createWeCom ?? ((input) => new WeComChannel(input));
  }

  async createStartupAdapters(config: Pick<PilotConfig, "adapters">): Promise<ChannelStartupAdapters> {
    const feishu = await this.createFeishu(config);
    const weixin = await this.createWeixin(config);
    const qq = await this.createQQ(config);
    const wecom = await this.createWeCom(config);
    const configured = await this.loadConfiguredChannels(config.adapters);
    for (const channel of configured) {
      this.managedChannelKeys.add(channel.channelKey);
    }
    return {
      ...(feishu ? { feishu } : {}),
      ...(weixin ? { weixin } : {}),
      ...(qq ? { qq } : {}),
      channels: [...configured, ...(wecom ? [wecom] : [])],
    };
  }

  async reload(server: ChannelLifecyclePort, config: Pick<PilotConfig, "adapters">): Promise<string[]> {
    const startup = await this.createStartupAdapters(config);
    const wecom = startup.channels.filter((channel) => channel.channelKey === "wecom");
    const configured = startup.channels.filter((channel) => channel.channelKey !== "wecom");
    const result = await server.reconcileChannels({
      channels: [
        ...(startup.feishu ? [startup.feishu] : []),
        ...(startup.weixin ? [startup.weixin] : []),
        ...(startup.qq ? [startup.qq] : []),
        ...wecom,
        ...configured,
      ],
      managedChannelKeys: [...this.managedChannelKeys],
    });
    return [
      ...result.started.map((channelKey) => `${channelKey}=started`),
      ...result.stopped.map((channelKey) => `${channelKey}=stopped`),
    ];
  }

  async hotStartWeixin(server: ChannelLifecyclePort): Promise<void> {
    const saved = await this.state.load<WeixinSessionMapperState>("weixin");
    await server.hotStartChannel(this.makeWeixin({
      mapper: saved ? new WeixinSessionMapper(saved) : undefined,
      onStateChange: (state) => this.state.save("weixin", state),
    }));
  }

  flush(): Promise<void> {
    return this.state.flush();
  }

  private async createFeishu(config: Pick<PilotConfig, "adapters">): Promise<FeishuChannel | undefined> {
    const settings = config.adapters?.feishu;
    if (settings?.enabled !== true) return undefined;
    const saved = await this.state.load<FeishuSessionMapperState>("feishu");
    return this.makeFeishu({
      appId: settings.appId,
      appSecret: settings.appSecret,
      encryptKey: settings.encryptKey,
      verifyToken: settings.verifyToken,
      connectionMode: settings.connectionMode,
      domainName: settings.domainName,
      permissionMode: settings.permissionMode,
      mapper: saved ? new FeishuSessionMapper(saved) : undefined,
      onStateChange: (state) => this.state.save("feishu", state),
    });
  }

  private async createWeixin(config: Pick<PilotConfig, "adapters">): Promise<WeixinChannel | undefined> {
    if (config.adapters?.weixin?.enabled !== true) return undefined;
    const saved = await this.state.load<WeixinSessionMapperState>("weixin");
    return this.makeWeixin({
      mapper: saved ? new WeixinSessionMapper(saved) : undefined,
      onStateChange: (state) => this.state.save("weixin", state),
    });
  }

  private async createQQ(config: Pick<PilotConfig, "adapters">): Promise<QQChannel | undefined> {
    const settings = config.adapters?.qq;
    if (settings?.enabled !== true) return undefined;
    const saved = await this.state.load<QQSessionMapperState>("qq");
    return this.makeQQ({
      appId: settings.appId,
      clientSecret: settings.clientSecret,
      allowGroups: settings.allowGroups,
      triggerPrefixes: settings.triggerPrefixes,
      maxMessageLength: settings.maxMessageLength,
      mapper: saved ? new QQSessionMapper(saved) : undefined,
      onStateChange: (state) => this.state.save("qq", state),
    });
  }

  private async createWeCom(config: Pick<PilotConfig, "adapters">): Promise<WeComChannel | undefined> {
    const settings = config.adapters?.wecom;
    if (settings?.enabled !== true) return undefined;
    const saved = await this.state.load<WeComSessionMapperState>("wecom");
    return this.makeWeCom({
      botKey: settings.token,
      extra: settings.extra,
      mapper: saved ? new WeComSessionMapper(saved) : undefined,
      onStateChange: (state) => this.state.save("wecom", state),
    });
  }
}
