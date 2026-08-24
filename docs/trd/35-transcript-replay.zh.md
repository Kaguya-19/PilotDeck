# Transcript Replay TRD

状态：评审中　维护者：Session 团队

## 代码边界

覆盖 `src/session/transcript/**`、JSONL writer/reader、TranscriptReplay、TranscriptChain 和 subagent replay。

## 核心契约

- entry sequence、entryId、sessionId 和 turnId 必须可排序和去重。
- 旧格式、截断 JSON、重复事件和未知 event 必须有明确策略。
- replay 不得生成悬空 tool call、重复终态或跨 session 消息。
- compaction boundary、artifact、metadata 和 tool result replay 顺序稳定。
- `entryId/parentEntryId` 形成环时不得递归溢出；必须回退到可确定的根和最长非环路径，并记录诊断。

## 测试

映射 `tests/session/**`、`tests/session/transcript-storage-boundaries.spec.ts`、`tests/web/compact-replay.spec.ts`、Gateway replay tests。Reader 覆盖缺失、超大、非法 JSON 和排序；Chain 覆盖 legacy fallback、最长分支、孤儿和环回退；JSONL writer 覆盖串行写入、恢复 sequence、sidechain 和 UTF-8 preview。当前覆盖证据为 `CURRENT_ONLY`，环回退由当前复现测试证明；历史 parent/mutation proof 仍需单独登记。

## 验收

replay 后 messages、usage、metadata、active/history 投影与原始有效 transcript 一致。
