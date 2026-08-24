# Core Agent Loop TRD

状态：评审中　维护者：Agent Runtime 团队

## 代码边界

核心实现是 `src/agent/loop/AgentLoop.ts` 的 `run()`。它接收 canonical messages，调用 Context、Router、Model 和 Tool Runtime，生成 AgentEvent 与最终结果。

## 一轮循环

1. 检查 abort。
2. 计算 context budget 并按需 compaction。
3. 创建 request，调用 Router decide/execute。
4. 组装 assistant message 和 tool calls。
5. 无工具调用则进入完成/恢复分支；有工具调用则执行并配对结果。
6. 将结果写入下一轮 messages，直到唯一终态。

## 恢复契约

`prompt_too_long`、empty output、max output、partial tool call、image strip、重复 tool failure 和大文件结果都必须有界、有事件或 status，并在达到上限后结构化失败。

## 测试和证据

代码边界：`src/agent/loop/AgentLoop.ts`、`src/agent/turn/TurnRunner.ts`、`src/agent/protocol/events.ts`。

映射 `tests/agent/loop/**`、`tests/model/**`、`tests/agent/loop/core-lifecycle.spec.ts`、`tests/agent/session-lifecycle.spec.ts`、`tests/agent/turn-runner-contract.spec.ts` 和 `tests/gateway/map-agent-event-runid.spec.ts`。新增测试锁定正常文本、tool loop、pre-abort 和重复 completion 的单一终态；`pnpm test:p1-proof --case duplicate-terminal` 已产生 `MUTATION_FAIL`，其余恢复分支仍需 mutation 或 parent failure。

## 验收

正常文本、tool loop、model error、tool error、abort、timeout、恢复上限和唯一 `turn_completed` 均有确定性测试。
