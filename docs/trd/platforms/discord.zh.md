# Discord 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/discord/DiscordChannel.ts`、`DiscordSessionMapper.ts`、`discord-render.ts`。使用 bot gateway/WebSocket 与 token 鉴权；`start/stop` 管理 gateway、heartbeat 和 reconnect。

## 契约

session key 由 guild、channel、thread 和 user 组成；消息、文件和回复 thread 映射为 Gateway turn。Discord rate limit、duplicate event 和 busy session 必须隔离处理。

## 恢复与证据

sequence/heartbeat 失步触发重连，主动 stop 不重连。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`、`tests/adapters/im-renderers.spec.ts`；bot token 链路：`DEFER_EXTERNAL`。
