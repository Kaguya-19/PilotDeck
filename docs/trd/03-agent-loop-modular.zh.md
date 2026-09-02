# AgentLoop Modular Framework TRD

状态：执行中　维护者：Agent Runtime 团队

## 边界

`AgentLoop` 保留一次 Turn 的消息演进、assistant 组装、工具结果回填和唯一终态。Model 与 Tool 通过可替换 Port 接入；StaffDeck 接入时由宿主通过 sidecar `module_call` 提供 Model、Capability、Permission 和 Checkpoint 实现。Session、Gateway、Transcript 和外部 transport 仍由宿主拥有。

```text
Session -> TurnRunner -> AgentLoop
                         ├─ ModelInvokerPort
                         └─ ToolPort
                              ↑
                    legacy Router/Scheduler adapters
```

## 接口

- `ModelInvokerPort.prepare()` 负责返回已解析的 provider/model/request/limits；`stream()` 只返回 canonical model events。
- `ToolPort.list()` 提供当前工具定义；`executeAll()` 保留现有 scheduler 的批量、并发和结果顺序语义。
- `AgentRuntimeDependencies.ports` 可注入自定义 Port；未注入时自动包装现有 Router、ToolRegistry 和 ToolScheduler。
- `AgentLoopInput.execution.runId` 由宿主提供，缺省值只用于兼容直接调用方。

## Module Protocol v2

协议 envelope、能力协商、operation 状态、取消、deadline、stream 去重与 resume 由 `src/agent/modules/protocol.ts` 的进程内实现负责。`src/agent/modules/sidecar.ts` 提供双向 NDJSON server；`module_call` 用于回调宿主模块。它不改变 Gateway 对外 API，也不把 Router 内部 provider retry 暴露为公共 attempt。

## 验收

- 注入 Model/Tool Port 后正常文本、tool loop、abort、model error 和 tool error 行为与旧实现一致。
- legacy adapter 保持现有 Router 路由、Context budget、ToolScheduler 并发和消息持久化行为。
- v2 契约测试覆盖 slim profile、唯一终态、cancel、sequence 去重、gap、resume 和 cursor 过期。

## 关联契约

- [`docs/pilotdeck-module-communication-sop.zh.md`](../pilotdeck-module-communication-sop.zh.md)
- [`docs/pilotdeck-module-protocol-v2.schema.json`](../pilotdeck-module-protocol-v2.schema.json)
