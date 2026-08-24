# WhatsApp 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/whatsapp/WhatsAppChannel.ts`、`WhatsAppSessionMapper.ts`、`whatsapp-render.ts`。使用 WhatsApp Business webhook/媒体 API；`start/stop` 管理 HTTP 入口和 delivery queue。

## 契约

session key 由 phone number、chat 和 participant 组成；文本、媒体和 quoted message 映射为 turn。message id 去重，媒体下载和平台限流不得影响其他会话。

## 恢复与证据

签名失败返回拒绝，媒体失败返回可见附件错误；真实 Business 账号与公网 webhook：`DEFER_EXTERNAL`。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。
