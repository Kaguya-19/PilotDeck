# 企业微信 AI Bot 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/wecom/WeComChannel.ts`、`WeComSessionMapper.ts`、`wecom-render.ts`。使用 AI Bot WebSocket，握手后启动 heartbeat；公开 `start/stop` 管理 socket 和 timer。

## 契约

session key 由 bot、群/用户和会话标识生成；入站 DM callback 启动单一 Gateway turn，出站文本和附件保持 request 配对。permission/elicitation 回答不得阻塞 receive loop；busy 时拒绝或排队必须稳定。

## 恢复与证据

非主动 close 受控重连，主动 stop 不重连；close 必须 abort 在途 turn 并清理 heartbeat。当前仅有公共 adapter/helper 映射：`tests/adapters/im-permission-helper.spec.ts`。WeCom WebSocket 与真实企业账号：`DEFER_EXTERNAL`。
