# Feishu 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/feishu/FeishuChannel.ts`、`FeishuSessionMapper.ts`、`feishu-render.ts`。使用飞书 webhook/事件回调鉴权；`start` 注册接收入口，`stop` 清理 listener 和 pending delivery。

## 契约

session key 由 tenant、chat 和 thread 稳定生成；入站文本、图片和文件映射为一个 Gateway turn。出站消息使用 Feishu render，permission/elicitation 通过回调回答。重复 event ID 必须去重，Gateway busy 不得重复启动。

## 恢复与证据

签名错误、过期事件和 API 限流返回明确失败；webhook 断开不主动伪造成功。当前测试：`tests/adapters/channel/feishu-render.test.ts`、`tests/adapters/feishu-permission-reply.spec.ts`。入口和真实租户链路：`DEFER_EXTERNAL`。
