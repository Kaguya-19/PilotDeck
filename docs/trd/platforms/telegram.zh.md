# Telegram 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/telegram/TelegramChannel.ts`、`TelegramSessionMapper.ts`、`telegram-render.ts`。使用 Bot API long polling 或 webhook；`start/stop` 负责 polling、webhook 和 timer。

## 契约

session key 由 bot、chat、thread 和 user 组成；文本、图片、文档和 reply-to 消息映射为单一 turn。update_id 去重，429 按 Retry-After 恢复，busy 不重复提交。

## 恢复与证据

poll 失败按退避重试，主动 stop 清理 offset 和 timer。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`、`tests/network/fetch.spec.ts`；真实 Bot API：`DEFER_EXTERNAL`。
