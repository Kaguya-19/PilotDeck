# Weixin 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/weixin/WeixinChannel.ts`、`WeixinSessionMapper.ts`、`weixin-render.ts`。连接使用 iLink poll 与 QR 登录，附件可能经过加密下载；`start/stop` 管理 poll client、登录状态和 timer。

## 契约

session key 由账号与会话标识稳定生成；入站 DM 在 busy 时 FIFO 排队并保存附件快照，permission 后延迟 activity 不得丢失。显式 `assistant_attachment` 必须作为附件发送，重复消息和迟到 QR 状态必须幂等。

## 恢复与证据

poll 错误重建 client，QR 完成后才启动 polling；加密附件解密失败只失败当前消息。当前测试：`tests/gateway/weixin-nonblocking-login.spec.ts`、`tests/gateway/weixin-settings-runtime-flow.spec.ts`、`tests/adapters/im-permission-helper.spec.ts`。真实微信账号：`DEFER_EXTERNAL`。
