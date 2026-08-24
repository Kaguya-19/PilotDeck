# Memory Runtime TRD

状态：评审中　维护者：Context/Memory 团队

## 代码边界

覆盖 `src/context/memory/**`、`AgentContextRuntime.captureTurn` 和 memory provider 适配层。

## 核心契约

- memory capture 在 turn 结束后执行，不阻塞主 turn 终态。
- provider 错误、超时和返回格式错误必须隔离并记录诊断。
- 检索结果必须标记来源和作用域，不能伪装为用户原始消息。
- memory 注入必须遵守 context budget 和项目/session 边界。

## 测试

映射 memory provider tests、context runtime tests 和 transcript tests。补充 provider failure、重复 capture、跨 session 隔离和预算超限。

## 验收

memory 可禁用、可恢复、可观测；失败不会使 AgentLoop 返回 error；敏感内容和路径不会进入 telemetry。
