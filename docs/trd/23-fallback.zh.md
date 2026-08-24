# Fallback Policy TRD

状态：评审中　维护者：Router 团队

## 代码边界

覆盖 `src/router/fallback/runFallbackChain.ts`、fallback route 选择和失败 attempt 汇总。

## 核心契约

- fallback 只对允许的 retryable/model errors 生效。
- 失败 attempt 不得作为最终成功结果或用户可见 assistant message。
- fallback 必须保留原始输入、request identity 和最终错误原因。
- abort、permission deny 和安全错误不得被 fallback 掩盖。

## 测试

映射 `tests/router/tokenSaver.spec.ts` 和 router fallback tests。补充 fallback exhausted、abort 和 hidden attempt mutation proof。

## 验收

覆盖首选 provider 成功、首选失败后成功、全部失败、不可重试错误和取消。
