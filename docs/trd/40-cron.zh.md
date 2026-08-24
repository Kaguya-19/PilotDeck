# Cron Scheduler TRD

状态：评审中　维护者：Automation 团队

## 代码边界

覆盖 `src/cron/config/**`、`storage/**`、`runtime/**`、Cron tools 和 `CronFire`。

## 核心契约

- task store 写入串行化且多实例并发不丢任务。
- schedule、timezone、next fire 和 stop 状态可恢复。
- 删除竞态中，已删除任务不得复活、调用 Gateway、记录 run 或重新调度。
- delivery failure 必须传播到 Cron 状态，不得静默成功。

## 测试与当前证据

映射：

- `tests/cron/cron-editing.spec.ts`：任务更新、revision 冲突、时区、CronFire claim 和 Gateway 转发。
- `tests/cron/cron-runtime-boundaries.spec.ts`：配置解析、delay/once/cron 创建、历史、删除、恢复、启动/停止、active run、scheduler capacity、interaction/timeout/abort、结果投递和工具包装器。

`scripts/check-module-coverage.mjs` 已纳入 `parseCronConfig`、`CronRuntime`、`CronFire`、`CronSchedule`、`CronScheduler`、`CronTaskStore` 和四个 Cron tool wrapper；当前核心模块行覆盖均达到 90%+，证据等级为 `CURRENT_ONLY`。`CronManager`、`CronStoreMigration`、真实进程和平台投递仍属于后续 `RESTORE`/`ENTRY_SMOKE`，不得写成已覆盖。

## 验收

create/list/update/delete/stop/run-now、并发写、删除竞态和进程重启均有确定性测试。
