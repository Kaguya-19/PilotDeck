# Anthropic Messages Adapter TRD

状态：评审中　维护者：Model Protocol 团队

## 代码边界

覆盖 `src/model/providers/anthropic/**` 的 Messages request、content block、cache 和 stream。

## 核心契约

- system、user、assistant、tool_use、tool_result 和 cache breakpoint 顺序稳定。
- cache breakpoint 数量和位置必须符合 provider 限制。
- 默认使用 Anthropic Prompt Cache 的 `1h` TTL；system prompt 和消息断点必须使用相同 TTL。
- transient error 只在可重试条件下重试，并保持原 request identity。
- provider abort 不得被归类为普通 model failure。

## 测试

映射 `tests/model/request/anthropicCache.spec.ts`、Anthropic stream tests 和 regression proof。真实 Anthropic 只在 external nightly。

## 验收

覆盖 cache cap、tool round-trip、transient retry、错误、取消和 malformed payload。
