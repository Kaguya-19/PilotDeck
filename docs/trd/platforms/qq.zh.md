# QQ 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/qq/QQChannel.ts`、`QQSessionMapper.ts`、`qq-render.ts`、`qqbot-gateway.ts`。使用 QQ Bot Gateway WebSocket；`start/stop` 管理鉴权、heartbeat 和 reconnect。

## 契约

session key 由 guild/group、channel 和 user 组成；DM、群消息和附件映射为 Gateway turn。sequence、duplicate 和 busy 必须按会话隔离。

## 恢复与证据

Gateway close 重连但 stop 不重连；token/intent 错误明确失败。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`；QQ Bot 账号链路：`DEFER_EXTERNAL`。
