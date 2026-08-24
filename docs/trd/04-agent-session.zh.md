# AgentSession TRD

状态：评审中　维护者：Agent Runtime 团队

## 代码边界

`src/agent/session/AgentSession.ts` 维护单 session 的状态、messages、usage、permission denials、current turn 和 abort controller。

## 核心契约

- submit 时分配唯一 turn ID 并进入 running。
- AgentLoop 结束后合并 messages、usage 和 denials，再发布 session end。
- abort 只改变当前 session 的执行状态，不删除历史消息。
- runtime reload 必须保留 state、file state、metadata 和 transcript writer state。

## 失败和恢复

输入记录失败、AgentLoop error、abort 和 lifecycle failure 都必须产生明确 session 终态；reload 失败不得用空状态覆盖有效 session。

## 测试

代码边界：`src/agent/session/AgentSession.ts`、`src/agent/session/AgentSessionState.ts`。

映射 `tests/agent/session-lifecycle.spec.ts`、`tests/session/**` 和 `tests/gateway/execution-lifecycle.spec.ts`。新增测试验证生命周期事件配对、turn ID、usage 累计、abort reason、runner unwind，以及 runtime reload 对 state、cwd、transcript、metadata 和 file state 的保留。仍需补连续 turn、abort race、重复 submit 和 mutation proof。

## 验收

验证正常 submit、连续 turns、abort、reload、replay 和 usage 累计，且 Gateway 仍是 active-run 事实来源。
