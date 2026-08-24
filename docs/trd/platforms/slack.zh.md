# Slack 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/slack/SlackChannel.ts`、`SlackSessionMapper.ts`、`slack-render.ts`。使用 Events API/Socket Mode 与签名鉴权；`start/stop` 管理 socket、ack 和重连。

## 契约

session key 由 team、channel、thread 和 user 组成；event callback 必须先 ack 再异步提交 Gateway turn。event_id 去重，thread reply、文件和交互回答保持关联。

## 恢复与证据

签名或 timestamp 无效不得触发 turn；socket close 受控重连并清理旧 listener。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。Slack app 与公网事件：`DEFER_EXTERNAL`。
