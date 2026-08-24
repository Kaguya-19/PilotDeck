# Compaction Engine TRD

状态：评审中　维护者：Context 团队

## 代码边界

覆盖 `src/context/compaction/CompactionEngine.ts` 的 full compaction、rolling summary、protected turns、summary boundary 和 post-compact messages。

## 核心契约

- summary 必须保留继续任务所需的目标、状态、剩余工作、文件和错误恢复信息。
- tool call/result pair 不得被压缩成悬空半对。
- protected tool/turn 必须按配置保留；retained tail 超预算时只能结构化裁剪结果。
- summary、boundary、attachments、hook results 和 tail 顺序必须稳定。

## 测试

映射 `tests/context/compaction-engine.spec.ts`、`tests/context/autoCompaction.spec.ts`、`tests/context/compaction-boundaries.spec.ts`。边界测试固定 normal/warning/blocking 三档策略、reserved output 预算和失败保留原消息；summary malformed、超大 tool result、checkpoint merge 仍需 mutation proof。

## 验收

compaction 后 prompt 可发送、旧 checkpoint 可合并、失败保留原消息，事件包含稳定 compactionId。
