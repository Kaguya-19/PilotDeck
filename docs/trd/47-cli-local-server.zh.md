# CLI and Local Server TRD

状态：评审中　维护者：CLI/Runtime 团队　目标读者：命令行和发布维护者

## 代码边界

覆盖 `src/cli/pilotdeck.ts`、`src/cli/pilotdeckServer.ts`、`src/cli/createLocalGateway.ts`、`src/cli/shutdownCoordinator.ts`、`src/cli/proxy.ts` 和 `src/cli/ExtensionWatchManager.ts`。

## 核心契约

- CLI 命令必须将参数错误、配置错误、Gateway 错误映射为非零退出和稳定诊断。
- server 启动必须使用隔离的 `PILOT_HOME`、鉴权 token 和指定端口；shutdown 必须停止 watcher、socket、cron 和 child resource。
- proxy 只影响显式允许的网络请求；extension watch 重载失败不得杀死主服务。
- built artifact 入口必须与 source/tsx 入口行为一致，端口释放后不得残留进程或 timer。

## 流程与恢复

`parse -> configure -> start -> serve -> graceful shutdown`。端口占用、配置无效和启动依赖失败在 serve 前终止；运行中连接断开进入可控重连；收到 SIGINT/SIGTERM 执行幂等 shutdown。

## 测试与证据

源码映射：`src/cli/**`。测试映射：`tests/cli/bootstrap-config.spec.ts`、`tests/cli/check-node-runtime.spec.ts`、`tests/gateway/background-channel-start.spec.ts`。CLI 入口 smoke 和 built artifact smoke 为 `CURRENT_ONLY`，真实平台启动标记 `DEFER_EXTERNAL`。CI 归属：Node deterministic gate。

## 验收与变更

验收覆盖 help/version、配置隔离、随机端口、健康检查、优雅关闭、重复信号、watcher 失败和 built artifact 入口。
