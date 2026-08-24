# Retry and Provider Health TRD

状态：评审中　维护者：Router 团队

## 代码边界

覆盖 `src/router/retry/**`、`src/router/health/**`、zero-usage retry、backoff 和 provider health tracker。

## 核心契约

- retry 必须有最大次数、延迟和 abort signal。
- zero-usage retry 只能对无有效 usage 的失败尝试生效。
- health 状态不得永久污染其他 session；恢复后应允许重新尝试。
- retry progress 不得替代最终结果。

## 测试

映射 model-router regressions、network tests 和 fake timers。覆盖 backoff、abort、zero usage、health cooldown 和 timer cleanup。

## 验收

禁止真实 sleep；所有重试用 fake timers/barrier，失败时保留可诊断的 attempt summary。
