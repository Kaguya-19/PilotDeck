# 通用 Webhook 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/webhook/WebhookChannel.ts`、`WebhookSessionMapper.ts`、`webhook-render.ts`。使用本地 HTTP `start/stop`、可选 HMAC 和随机端口。

## 契约

session key 由配置的 tenant、conversation 和 sender 字段映射；JSON 入站消息进入 Gateway turn，出站响应使用稳定 request ID。签名和 schema 校验必须先于业务执行，delivery ID 去重。

## 恢复与证据

未知 route、错误签名、Gateway busy 和重复请求返回明确结果；stop 后端口必须释放。当前入口测试为 `CURRENT_ONLY`，协议 helper 测试：`tests/adapters/im-permission-helper.spec.ts`；公网 webhook：`DEFER_EXTERNAL`。
