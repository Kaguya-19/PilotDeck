# TurnRunner TRD

状态：评审中　维护者：Agent Runtime 团队

## 代码边界

`src/agent/turn/TurnRunner.ts` 是输入、transcript、lifecycle、title、artifact 和 AgentLoop 之间的 turn 包装层。

## 核心流程

`input accept -> record input -> UserPromptSubmit -> title -> AgentLoop -> artifact finish -> metadata finalize -> turn result`。

## 核心契约

- accepted input 必须先记录，再调用模型。
- lifecycle hook 可阻断明确阶段，但 hook 异常不得无意中破坏主 turn。
- title 和 artifact 是辅助流程，失败、超时或解析失败不得使主 turn 失败。
- artifact 必须绑定 session/turn，失败时保留可恢复状态。

## 测试

映射 `tests/agent/turn-runner-boundaries.spec.ts`、`tests/agent/turn-runner-contract.spec.ts`、`tests/session/turn-file-artifacts.spec.ts`、`tests/session/turn-metadata-tail.spec.ts`、`tests/session/session-title-generator.spec.ts` 和 `tests/session/turn-runner-title-race.spec.ts`。title 请求契约、输入规范化、4096 output tokens、解析失败、provider 异常、并发生成复用和人工标题优先级，以及 artifact collector 启动失败、accepted-input transcript 失败隔离、tool-result 消费和重复终态已覆盖；当前 `TurnRunner` 行覆盖 98.10%、分支覆盖 86.96%、函数覆盖 72.34%，私有 abort-link、深层异常收尾和部分 callback 仍缺完整入口或 mutation 证据。`pnpm test:p1-proof --case manual-title-priority` 已产生 `MUTATION_FAIL`。

## 验收

验证输入记录、hook block、模型失败、artifact 失败、title 失败和正常完成的事件顺序。
