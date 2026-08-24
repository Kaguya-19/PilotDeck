# Token Saver Classification TRD

状态：评审中　维护者：Router 团队

## 代码边界

覆盖 `src/router/tokenSaver/**` 的 judge prompt、分类、tier 粘性、重新分类和 session cache。

## 核心契约

- judge 输入必须来自规范化的最后 user message，不修改原历史。
- session tier 只能在同一 session 内粘性生效，不能跨 session/project 泄漏。
- 分类失败有明确 fallback，不得阻塞主 turn。
- provider/model 和分类结果必须可审计但不得记录 secret。

## 测试

映射 `tests/router/tokenSaver.spec.ts`、`tests/router/scenario-and-policy.spec.ts`。后者固定 judge prompt 的 tier、规则和 continuation 语义，以及 session usage cache 的 LRU/隔离行为；真实准确率进入 external nightly，离线 mock judge 必须确定性运行。

## 验收

覆盖首次分类、同 session 复用、重新分类、不同 session 隔离和 judge failure。
