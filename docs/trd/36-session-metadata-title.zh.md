# Session Metadata and Title TRD

状态：评审中　维护者：Session 团队

## 代码边界

覆盖 `src/session/metadata/**`、`src/session/title/**`、SessionMetadataStore 和 TurnRunner title flow。

## 核心契约

- metadata 更新必须按 session/turn 顺序持久化。
- title generator 使用规定的主模型和 token 上限。
- provider、解析、超时和失败不得让主 turn 失败。
- 并发手工 title 优先，AI title 不得覆盖已确认标题。

## 测试

映射 session title、turn metadata、transcript tests。补充首次失败后重试累计 user messages、并发 title 和禁用自动标题。

## 验收

title 异步生成可被等待或清理，主 turn 终态不被 title promise 阻塞，reload 后 metadata 可恢复。
