# AgentLoop Modular Framework TRD

状态：执行中　维护者：Agent Runtime 团队

## 边界

`AgentLoop` 保留一次 Turn 的消息演进、assistant 组装、工具结果回填和唯一终态。Model 与 Tool 通过可替换 Port 接入；StaffDeck 接入时由宿主通过 sidecar `module_call` 提供 Model、Capability、Permission 和 Checkpoint 实现。Session、Gateway、Transcript 和外部 transport 仍由宿主拥有。

```text
Session -> TurnRunner -> AgentLoop
                         ├─ AgentContextRuntime
                         ├─ ModelInvokerPort
                         └─ ToolPort
                              ↑
                    legacy Router/Scheduler adapters
```

## 接口

- `ModelInvokerPort.prepare()` 负责返回已解析的 provider/model/request/limits；`stream()` 只返回 canonical model events。
- `ToolPort.list()` 提供当前工具定义；`executeAll()` 保留现有 scheduler 的批量、并发和结果顺序语义。
- sidecar 可通过宿主声明的 `context` module 调用当前 session 的 ContextRuntime；system prompt、skill catalog 和上下文策略不在 sidecar 内复制。
- `AgentRuntimeDependencies.ports` 可注入自定义 Port；未注入时自动包装现有 Router、ToolRegistry 和 ToolScheduler。
- `AgentLoopInput.execution.runId` 由宿主提供，缺省值只用于兼容直接调用方。

## Module Protocol v2

协议 envelope、能力协商、operation 状态、取消、deadline、stream 去重与 resume 由 `src/agent/modules/protocol.ts` 的进程内实现负责。`src/agent/modules/sidecar.ts` 提供双向 NDJSON server；`module_call` 用于回调宿主模块。它不改变 Gateway 对外 API，也不把 Router 内部 provider retry 暴露为公共 attempt。

## Sidecar Factory Mapping

`src/cli/pilotdeck-agent-loop-default-factory.ts` 是一个 transport-independent 的默认 payload mapper，不属于任何宿主业务层。它从 execute payload 的 `agent`、`task`、`messages`、`tools`、`permissionContext`、`seedState` 和 `executionContext` 构造 `AgentRuntimeConfig`、`AgentLoopInput` 与可恢复的文件状态；宿主仍可通过 `PILOTDECK_AGENT_LOOP_FACTORY` 提供自己的 mapper。宿主专属字段必须在宿主 adapter 中转换，不能让默认 factory 依赖具体业务类型或注入专属系统提示、权限提升或最终结果语义。

宿主可以在单次 execute 通过可选 `contextOverride` 显式接管上下文：`systemPrompt`、canonical `messages`、`metadata` 和 `tools` 分别覆盖对应的普通字段。override 的 metadata 会与 `executionContext` 合并，显式值优先；显式提供 messages（包括空数组）时不再回退到 `task.prompt`。default factory 只解析 canonical 结构，不识别宿主的 TaskFrame、Harness 或其他业务字段。

execute payload 的 `hostModules` 声明宿主可调用模块能力。声明 `context.prepare_for_model`
后，默认 factory 注入 host-backed `AgentContextRuntime`；可选代理 `apply_tool_results`、
`recover_from_model_error` 和 `capture_turn`。依赖不可序列化 `budgetEvaluator` 的
`tryAutoCompact` 本阶段不跨进程代理。未声明 context 的宿主继续使用 `NullContextRuntime`。

工具 descriptor 保留宿主计算的 `requiresUserInteraction`，因此现有 AgentLoop 能按 `canPrompt`
过滤工具，而无需 sidecar 识别具体工具名。声明 `capability.execute_batch` 后，一批 tool calls 只发送
一次 module call，并由宿主原有 ToolScheduler 决定 permission preflight、并发和执行顺序；未声明时
保留 unary 兼容路径。

图片 data URL 只在本次 execute 的 `messages` 映射中转换为 canonical image block，不写入 sidecar 自己的持久化状态。`seedState` 只接受现有 `AgentLoopSeedState` 的可验证 JSON 投影；未知 checkpoint 保持宿主 opaque 数据。session、turn、run、operation 和最终 outcome 继续由宿主 envelope 提供并聚合；默认 factory 不创建第二套宿主状态。

sidecar 的终态 envelope 不重新命名 AgentLoop 已提供的业务错误码。`max_turns` 仍映射为协议
`failed` outcome，但顶层 `code` 与 `AgentLoopResult.errors[0].code` 保持一致；仅在结果没有
错误码时使用 `agent_max_turns_reached` fallback。

## Gateway 全链路对拍接入点

`createAgentSession` 接受内部 `__agentLoopFactory`，`createLocalGateway` 通过
`__testAgentLoopFactory` 仅向部署测试转发该 factory。注入对象只需实现 `AgentLoopRunner` 的
`run()` 与 `snapshotFileState()`；未注入时仍直接构造原生 `AgentLoop`，生产默认行为不变。

该接入点允许测试部署保留真实 HTTP/WebSocket Gateway、Session、Transcript、Router、
ToolScheduler、ToolRuntime 和 PermissionRuntime，仅把 AgentLoop execution transport 切换为
stdio sidecar。sidecar final messages 必须由 host runner 通过 `onDurableMessage` 回写宿主，且 host
abort 线性化后不得继续向已关闭的 Gateway stream 投影晚到非终态事件。

## 验收

- 注入 Model/Tool Port 后正常文本、tool loop、abort、model error 和 tool error 行为与旧实现一致。
- legacy adapter 保持现有 Router 路由、Context budget、ToolScheduler 并发和消息持久化行为。
- v2 契约测试覆盖 slim profile、唯一终态、cancel、sequence 去重、gap、resume 和 cursor 过期。
- Gateway 对拍必须区分同版本 native/sidecar 语义比较与 `origin/main` 版本漂移比较；图片 block
  的派生 `bytes` 可忽略，但 MIME、base64 data、消息分组和顺序必须严格一致。

## 关联契约

- [`docs/pilotdeck-module-communication-sop.zh.md`](../pilotdeck-module-communication-sop.zh.md)
- [`docs/pilotdeck-module-protocol-v2.schema.json`](../pilotdeck-module-protocol-v2.schema.json)
