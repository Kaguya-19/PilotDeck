# TUI 平台附录

状态：评审中　维护者：CLI/UI 团队

## 代码边界与连接

源码入口：`src/adapters/channel/tui/TuiChannel.ts`、`tui-render.ts`、`app/`。使用 Ink/终端输入输出与本地 Gateway；`start/stop` 管理渲染树、raw mode 和 signal。

## 契约

session key 由 workspace 和用户选中的 session 组成；输入、流式事件、tool progress、permission 和附件状态映射到终端视图。终端重绘不得改变 Gateway event identity。

## 恢复与证据

终端 resize、raw mode 失败、Gateway 断开和 SIGINT 必须清理渲染资源并恢复终端。当前共享测试：`tests/adapters/im-permission-helper.spec.ts`、`tests/gateway/websocket-contract.spec.ts`；交互终端 smoke：`DEFER_EXTERNAL`。
