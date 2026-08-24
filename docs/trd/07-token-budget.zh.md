# Token Budget TRD

状态：评审中　维护者：Context 团队

## 代码边界

覆盖 `src/context/budget/TokenBudgetManager.ts`、token accounting 和 AgentLoop 对 reserved output 的使用。

## 核心契约

- context budget 必须区分总窗口、输入预算和 output reserve。
- warning/blocking 状态由统一 evaluator 产生。
- routed model 的 context window 变化后必须重新评估。
- token 估算失败不得静默放宽硬上限。

## 测试

映射 `tests/context/token-budget-manager.spec.ts`、`tests/agent/loop/context-cap.spec.ts`。补充边界值、空消息、图片 token 和 output reserve 的表驱动测试。

## 验收

报告每种状态的输入、输出、阈值和诊断；核心纯函数目标 lines/functions/branches 100%。
