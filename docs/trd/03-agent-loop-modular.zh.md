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

### Capability / Tool 能力族

Capability 按 DSH 的 Definition / Provider / Consumer 约定组织：

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `ToolPort`（`src/agent/modules/protocol.ts`） | AgentLoop 只依赖稳定 port，不依赖 ToolScheduler 或 transport |
| Native provider | `src/agent/modules/capability/toolSchedulerAdapter.ts` | 将 PilotDeck ToolRegistry/ToolScheduler 适配为 `ToolPort` |
| Host consumer | `src/agent/modules/capability/hostToolPort.ts` | 将 `ToolPort` 调用映射为宿主 `capability` module call |
| Composition | `createSidecarPorts()` | 只组合 model/tool ports，不持有工具策略 |

宿主继续持有 permission preflight、工具副作用和实际 scheduler。Host consumer 只投影 descriptor、
`toolCallId`、arguments、execution context 和结果；声明 `execute_batch` 时整批调用一次宿主，未声明时
保留现有 unary 兼容路径。该目录拆分不改变 Module Protocol v2 字段，也不改变 native/direct 行为。
工具 descriptor 可携带 `requiredRuntimeCapabilities`，用于 scoped registry 在执行前判断 child runtime 是否具备
subagent fork、plan workflow、user interaction 或 Always-On run context；这是工具定义元数据，不是 transport 自己的策略。

### Context 能力族

Context 同样按 Definition / Provider / Consumer 分离：

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `src/context/ContextRuntime.ts` | 定义模型上下文准备、工具结果投影、错误恢复和 turn capture |
| Native provider | `DefaultContextRuntime` / `NullContextRuntime` | 持有 PilotDeck 本地 prompt、裁剪、压缩和恢复策略 |
| Host consumer | `src/agent/modules/context/hostContextRuntime.ts` | 将 ContextRuntime 调用投影为宿主 `context` module call |
| Composition | `pilotdeck-agent-loop-default-factory.ts` | 只根据 `hostModules.context.methods` 选择 provider |

Host consumer 不拼接宿主 system prompt，不实现压缩策略，也不序列化 `AbortSignal`。可选方法只有在宿主
显式声明后才暴露；`prepare_for_model` 是启用 host context module 的必需能力。原
`createSidecarContextRuntime` 导出保留为兼容别名，新的能力族入口为 `createHostContextRuntime`。

### LLM / Model 能力族

Model 的路由决策和调用同样与 transport 分离：

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `ModelInvokerPort`（`src/agent/modules/protocol.ts`） | 只暴露 prepare 和 canonical event stream |
| Native provider | `src/agent/modules/llm/routerModelInvokerAdapter.ts` | 持有 Router decision、request materialization 和 provider execution |
| Host consumer | `src/agent/modules/llm/hostModelInvokerPort.ts` | 将 canonical model request 投影为宿主 `model` module call |
| Composition | `createSidecarPorts()` | 组合 host model consumer，不实现 provider 策略 |

Host consumer 只传递 canonical request 和可序列化 execution context，不传递 `AbortSignal`。宿主成功响应
必须包含 canonical `events`；缺失时以 `INVALID_MODEL_RESPONSE` 失败，不能把非法模型响应静默解释为空流。
每个 `prepare()` 还生成仅限本次 sidecar execute 的 `preparationId`；同一 prepared invocation 的 retry 必须复用它，
宿主据此复用第一次 Router `prepare()` 得到的 decision。该 ID 不是 Session/turn state，不携带 Router opaque data，
不跨 operation 保存；每个新的 `prepare()` 即使在固定 UUID test provider 下也得到不同 ID。
原 `adapters.ts` 继续作为兼容导出 facade，不再承载 Router provider 实现。

### Interaction / Permission 能力族

权限决策通过稳定 port 注入 ToolRuntime：

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `src/permission/PermissionDecisionPort.ts` | 定义工具执行前的结构化权限决策 |
| Native provider | `PermissionRuntime` | 持有本地 rule、mode、plan 和 tool permission 策略 |
| Host consumer | `src/agent/modules/permission/hostPermissionDecisionPort.ts` | 将决策请求投影为宿主 `permission.decide` module call |
| Durable audit adapter | `src/agent/modules/permission/durablePermissionAudit.ts` | 将 session-owned `permission_started/completed/failed` 写入同一 Session event owner，不记录工具输入或答案 |
| Composition | `createAgentSession` / `SubAgentSession` / sidecar default factory | 注入 provider；未提供时回退本地 runtime |

`ToolRuntime` 不再依赖具体 `PermissionRuntime`。主 session 和 subagent 继承同一个 permission provider，
避免子运行时绕过宿主策略。Host consumer 只序列化 tool descriptor、input、permission context 和
`toolCallId`；非法或失败响应不会被解释为 allow。Session composition 会在权限评估前后记录
`permission_started`、`permission_completed` 或 `permission_failed`，审计写入失败保持 fail-closed；这些事件只保留
工具/决策元数据，工具输入和用户答案仍由宿主控制。子 agent 若没有自己的 sidechain event owner，不会把权限审计写入
parent session 的 turn；这项 named provider/continuation 补齐属于后续 subagent 工作包。

### Session / Storage / Checkpoint 能力族

Checkpoint 只向 AgentLoop 暴露经过验证的文件状态投影，持久化和恢复仍由宿主持有：

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `src/agent/modules/checkpoint/seedStateProjection.ts` | 定义并验证 AgentLoop 可消费的 `allowedReadFiles`、`readFileState` 和 `writeSnapshots` 投影 |
| Host provider | 宿主 session/storage | 从宿主持久化状态生成通用 seed projection；宿主 checkpoint、revision 和数据库对象保持 opaque |
| Consumer | `AgentLoop` 构造器 | 只消费 `AgentLoopSeedState`，不查询或写入宿主持久化 |
| Composition | `pilotdeck-agent-loop-default-factory.ts` | 调用 parser 并注入构造器，不创建 checkpoint runtime 或第二套 session 状态 |

`parseAgentLoopSeedStateProjection()` 忽略未知宿主字段，拒绝已支持字段中的非法结构，并复制数组、
Map 和 entry，避免宿主输入与 AgentLoop 共享可变状态。Module Protocol 仍保留 `checkpoint` target 供
宿主 adapter 使用，但默认 sidecar factory 不主动调用 checkpoint module，也不解释宿主 opaque state。

### Session Projection 能力族

Session durable I/O 与 replay 分别通过 SessionRuntime/EventStore 和版本化 projection seam 组织，继续复用
现有 Transcript JSONL，不创建第二套日志：

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Event definition | `src/session/events/SessionEventStore.ts` | 定义 typed draft、committed subscriber、append/read/flush 和恢复契约 |
| Session runtime | `src/session/events/SessionRuntime.ts` | 唯一拥有 sequence、entry chain、JSON materialization、提交队列和 committed event stream；不导入具体 backend |
| Persistence definition | `src/session/persistence/SessionPersistence.ts` | 定义 append/load/flush，不分配 sequence、不派生业务状态 |
| Persistence providers | `JsonlSessionPersistence` / `InMemorySessionPersistence` | 持有 durable backend；通过 required committed subscriber 接入 runtime |
| Compatibility providers | `JsonlSessionEventStore` / `InMemorySessionEventStore` | 保留旧构造入口，内部组合同一 Runtime + Persistence contract |
| Writer compatibility | `JsonlTranscriptWriter` / `InMemoryTranscriptWriter` | 保留原 record 方法，向同一 SessionRuntime 转发，不持有第二套顺序或持久状态 |
| File history producer | `FileHistoryStore` | 产生完整 `file_snapshot_recorded` 状态事件；Gateway 仅连接 writer，resume/recreate 从同一日志恢复 |
| Definition | `src/session/projection/SessionProjection.ts` | 定义 projection name/version、create/reduce/finalize 和 replay context |
| Registry | `src/session/projection/SessionProjectionRegistry.ts` | 注册唯一 projection，并返回可重复 dispose 的 registration handle |
| Live driver | `src/session/projection/SessionProjectionDriver.ts` | 订阅 committed event，维护增量 cell、一致 `asOfSequence` snapshot、change feed、hydrate 和 checkpoint codec |
| Native providers | `AgentTranscriptProjections.ts` / `WebHistoryProjections.ts` / `FileHistoryProjection.ts` | 派生 transcript、subagent、artifact、status、turn error、token usage 和 file-history read model |
| Compatibility consumer | `src/session/transcript/TranscriptReplay.ts` | 保留 `replayTranscriptEntries` API，通过 registry 组合内置 projections |

Projection 只消费宿主持有的 durable Transcript entries，不接收 live model/tool stream，也不拥有 Session、
Turn 或 Gateway 状态。当前 JSONL entry 格式、顺序和 replay 返回结构保持不变；resume 通过 storage 的同一
resume 统一执行 persistence load 后恢复 SessionRuntime，Gateway session composition 也复用该 owner；并发
append、required persistence failure、subscriber 失败隔离和 restore 后继续追加均有 contract test。Web
artifact、status、token usage 和 turn error 已分别迁入版本化 projection，`readSessionMessages` 只负责映射
projection 结果。file history 也已接入统一 driver；Gateway resume/recreate 从同一一致性 snapshot 恢复，更新同一
`messageId` 时保留首次插入顺序并替换为最新状态。`AgentSession` 已在 `projectedMessages()`、
`snapshot()`、`snapshotForRuntimeReload()` 和 durable metadata 读取中消费同一 live projection；运行中的
admission state（status、abort controller、current turn、steer mailbox、FIFO inbox）仍由 session 本身拥有，
不属于 projection。`ProjectSessionStorage` 已组合 `SessionProjectionCheckpointBinding` 与选定 storage provider
的 checkpoint store：恢复时校验 format/version/session/anchor，cache 损坏、版本不匹配或 log anchor 不匹配时
回退到完整 replay。checkpoint 是可丢弃的加速缓存，不进入 Module Protocol，也不成为第二套 session truth。

### Session History Read-side 能力族

应用侧读取 durable transcript 不应让每个 consumer 自行推导 JSONL 路径。该能力族只覆盖读取；它不拥有
`SessionRuntime`、保留策略、fork 写入或 sidechain 的文件资产复制。

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `src/session/history/SessionTranscriptReaderPort.ts` | 定义完整 transcript 读取和有界 user-prompt digest；不泄漏 backend path 或 retention policy |
| Native provider | `src/session/history/ProjectSessionTranscriptReader.ts` | 完整读取经 application-selected `ProjectSessionStorageProvider`；默认 JSONL 的 head/tail 轻量读取只在 provider 内实现 |
| Consumers | `ChatDigestBuilder` / `AlwaysOnChatHistoryTool` | 只消费 reader 返回的 durable entries 或 digest，不能构造 `SessionRuntime` 或直接读取 JSONL |
| Composition | `ProjectAutomationBundle`、Always-On runtime/manager、standalone control、CLI | 将同一 reader 注入 discovery 与 `always_on_read_chat_history`，默认 native factory 只提供兼容值 |

`SessionCatalogPort` 和 `SessionSearchPort` 仍分别承担 session 枚举与文本搜索。它们当前的 Node provider
是 JSONL 定向实现，不是跨 backend retention/query API。Web fork 已有独立的 provider-owned write capability；
replace-last-turn 和 subagent sidechain 的 journal/recovery、原子改写、资产复制及相对路径约束仍不能伪装为这个
read-only port。

### Session Fork Write 能力族

Web fork 是 application 已有的 durable mutation consumer，因此其 backend selection 不能停留在
`readTranscript(.jsonl)` 后再写本地文件。该能力只覆盖创建一个新 session 的 fork target；它不是通用
session mutation 或 retention API。

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `src/session/fork/ProjectSessionForkPort.ts` | `ProjectSessionForkInput` 只携带 source/target identity 与 application 已准备的 target entry plan；不持有 live Session、Gateway 或 title policy |
| Native provider | `src/session/fork/NodeProjectSessionForkPort.ts` | 负责 JSONL target publication、tool-results/file-history/subagents copy 与 path retarget；失败删除尚未发布的 temporary output 和新 target directory |
| Provider selection | `ProjectSessionStorageProvider.fork?` / `createProjectSessionForkPort()` | application-selected backend 明确广告 fork capability；非 native backend 未广告时 fail-closed，不能回退 JSONL |
| Consumer | `src/web/server/forkSession.ts` | 只读取 selected persistence，计算 fork point、prefill/title/metadata，并提交 target entry plan |
| Composition | `GatewaySessionHistoryBundle` / `createLocalGateway` | 将相同 `storageProvider` 从 Gateway application composition 透传给 Web fork consumer |

source `SessionRuntime` 仍是 durable truth；fork consumer 不创建 live child session，也不接管 Router/Gateway state。
Node provider 在 target transcript publish 前完成 auxiliary copy，因此 catalog 看见 target transcript 时对应 artifact
目录已经准备完成。非 Node provider 自己定义其 artifacts、transaction 和 recovery 语义；没有 port 时返回
`ProjectSessionForkUnavailableError`。`replaceLastTurn` 的 pending journal、commit/rollback、owner lease 与 process
crash recovery 是另一条 write capability，不能为了接口对称合并进 fork port。

### Session Replacement Write 能力族

Latest-turn edit 是由 Gateway prepared transaction 驱动的 durable mutation。它与 fork 的 target publication
不同：在 replacement accepted-input 之前，original stream 必须可以恢复；live reservation 不能被 storage provider
或 Web consumer 复制。

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `src/session/replacement/ProjectSessionReplacementPort.ts` | 只传 original/replacement stream、transaction identity、owner 和 action；provider 不能取得 Router/Gateway live state |
| Native provider | `src/session/replacement/NodeProjectSessionReplacementPort.ts` | 保持 backup、temporary rewrite、commit/rollback、owner-aware process recovery 的兼容文件格式 |
| Selected provider | `ProjectSessionStorageProvider.replacement?` | non-native backend 同时提供 `prepare`、`finalize`、同步 `recover` 才可参与 Web replacement；未提供时 fail-closed |
| Consumer | `replaceLastWebSessionTurn` / `finalizeLastWebSessionTurnReplacement` | 读取 selected persistence、验证 latest accepted input 并生成 rewrite plan，不管理 backup 或 recovery |
| Composition | `GatewaySessionHistoryBundle` / `createLocalGateway` | history bundle 透传 storage provider；local boot 在 Gateway publication 前执行 selected provider recovery |

`GatewayTurnReplacementCoordinator` 仍持有 pending reservation、submission claim、acceptance-time commit 和 timeout
rollback；它通过 narrow storage functions 调用 replacement provider，且不保存 backup。custom provider 的 startup
recovery 当前为同步 contract，契合 local Gateway 的同步 boot boundary；需要异步 remote recovery 时必须单独改变
application publication lifecycle，不能在 provider 内静默启动后台恢复。

### Scope / Owned Registration 基础

进程内 provider 生命周期由 `src/agent/scope/ScopedServiceRegistry.ts` 提供通用基础契约：typed token、
parent/child 可见性、局部 override、单调 generation、受管 lease、stop-new、drain 和异步 dispose。provider
替换先发布新 generation，再等待旧 generation 的在途调用完成；scope 关闭时先阻止新调用，等待 child scope
及从该 scope 发起的继承调用，然后释放本地 provider。重复 dispose 幂等，多个 disposer 失败会聚合报告且不会
阻止其他资源释放。

该层不进入 Module Protocol，也不是全局 DI 容器。`AgentRegistry / AgentHandle` 已复用这一契约并接入
SessionRouter：handle 跟踪 submit generator、在 dispose 时停止新 turn、触发 abort、等待 idle，再释放
session-scoped storage；registry 统一 replacement/removal，SessionRouter 的 close、dirty recreate 和 shutdown
不再只删除裸 `AgentSession` 引用。

`AgentRuntimeScope` 在该基础上组合 agent runtime service。主 session scope 注册 router、context、permission、
ToolRegistry、ToolRuntime 和 ToolScheduler；SubAgentSession 创建 child scope，继承 router/context/permission，局部覆盖并
拥有 child ToolRegistry/ToolRuntime/scheduler。ToolRegistry child view 动态委托 parent，不复制 tool definition；
`requiredRuntimeCapabilities` 与 subagent profile allowlist 共同决定工具可见性，嵌套 subagent、plan workflow、
user interaction 和 Always-On run context 均通过 capability requirement 拒绝，不再在 SubAgentSession 按工具名判断。
child scope 在成功、失败、abort 和 timeout 后统一 dispose。Agent-scoped prompt/tool/hook contribution ownership、scope-filtered
event carrier 和 agent create/resume 发布事务均已闭环；通用跨域 contribution layer 与 profile/bundle 组合仍属于后续工作。

## Module Protocol v2

Transport / Protocol 同样按 Definition / Provider / Consumer 分离：

| 角色 | 代码入口 | Ownership |
| --- | --- | --- |
| Definition | `src/agent/modules/protocol.ts` | 定义 envelope、identity、outcome、capabilities、Port 和结构校验，不持有 operation 状态 |
| Native provider | `src/agent/modules/transport/moduleRuntime.ts` | 提供进程内 adapter、operation 状态、sequence 去重与 resume 行为 |
| Sidecar provider | `src/agent/modules/transport/agentLoopSidecarServer.ts` | 提供双向 NDJSON server、cancel/deadline 和唯一终态投影 |
| Host consumers | `capability/`、`context/`、`llm/`、`permission/` | 将稳定 Port 调用映射为宿主 `module_call` |
| Composition | `src/agent/modules/transport/sidecarPorts.ts` | 组合 host model/tool consumers，不实现 provider、permission 或 session 策略 |

`src/agent/modules/sidecar.ts` 和 `src/agent/modules/adapters.ts` 仅保留兼容导出。transport provider
不改变 Gateway 对外 API，不创建第二套 session/turn/run 状态，也不把 Router 内部 provider retry
暴露为公共 attempt。

`SessionAgentLoopOperationLedger` 是 sidecar transport 的宿主 provider：它将 execute 的 immutable
`runId`、`operationId`、`requestId`、binding、accepted `streamId` 与 terminal observation 写入同一个
SessionRuntime/Transcript。`result_unknown` 仅在同 identity 已有 known terminal 时才可被它 resolve；否则
必须失败关闭。sidecar `status` 仅返回当前连接内的 live `ModuleOperationSnapshot`，不能取代该 durable ledger
或取得 Gateway/Session 的 ownership。

## Sidecar Factory Mapping

`src/cli/pilotdeck-agent-loop-default-factory.ts` 是一个 transport-independent 的默认 payload mapper，不属于任何宿主业务层。它从 execute payload 的 `agent`、`task`、`messages`、`tools`、`permissionContext`、`seedState` 和 `executionContext` 构造 `AgentRuntimeConfig`、`AgentLoopInput` 与可恢复的文件状态；宿主仍可通过 `PILOTDECK_AGENT_LOOP_FACTORY` 提供自己的 mapper。宿主专属字段必须在宿主 adapter 中转换，不能让默认 factory 依赖具体业务类型或注入专属系统提示、权限提升或最终结果语义。

宿主可以在单次 execute 通过可选 `contextOverride` 显式接管上下文：`systemPrompt`、canonical `messages`、`metadata` 和 `tools` 分别覆盖对应的普通字段。override 的 metadata 会与 `executionContext` 合并，显式值优先；显式提供 messages（包括空数组）时不再回退到 `task.prompt`。default factory 只解析 canonical 结构，不识别宿主的 TaskFrame、Harness 或其他业务字段。

execute payload 的 `hostModules` 声明宿主可调用模块能力。声明 `context.prepare_for_model`
后，默认 factory 注入 host-backed `AgentContextRuntime`；可选代理 `apply_tool_results`、
`recover_from_model_error`、`capture_turn` 和 `try_auto_compact`。`try_auto_compact` 会在
跨进程映射时丢弃不可序列化的 `budgetEvaluator`，由 host context provider 自己评估预算；未声明 context 的宿主继续使用
`NullContextRuntime`。

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
