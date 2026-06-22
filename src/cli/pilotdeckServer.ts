import type { ChannelAdapter, ChannelHandle } from "../adapters/index.js";
import { FeishuChannel } from "../adapters/index.js";
import { WeixinChannel } from "../adapters/index.js";
import { QQChannel } from "../adapters/index.js";
import type { Gateway } from "../gateway/index.js";
import { startGatewayServer, type GatewayServer } from "../gateway/index.js";
import type { PilotConfig } from "../pilot/index.js";

export type StartPilotDeckServerOptions = {
  gateway: Gateway;
  port?: number;
  host?: string;
  staticAssetsPath?: string;
  feishu?: FeishuChannel;
  weixin?: WeixinChannel;
  qq?: QQChannel;
  /**
   * Extra channels (e.g. telegram, discord, slack) loaded via
   * `loadEnabledChannels(config.adapters)`.
   */
  channels?: ChannelAdapter[];
  /**
   * Loaded pilotdeck.yaml config — passed into channel.start() so adapters can
   * read their own section (e.g. `adapters.feishu.appId/appSecret`).
   */
  config?: PilotConfig;
};

export type PilotDeckServer = GatewayServer & {
  /**
   * Hot-start a channel adapter after server startup.
   * Stops any previously running instance of the same channelKey first.
   */
  hotStartChannel(channel: ChannelAdapter): Promise<void>;
};

export async function startPilotDeckServer(options: StartPilotDeckServerOptions): Promise<PilotDeckServer> {
  const consoleLogger = {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
  const baseDeps = { gateway: options.gateway, config: options.config, logger: consoleLogger };

  const runningChannels = new Map<string, ChannelHandle>();

  async function startAndTrack(ch: ChannelAdapter): Promise<void> {
    const existing = runningChannels.get(ch.channelKey);
    if (existing) {
      await existing.stop("hot-reload").catch(() => {});
      runningChannels.delete(ch.channelKey);
    }
    const handle = await ch.start(baseDeps);
    runningChannels.set(ch.channelKey, handle);
  }

  if (options.feishu) await startAndTrack(options.feishu);
  if (options.weixin) await startAndTrack(options.weixin);
  if (options.qq) await startAndTrack(options.qq);

  if (options.channels?.length) {
    await Promise.all(
      options.channels.map((ch) =>
        startAndTrack(ch).catch((e) => {
          console.error(`[adapters] channel ${ch.channelKey} start failed: ${e}`);
        }),
      ),
    );
  }

  const gwServer = await startGatewayServer({
    gateway: options.gateway,
    port: options.port,
    host: options.host,
    staticAssetsPath: options.staticAssetsPath,
    feishuWebhook: options.feishu
      ? (request, response, body) => options.feishu!.handleWebhook(request, response, body)
      : undefined,
  });

  return Object.assign(gwServer, {
    async hotStartChannel(channel: ChannelAdapter) {
      await startAndTrack(channel);
    },
  });
}
