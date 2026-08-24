# Agent Event Contract TRD

状态：评审中　维护者：Agent Runtime 团队

## 代码边界

覆盖 `src/agent/protocol/events.ts` 及 AgentLoop、TurnRunner、Tool Runtime 发出的事件，不重新定义 Gateway wire frame。

## 事件契约

- `turn_started`、`input_accepted`、`model_request_started`、`model_event`、`tool_calls_detected`、tool start/finish、status、failure 和 completion 必须保持 turn identity。
- tool call 必须对应唯一 tool result。
- `turn_completed`、`turn_failed`、`aborted` 终态不可重复。
- 动态 ID、时间、路径和 token 在契约断言中规范化。

## 测试

映射 `tests/agent/**`、`tests/gateway/**`、`tests/tool/**` 和 UI bridge tests。`tests/agent/turn-runner-contract.spec.ts` 已覆盖 duplicate `turn_completed` 的单一对外终态，`tests/gateway/map-agent-event-runid.spec.ts` 已覆盖 tool call/result identity 配对；`pnpm test:p1-proof --case duplicate-terminal` 和 `--case tool-result-identity` 已产生 `MUTATION_FAIL`，keyless event fixture 仍为后续工作。

## 验收

建立稳定事件序列、终态配对和 run/turn/session identity 的 contract fixture；快照不得失败自动写回。
