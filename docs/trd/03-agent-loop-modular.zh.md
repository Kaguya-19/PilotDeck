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

## Sidecar Factory Mapping

`src/cli/pilotdeck-agent-loop-default-factory.ts` 是一个 transport-independent 的默认 payload mapper，不属于任何宿主业务层。它从 execute payload 的 `agent`、`task`、`messages`、`tools`、`permissionContext`、`seedState` 和 `executionContext` 构造 `AgentRuntimeConfig`、`AgentLoopInput` 与可恢复的文件状态；宿主仍可通过 `PILOTDECK_AGENT_LOOP_FACTORY` 提供自己的 mapper。宿主专属字段必须在宿主 adapter 中转换，不能让默认 factory 依赖具体业务类型或注入专属系统提示、权限提升或最终结果语义。

图片 data URL 只在本次 execute 的 `messages` 映射中转换为 canonical image block，不写入 sidecar 自己的持久化状态。`seedState` 只接受现有 `AgentLoopSeedState` 的可验证 JSON 投影；未知 checkpoint 保持宿主 opaque 数据。session、turn、run、operation 和最终 outcome 继续由宿主 envelope 提供并聚合；默认 factory 不创建第二套宿主状态。

## 验收

- 注入 Model/Tool Port 后正常文本、tool loop、abort、model error 和 tool error 行为与旧实现一致。
- legacy adapter 保持现有 Router 路由、Context budget、ToolScheduler 并发和消息持久化行为。
- v2 契约测试覆盖 slim profile、唯一终态、cancel、sequence 去重、gap、resume 和 cursor 过期。

## 关联契约

- [`docs/pilotdeck-module-communication-sop.zh.md`](../pilotdeck-module-communication-sop.zh.md)
- [`docs/pilotdeck-module-protocol-v2.schema.json`](../pilotdeck-module-protocol-v2.schema.json)
