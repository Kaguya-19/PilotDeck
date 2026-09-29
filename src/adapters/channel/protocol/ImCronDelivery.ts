import type { CronResultDelivery } from "../../../cron/index.js";
import type { GatewayChannelKey } from "../../../gateway/index.js";

export function parseChatIdFromSessionKey(
  sessionKey: string | undefined,
  channelKey: GatewayChannelKey,
): string | undefined {
  const prefix = `${channelKey}:chat=`;
  if (!sessionKey?.startsWith(prefix)) return undefined;

  const suffix = sessionKey.slice(prefix.length);
  const match = suffix.match(/^(.+):(general|s_[0-9a-fA-F-]{36})$/);
  const chatId = match?.[1];
  return chatId ? chatId : undefined;
}

export async function deliverChatCronResult(
  delivery: CronResultDelivery,
  channelKey: GatewayChannelKey,
  sendText: (chatId: string, text: string) => Promise<unknown> | unknown,
): Promise<boolean> {
  if (delivery.originChannelKey && delivery.originChannelKey !== channelKey) return false;

  const chatId = parseChatIdFromSessionKey(delivery.originSessionKey ?? delivery.sessionKey, channelKey);
  if (!chatId) return false;

  return (await sendText(chatId, delivery.text)) !== false;
}
