# Micro Compaction TRD

状态：评审中　维护者：Context 团队

## 代码边界

覆盖 `src/context/compaction/MicroCompactionEngine.ts`、snip 和局部 tool result 裁剪。

## 核心契约

- micro compaction 只修改明确允许的 tool result 或重复内容。
- 不得删除最近用户请求、未配对 tool call 或终态信息。
- 裁剪后必须保留结果类型、错误状态和引用路径。
- 达不到目标时返回诊断，不伪造已达到预算。

## 测试

映射 `tests/context/autoCompaction.spec.ts`、`tests/context/compaction-engine.spec.ts`、`tests/context/compaction-boundaries.spec.ts`。边界测试覆盖 CachedMicroCompaction 的 disabled、provider 短路、无可压缩工具、live threshold、breakpoint 去重和 cache hit 验证；仍需补短结果、重复结果、无变化输入的 mutation proof。

## 验收

局部压缩不会改变消息角色和 pairing；无有效变化时不产生虚假 checkpoint。
