# AgentLoop Modular Framework 文档总览

状态：执行稿　维护者：Agent Runtime 团队

本文是 PilotDeck AgentLoop 模块化框架的文档入口。协议和 AgentLoop 核心规范归
PilotDeck；宿主产品的 session、turn、permission、tool、checkpoint、SOP/Harness
和最终状态仍由宿主维护。

## 阅读顺序

1. [人类开发流程文档目录](agent-loop-human-development-directory.zh.md)

   按需求、协议、实现、回归、真实部署、对拍和发布阶段组织现有文档，适合人类开发者快速定位入口。

2. [人类模块化开发交互 SOP](agent-loop-human-operation-sop.zh.md)

   面向人类与 coding agent 的协作，给出需求提法、范围约束、对拍差异修复、结果审查和提交授权方式。

3. [AgentLoop 接入开发 SOP](agent-loop-development-sop.zh.md)

   面向开发者的阶段流程、DSH 能力族模块划分、代码修改范围、mapping/TRD 产物、分层测试、真实部署、对拍和发布检查。

4. [Module Communication SOP](pilotdeck-module-communication-sop.zh.md)

   规范身份字段、operation/attempt 状态、终态、取消、deadline、重试、恢复、profile
   和 transport-independent adapter 约定。当前文档版本为 v0.7，协议版本为 v2.0。

5. [Module Protocol v2 Schema](pilotdeck-module-protocol-v2.schema.json)

   机器可读的 request、response、event、error、module_call 和 host module 字段定义。

6. [AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md)

   说明五类 model consumer ports、`ToolPort`、`AgentContextRuntime`、session projection、scope lifecycle、
   sidecar factory、context module 和 capability module 的实现边界。

7. [PilotDeck DSH 风格模块化 Roadmap](trd/04-dsh-modularization-roadmap.zh.md)

   对照 DSH 的 capability seam、scope、session event/projection、owned lifecycle 和
   profile/bundle 组合模型，列出 PilotDeck 当前成熟度、未模块化主体及分阶段迁移门槛。

8. [DSH 与 PilotDeck 当前执行 Roadmap](trd/05-dsh-pilotdeck-current-roadmap.zh.md)

   基于 DSH `0.1.2-alpha.2` 发布实现与当前 PilotDeck 组合链的复核结论，明确当前模块成熟度、
   不可迁移的 state owner，以及从 stdio sidecar provider 开始的实际交付顺序。

9. [StaffDeck AgentLoop Integration](https://github.com/Kaguya-19/StaffDeck/tree/codex/pilotdeck-agent-loop/docs/pilotdeck-agent-loop-integration.md)

   StaffDeck 的具体 glue、TaskFrame/Harness mapping、checkpoint 投影、权限聚合和
   result_unknown 处理只在 StaffDeck 仓库维护，不成为 PilotDeck core contract。

10. [PilotDeck Native / Sidecar 对拍 SOP](pilotdeck-agent-loop-parity-sop.zh.md)

   PilotDeck 原生与 sidecar 的比较范围、adapter 契约、scenario 矩阵、canonical trace、
   normalization、退出码和 gateway 验收门槛。

   实际运行记录见 [PilotDeck AgentLoop 对拍结果](pilotdeck-agent-loop-parity-results.zh.md)。

11. [AgentLoop parity README](https://github.com/Kaguya-19/StaffDeck/tree/codex/pilotdeck-agent-loop/tools/agent-loop-parity/README.md)

   跨宿主对拍 harness、mock provider/tool、canonical trace 和 StaffDeck 真实部署验证方法；
   PilotDeck-only 工具则位于本仓库的 `tools/agent-loop-parity/`。

## 架构边界

```text
宿主 Session/Turn/Run
        |
        +-- context module  -> 宿主 ContextRuntime
        +-- capability      -> 宿主 ToolRuntime/PermissionRuntime
        +-- model           -> 宿主 Model provider
        +-- checkpoint      -> 宿主持久化和恢复逻辑
        +-- event           -> 宿主 AgentEventEmitter（仅 live projection）
        |
        +-- PilotDeck AgentLoop
              +-- canonical messages
              +-- model/tool loop
              +-- unique terminal outcome
              +-- sidecar protocol adapter
```

AgentLoop 不识别 StaffDeck 的 TaskRequirement、HarnessAction、TaskFrame 或租约字段。
宿主将自己的业务状态投影为通用 payload；sidecar 只消费 canonical messages、tool
descriptors、permission context、seed state 和 execution identity。

### 当前 application composition 边界

- AgentLoop 通过冻结的 `AgentTurnContextPort` 和 `LifecycleDispatchPort` 消费 context/lifecycle；完整 runtime
  仍由 session scope 持有和释放。
- AgentLoop 的模型面向 consumer ports 分层：`ModelExecutionPort` 是必需核心，`AgentTurnRoutingPort`、
  `ModelMetadataPort`、`ModelBudgetPort` 与 `AuxiliaryModelPort` 均可独立注入；Router 只是兼容 facade，
  不拥有 AgentLoop 或 provider registry。第三方 provider 只能通过 adapter 接入 canonical request/event contract。
- Session durable backend 由 `ProjectSessionPersistenceProvider` 定义；application 在启动时组合
  `ProjectSessionDataPlane`，再把 catalog、fork、replacement、search 分别交给对应 consumer。旧
  `ProjectSessionStorageProvider` optional capability bag 仅作兼容入口。
- Plugin generation 仍由 `PluginRegistry` 唯一管理。session composition 获取
  `PluginSessionContributionSnapshot`，Gateway command catalog 获取 `PluginCommandCatalogSnapshot`；两个 lease
  都绑定获取时 generation，retired plugin 等全部旧 lease 释放后才 dispose。
- `PluginContributionSnapshot` 与原 acquisition API 暂时保留为 deprecated adapter；生产 session/context/command
  路径不再依赖完整 aggregate。

模型依赖方向固定为：

```text
provider client / SDK
        -> provider adapter（native 或 host）
        -> ModelExecutionPort
        -> createAgentTurnCapabilities()
        -> AgentLoop

AgentTurnRoutingPort / ModelMetadataPort / ModelBudgetPort / AuxiliaryModelPort
        -> application composition（可与 execution provider 分开选择）
Router facade --------------------------^（legacy/default adapter，可选）
```

`ModelExecutionPort` 是 AgentLoop 的核心 consumer contract。直接构造 capabilities 时 Router 不是必需 owner，但完整
`AgentRuntimeDependencies`/session/Gateway composition 仍保留 Router 依赖。显式 execution provider 可以绕过 Router，空
Router 不能提供模型执行。`ModelInvokerPort`、旧 aggregate 字段和 `PreparedModelInvocation.opaque` 仅在兼容
adapter 中保留，直到 native/sidecar/session/subagent/Gateway 回归证明可以删除。详见
[AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md)、[接入开发 SOP](agent-loop-development-sop.zh.md)
和[当前执行 Roadmap](trd/05-dsh-pilotdeck-current-roadmap.zh.md)。

Workflow、Agent Terminal、Goal round driver、SQLite query 与跨平台 sandbox 是独立功能扩展，不属于本轮
边界收窄；本轮不迁移任何 Plan/Todo、Cron、Always-On、Goal、Session 或 Gateway 状态 owner。

## 跨语言和 transport 约定

- Module Protocol 使用 JSON/NDJSON wire format，字段和终态由 v2 Schema 定义，语言实现
  不受 TypeScript 限制。
- AgentLoop 核心只依赖 ports；sidecar server、host stdio provider 和 loopback TCP reconnect provider 已作为
  capability-only external loop factory 纳入应用组合，不是协议唯一 transport。stdio 仍是一 turn 一 child process，
  TCP 才广告 `resume`/`ack` 并在同一 sidecar instance 上恢复 stream。`status` 是同连接 live snapshot；
  `result_unknown` 的 durable reconciliation 仍由 session-owned ledger 决定，见[当前执行 Roadmap](trd/05-dsh-pilotdeck-current-roadmap.zh.md) 的 R1/R2。
- 其他语言或通道可以实现自己的 adapter，但必须保持 `hello`、`capabilities`、`execute`
  以及适用的 `cancel`、`status`、`resume`、`ack` profile 语义。
- 宿主必须拥有 session/turn/run/operation 最终状态；模块不得创建第二套公共状态。
- permission、tool 并发、checkpoint 持久化和最终结果聚合由宿主负责，不能在 sidecar 内复制
  宿主业务规则。

## 接入开发 SOP

每次新增或修改模块能力时同步更新：

1. JSON Schema 中的字段/profile 定义；
2. 本 SOP 的身份、终态、错误和 Mapping 章节；
3. TRD 中的 port、adapter 和 ownership 说明；
4. 协议单元测试，包括 malformed message、duplicate、乱序、sequence gap、cancel、
   deadline、断线和恢复边界；
5. 至少一个真实宿主 adapter 的端到端验证记录。

接入前必须明确 module profile、能力版本、request/event identity、错误码、retryability、
副作用和恢复策略。不得把宿主专属字段放进 PilotDeck 默认 factory，也不得用宽泛的
normalization 规则隐藏 semantic diff。

## 当前验收状态

- PilotDeck native vs sidecar 与真实 Gateway surface：default-sidecar 和 Gateway 的 `core-resilience` 均为 20/20 当前复核通过，
  且无 semantic diff、oracle failure 或 `BLOCKED`。P0.2 的 read-file permission input、cancel terminal ordering、mixed-permission
  oracle 和 write-snapshot projection 已闭合；Gateway 适配层同样在 terminal 前 drain 已受理的 module call。命令与 trace 证据见
  [DSH 风格模块化 Roadmap](trd/04-dsh-modularization-roadmap.zh.md)。
- `auto_compact` 已纳入 context host-module method；sidecar 只有在 capabilities 广告 `try_auto_compact` 时才启用该 consumer，未广告时保留原有 fallback。
- `plan_todo` 已作为可选 capability host-module method 闭合；Session projection 是唯一 durable truth，sidecar 只持有按 active session/turn 校验后的 cache，不能演变为 generic workflow registry。
- `lifecycle.dispatch` 已作为可选 host-module method 闭合；host 继续拥有 plugin registry、turn environment 和 teardown，sidecar 仅消费 hook dispatch result。
- capability host dispatch 会从 active host capability view 重建 audit、interaction、file/plan services、turn environment 和 model routing；read/write seed state 与 full-fork subagent state 继续按 checkpoint/R3 owner 隔离。
- `event.emit` 已作为可选 host-module method 闭合；sidecar 串行回传 AgentLoop volatile event，并在 final 前 flush 已受理 delivery。它不是 Session truth、operation ledger 或 reconnect state；event failure 不得改写业务 terminal。
- session read-side 已按 selected storage provider 组合 catalog 与 transcript reader；Web fork 通过 `ProjectSessionForkPort` 把 target durable write、auxiliary artifact transfer 和 publication 留给 provider，Web replace 通过 `ProjectSessionReplacementPort` 把 backup/rewrite/finalize/recovery 留给 provider。未声明 catalog/fork/replacement 的 non-native backend 分别 fail-closed；Gateway 继续拥有 replacement 的 live reservation 和 timeout。
- StaffDeck workflow 对拍已能真实进入 Harness，但 SOP step/slot/handoff、deadline、
  unknown result 等宿主状态仍有差异，不能作为 PilotDeck core 已完全验收的依据。
- `src/workflow/` 已具备 caller-owned Definition/Run/Control、InMemory 与 JSONL EventStore、DAG 执行、只读 live event observer、pause/resume/cancel/deadline/dispose、owner fence 和 unknown recovery；它仍不接管 Plan/Todo、Cron、Always-On、Goal 的 durable owner，也没有 generic registry。
- `session-title` 已具备 provider/model provenance、user-pinned source、source turn 与 accepted-input sequence 的兼容 metadata 投影；独立 DSH `user/message` seq 事件仍未引入，避免把聚合 `accepted_input` 错当作逐消息 durable event。
- 完整生产级跨语言 SDK、Schema runtime validator 和具体 Gateway/remote deployment 的断线 E2E 仍是后续工作；
  loopback TCP provider 已覆盖 AgentSession 的 resume/ack 本地契约，但不等同于上述部署验收。

## 验证命令

在 Node 22 环境运行：

```text
pnpm build
node --test dist/tests/agent/modules/*.js \
  dist/tests/agent/session/agent-loop-factory.spec.js \
  dist/tests/protocol/module-protocol-contract.spec.js
git diff --check
```

对拍和真实部署命令、版本、退出码及临时产物位置见 StaffDeck 的实验记录，不将 trace、
SQLite、日志或 token 提交到 PilotDeck。
