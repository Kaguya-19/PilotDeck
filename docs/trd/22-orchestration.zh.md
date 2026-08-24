# Orchestration Policy TRD

状态：评审中　维护者：Router/Agent 团队

## 代码边界

覆盖 `src/router/orchestrate/**`、subagent detection、prompt injection、tool allowlist 和 plan/ask mode 过滤。

## 核心契约

- orchestration prompt 只注入当前 request，subagent 不重复编排。
- allowlist 为空表示没有允许工具，不能回退为全部工具。
- plan/ask 模式只能暴露允许的只读或交互工具。
- subagent depth、definition 和父子 turn identity 必须受限。

## 测试

映射 `tests/router/scenario-and-policy.spec.ts`、`tests/tool/builtin/agent-subagent-type.spec.ts` 和 subagent tests。当前测试固定主 agent/subagent 判定、tag 清理、trigger tier、非主 agent拒绝和继续编排语义，证据为 `CURRENT_ONLY`；allowlist、重复编排和工具过滤仍需 mutation proof。

## 验收

覆盖主 agent、subagent、plan、ask、空 allowlist、无匹配 allowlist 和降级场景。
