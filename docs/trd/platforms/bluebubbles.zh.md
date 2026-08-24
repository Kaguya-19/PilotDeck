# BlueBubbles 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/bluebubbles/BlueBubblesChannel.ts`、`BlueBubblesSessionMapper.ts`、`bluebubbles-render.ts`。使用 BlueBubbles webhook/API；`start/stop` 管理 callback server 和发送队列。

## 契约

session key 由 handle、chat 和 thread 组成；iMessage 文本、reaction、图片和文件映射为 Gateway turn。message GUID 去重，回复保持 chat identity。

## 恢复与证据

Mac host 不可用或 API 失败时只失败当前 delivery；真实 Mac/BlueBubbles 服务：`DEFER_EXTERNAL`。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。
