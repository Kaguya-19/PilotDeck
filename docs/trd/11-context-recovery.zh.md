# Context Recovery TRD

状态：评审中　维护者：Context 团队

## 代码边界

覆盖 `src/context/recovery/**`、AgentLoop 的 `prompt_too_long`、max output continuation、image strip 和 emergency compaction 分支。

## 核心契约

- 每类恢复都有明确计数器和最大次数。
- 可恢复错误只能重试等价或更安全的 request；不得修改用户历史。
- emergency compaction 仍超预算时返回结构化 `prompt_too_long`，不得无限请求模型。
- abort 优先于 recovery retry。

## 测试

映射 `tests/agent/loop/context-cap.spec.ts`、`tests/agent/loop/image-strip-recovery.spec.ts`、`tests/context/compaction-boundaries.spec.ts` 和 streaming recovery tests。媒体剥离的 top-level、tool result nested image/PDF 替换和 clean message identity 已由确定性测试固定；为每种恢复加入 reverse mutation 或 parent failure 证据。

## 验收

验证 overflow、空输出、截断 tool call、图片降级、重复错误和 abort race 的事件顺序和终态。
