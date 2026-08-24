# 企业微信 Callback 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/wecom-callback/WeComCallbackChannel.ts`、`WeComCallbackSessionMapper.ts`、`wecom-callback-render.ts`。使用 HTTP callback、签名校验和 XML/JSON 响应；`start/stop` 管理本地 server。

## 契约

session key 由 corp、agent、用户和会话标识生成；入站文本/媒体转换为 Gateway turn，响应必须在平台超时窗口内返回或转为异步投递。重复 msgId 幂等，签名错误不得触发 turn。

## 恢复与证据

解密、回调解析和 Gateway 错误必须返回可诊断失败。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。真实企业微信 callback、加密配置和平台回调：`DEFER_EXTERNAL`。
