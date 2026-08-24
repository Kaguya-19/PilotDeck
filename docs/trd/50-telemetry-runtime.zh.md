# Telemetry Runtime TRD

状态：评审中　维护者：Telemetry 团队　目标读者：运行时、隐私和运维维护者

## 代码边界

覆盖 `src/telemetry/collector.ts`、`src/telemetry/sender.ts`、`src/telemetry/context.ts` 和 `src/telemetry/types.ts`，以及 `docs/telemetry/receiver-contract.md` 的 receiver 约束。

## 核心契约

- telemetry 默认关闭；开启后事件必须符合 schema version、event identity、module/loopStage 和 outcome 约束。
- session、路径、provider URL、token、prompt 和用户内容必须脱敏或哈希；队列文件只能位于隔离的 `PILOT_HOME`。
- sender 按 batch/interval 发送，失败写入有上限的持久化队列并按 retry budget 恢复；flush/shutdown 必须幂等。
- telemetry 失败不得阻塞 Agent turn、Gateway response 或主进程退出。

## 流程与恢复

`track -> sanitize -> enqueue -> batch -> send -> ack|persist -> retry`。receiver 4xx 视为不可重试配置错误，网络/5xx 按退避重试；队列损坏应隔离并继续主流程。

## 测试与证据

源码映射：`src/telemetry/**`、`docs/telemetry/receiver-contract.md`。测试映射：`tests/telemetry/telemetry-runtime.spec.ts`。collector、context、sender 已使用 fake fetch、临时 queue 和脱敏断言纳入 `pnpm test:coverage`；真实 receiver 为 `DEFER_EXTERNAL`。CI 归属：Node deterministic gate，发布前 artifact smoke 复验。

## 验收与变更

验收覆盖默认关闭、schema、脱敏、batch、网络失败、重试、flush、shutdown 和 turn 隔离；队列上限、receiver 4xx 和超时分支仍待补齐。schema 或 receiver 字段变化必须同步 API/telemetry 文档和 contract test。
