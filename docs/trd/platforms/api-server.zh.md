# API Server 平台附录

状态：评审中　维护者：Web/Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/api-server/ApiServerChannel.ts`、`ApiServerSessionMapper.ts`、`api-server-render.ts`。使用本地 HTTP/WebSocket API 与配置鉴权；`start/stop` 管理 server、socket 和 pending request。

## 契约

session key 由 API client 提供并经过规范化；请求映射为 Gateway turn，响应包含 run/request identity 和终态。busy、duplicate、permission/elicitation 与附件均使用公共 42 号契约。

## 恢复与证据

客户端断开中止在途 turn，服务关闭释放端口；当前入口为 `CURRENT_ONLY`，路由测试映射 `ui/server/routes/gateway.test.js`、协议 helper 映射 `tests/adapters/im-permission-helper.spec.ts`。外部客户端矩阵：`DEFER_EXTERNAL`。
