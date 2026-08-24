# Tool Scheduler TRD

状态：评审中　维护者：Tool Runtime 团队

## 代码边界

覆盖 `src/tool/scheduler/**`、`ConcurrentToolScheduler`、`SequentialToolScheduler` 和 event pump。

## 核心契约

- 独立 tool call 可以并发，但结果必须按 call identity 确定性配对。
- scheduler 失败时所有未完成调用都必须有失败结果。
- abort/timeout 必须停止可停止执行并释放 waiter。
- progress/status 事件不能替代最终 tool result。

## 测试

映射 `tests/tool/registry-scheduler.spec.ts`、`tests/tool/**` 和 AgentLoop tool event tests。当前覆盖 sequential/concurrent 分组、未知工具降级、原始 call 顺序恢复和空/单调用；scheduler throw、abort、timeout 和未完成调用失败结果仍需补充。

## 验收

无真实 sleep、shell、网络；所有调用都产生 success/failure/timeout/cancellation 之一。
