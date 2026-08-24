# File History and Artifact TRD

状态：评审中　维护者：Session/File 团队

## 代码边界

覆盖 `src/session/filesystem/**`、`src/session/artifacts/**`、FileHistoryStore、backup/restore 和 FileArtifactCollector。

## 核心契约

- 同一源状态首次快照幂等。
- 创建、编辑、restore 或 artifact 收集失败可回滚，不删除最后有效快照。
- artifact 必须绑定 session/turn、operation、status 和路径摘要。
- 快照淘汰有明确上限且不得淘汰当前有效恢复点。

## 测试

映射 `tests/session/file-artifact-collector.spec.ts`、`tests/session/turn-file-artifacts.spec.ts`、new-file tests。使用临时目录、fake clock 和 mutation proof。

## 验收

文件成功、失败、并发、回滚、快照淘汰和 artifact incomplete 均可重现。
