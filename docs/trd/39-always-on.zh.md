# Always-On Runtime TRD

状态：评审中　维护者：Always-On 团队

## 代码边界

覆盖 `src/always-on/runtime/**`、contracts、storage、workspace、web service 和 discovery fire。

## 核心契约

- discovery、plan、report、apply 阶段有明确状态和终态。
- lease、run context、workspace 和 project 必须隔离。
- bypass 模式仍受 safety deny；危险 Git 操作不得被绕过。
- apply、失败、取消和重启后状态可恢复，不能重复执行。

## 测试

映射 `tests/always-on/contracts-runtime.spec.ts`、`tests/gateway/background-channel-start.spec.ts`、`tests/gateway/execution-lifecycle.spec.ts`、`tests/always-on/discovery-fire.spec.ts`、`tests/always-on/discovery-scheduler.spec.ts`、`tests/always-on/signal-watcher.spec.ts`、`tests/always-on/runtime-workspace.spec.ts`、`tests/always-on/runtime-lifecycle.spec.ts`、`tests/always-on/run-history-service.spec.ts`、`tests/always-on/storage-boundaries.spec.ts`。storage、run history 和 signal watcher 测试覆盖 event/plan/report/state/work-cycle 的临时目录读写、损坏文件、日预算重置、状态迁移、legacy workspace migration、JSONL 合并过滤、transcript 恢复、文件变化去抖、忽略路径、watcher 错误和 stop 清理；证据仍为 `CURRENT_ONLY`。`AlwaysOnManager`、`AlwaysOnRuntime`、`DiscoveryScheduler`、`DiscoveryFire` 的函数覆盖约为 77.78%、77.27%、78.95%、69.44%，剩余缺口集中在 dormancy signal 与调度 timer 的集成、少数 workspace/provider 失败回调和深层 apply/terminal sync；这些分支仍需公开入口测试或 mutation proof，不能按当前通过升级为历史回归证据。

## 验收

长任务可观察、可停止、可恢复；Always-On 产生的 AgentLoop 不污染普通 user session。
