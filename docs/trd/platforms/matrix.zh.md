# Matrix 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/matrix/MatrixChannel.ts`、`MatrixSessionMapper.ts`、`matrix-render.ts`。使用 homeserver sync/长轮询和 access token；`start/stop` 管理 sync cursor 与重连。

## 契约

session key 由 homeserver、room 和 sender 组成；event ID 去重，线程、媒体和 reply 映射为 Gateway turn。sync token 必须单调推进。

## 恢复与证据

homeserver 限流/断线按退避恢复，旧 cursor 不得重复投递；真实 homeserver 和账号：`DEFER_EXTERNAL`。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。
