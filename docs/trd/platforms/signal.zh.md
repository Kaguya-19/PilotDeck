# Signal 平台附录

状态：评审中　维护者：Channel 团队

## 代码边界与连接

源码入口：`src/adapters/channel/signal/SignalChannel.ts`、`SignalSessionMapper.ts`、`signal-render.ts`。使用受控 SSE/receive stream；`start` 建立 receive loop，`stop` 关闭 stream、pending request 和重连 timer。

## 契约

session key 由 account、conversation 和 peer 稳定生成；DM、附件、permission/elicitation 回复进入 Gateway turn。receive loop 必须能在回答交互请求时继续接收事件，Cron 投递不可阻塞其他 session。

## 恢复与证据

SSE 断线按退避重连，主动 stop 不得重连；逐行解析失败只记录当前事件。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`、`tests/adapters/channel/feishu-render.test.ts`。Signal 账号链路：`DEFER_EXTERNAL`。
