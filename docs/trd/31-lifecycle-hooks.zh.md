# Lifecycle Hook TRD

状态：评审中　维护者：Extension/Agent 团队

## 代码边界

覆盖 `src/lifecycle/**`、`src/extension/hooks/**`、hook matching、dispatcher、effect 和 executor。

## 核心契约

- hook 必须按事件、条件和作用域稳定匹配。
- block effect 只能阻断明确阶段，并返回结构化原因。
- hook 超时、异常和无效输出必须隔离，不得制造悬空 turn。
- hook message 进入模型前必须标记来源和可见性。

## 测试

映射 `tests/lifecycle/lifecycle-runtime.spec.ts`、`tests/extension/hooks-execution.spec.ts` 和 TurnRunner tests。当前确定性覆盖 callback、prompt、agent、HTTP、command、async registry、block、timeout、cancel、invalid output、effect 合并和事件通知，证据为 `CURRENT_ONLY`；跨历史修复的 mutation proof 和更广泛的匹配优先级仍需补充。

## 验收

PreModel、PreCompact、Stop、SessionStart/End 等事件的执行顺序、错误隔离和结果合并明确。
