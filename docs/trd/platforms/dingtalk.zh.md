# DingTalk 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/dingtalk/DingTalkChannel.ts`、`DingTalkSessionMapper.ts`、`dingtalk-render.ts`。使用机器人 webhook/Stream 连接与签名鉴权；`start/stop` 管理 stream 和 heartbeat。

## 契约

session key 由 corp、conversation 和 sender 组成；入站消息进入单一 turn，出站 markdown、附件和交互回答保持关联。重复消息必须幂等。

## 恢复与证据

断线重连和限流退避不应重复投递；真实 corp token 与平台 stream：`DEFER_EXTERNAL`。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。
