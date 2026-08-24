# Mattermost 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/mattermost/MattermostChannel.ts`、`MattermostSessionMapper.ts`、`mattermost-render.ts`。使用 websocket event 与 personal access token；`start/stop` 管理连接和 ping。

## 契约

session key 由 team、channel、thread 和 user 组成；post id 去重，线程回复、文件和交互回答保持 Gateway identity。busy session 不重复启动。

## 恢复与证据

websocket close 按退避重连，主动 stop 清理 ping timer。真实 Mattermost server：`DEFER_EXTERNAL`；当前共享测试：`tests/adapters/im-permission-helper.spec.ts`。
