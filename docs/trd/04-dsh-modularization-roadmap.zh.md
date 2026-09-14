# PilotDeck DSH 风格模块化 Roadmap

状态：审计历史。当前执行队列、成熟度和验证证据以 [05 DSH 与 PilotDeck 当前执行 Roadmap](05-dsh-pilotdeck-current-roadmap.zh.md) 为准；本文件保留 DSH 对照、设计决策、对拍与已完成切片的审计记录。　维护者：Agent Runtime 团队　最后审计日期：2026-09-11

## 0. 决策摘要

PilotDeck 已经不是“没有模块化”，但也还不是 DSH 式完整模块系统。当前最准确的判断是：Agent 发布与生命周期
达到 M3；Session persistence/projection、transport 和若干调用 Port 达到 M2；Agent-scoped 的 prompt/tool/hook contribution
lifecycle 已闭环；Scope、Subagent、Prompt/Context、Interaction、Compaction 等能力族仍有局部缺口；task control 已形成
session-owner fence、first-wins terminal settlement 与 output-drain，但尚不具备 reconnect 或 durable job state；Profile/Bundle/Boot
已完成 Always-On/Cron、project runtime resources、local Gateway lifecycle、server shutdown、channel adapter、channel lifecycle、
session interaction、session tool、session context、session file history、session plan/todo、session subagent transcript 与 continuation
consumer，以及 `sandboxMode` / runtime-context surface / interaction 的不可变 native runtime profile（R5.32）。完整跨部署
profile/boot 仍未形成。不能用新增目录数或 Port 数量代替模块完成度。

| 分类 | 当前模块/能力 | 结论 |
| --- | --- | --- |
| 已形成稳定基础 | `core/agent` publication/lifecycle；Session persistence/projection；Module Protocol transport；Model/Tool/Context/Permission 调用 Port | 可以作为后续模块的基础，不回头重写 |
| 部分模块化 | AgentLoop、core Session、Scope、Prompt/Context、Subagent、Interaction、Compaction、Execution World、LLM Policy、非 Agent-scoped Extension provider、Profile/Bundle/Boot | 已有 Definition 或 lifecycle 的一部分，但 owner、consumer、scope、失败语义或真实 composition 尚未全部闭环；`ProjectAutomationBundle` 与 `ChannelAdapterBundle` 已是可复用的 application-owned native M2 composition，Agent-scoped prompt/tool/hook contribution 亦已是可复用基础 |
| 尚未形成完整 seam | Sandbox/Agent terminal、完整 Attachment capability、完整 Profile/Bundle/Boot | UI interactive terminal 已以 `TerminalSessionRegistry` 收敛 exact PTY/socket binding、buffer replay、detached timeout、old-owner fence 和 server shutdown dispose；浏览器 `useShellConnection` 同时以 current-socket identity 忽略旧连接的 delayed init/message/close/error。它仍不是可供 Agent tool 调用的 terminal Definition。Fs/Subprocess/Shell foreground/DetachedShell、Attachment reader、Spill storage、RouterRetryPolicy、RouterUsageObserver、RouterTokenMeter、RouterFallbackPolicy、RouterRequestMaterializer、RouterCachePolicy、RouterModelInvocationPort 与 RouterOrchestrationPolicy 均已有窄 M2 seam；`ProjectRuntime` 已拥有 invocation registry、session lease、stage/publish/retire reload、serialized reload 和 partial-build cleanup；per-session MCP 以 exact registration ownership 隔离 dirty recreate 的新旧 handle；browser upload 已以 disk-backed artifact lease 覆盖跨 UI/Gateway process 的 retention race，通用外部 attachment/retention policy 仍未形成，Spill 的 retention/query policy 仍归 Session artifact lifecycle 后续工作 |

当前关键路径分为 native 主线和部署/组合 gate。P2 的 native command、P3-A 的 profile
选择与 native composition、P3-B 的 resumed channel ownership、P3-C 的 bridge reconnect/terminal replay 均已完成。
P3-C 已以真实 WebSocket 覆盖 permission/question 的断线回放；native 主线进入 P4：

```text
native 主线： P3-A Interaction profile/provider selection（已完成）
                -> P3-B resume ownership / channel disposal（已完成）
                -> P3-C browser replay projection（已完成；不新建 pending state）
                -> P4-A/B/C LLM invocation registry、Router adapter、generation-aware health（已完成）
                -> P4-D ProjectRuntime lease 与原子 config reload（已完成）
                -> P4-D.1 reload/staging ownership 加固（已完成）
                -> P4-E.1 ExecutionWorldBundle ownership（已完成）
                -> P4-E.2 enforcing sandbox（macOS `execute_code` + foreground/detached shell 首段已完成）/ UI interactive terminal lifecycle（已完成首段）
                -> P4-E.3 余下 LLM policy 与部署 parity
                -> P5  Non-Agent-scoped Extension provider lifecycle / telemetry
                -> P6  Profile / Bundle / Boot 收敛

部署/组合 gate： P0  remote/sidecar/queued subagent parity（按需）
                -> P1  host/remote prepared-request retry parity
                -> P2  compaction profile selection、cold-resume/retry contract、remote/sidecar parity
```

R0.1/R0.2 已完成后，continuable subagent 已进入本地 Gateway 的真实组合路径：
`createLocalGateway` 构造唯一 shared manager、native host、provider registry 和 agent directory，
session publish 时绑定 exact parent，并把 `subagent`/`send_message` consumer 注册到 session-owned registry。
当前 R0 的剩余缺口不再是本地 settlement 或 parent close/recreate 的 child-first graph：这些已由
`SubagentContinuationManager`、`AgentHandle` dispose-start hook 和本地 Gateway session configuration 接通。
R0.4 的剩余是 remote/sidecar/queued provider 的真实部署 parity；native child 的
continuable nested consumer 已通过每 child 的精确 local port 接入。`agent.subagents.maxDepth` 显式控制层数，
默认 `1` 保持单层兼容；仅 `general-purpose` child 在仍有额度时获得 `subagent_fork` capability。

## 1. 范围与基线

本文以 DeepSeek Harness `0.1.2-alpha.2` 的 npm 发布产物为版本基线，核对 PilotDeck 当前 Agent、Session、Context、
Tool、Interaction、Extension 和应用组合架构，并给出分阶段迁移路线。本文不把本机另一份 `0.1.0-rc.8` 源码 checkout
误作 alpha.2 的源码证据。

对照重点不是 DSH 的 package 数量或 Cordis 实现本身，而是以下架构性质：

1. 稳定 seam 拥有 Definition、Provider、Consumer 和 Composition 四个角色；
2. capability 在 agent/session scope 内可组合、可替换、可撤销；
3. provider 注册产生 owned effect，卸载时能够 drain/dispose consumer；
4. durable session event 是会话状态真源，projection 从事件日志派生；
5. live agent event、durable session event 和 policy/capability event 分域；
6. profile/bundle 负责 provider 选择和装配，核心 runtime 只消费 scoped typed service，不依赖应用层巨型
   dependency bag 或分散的手工 `new`；
7. transport 是 seam 的可选投影，不等于模块本身。

PilotDeck 当前实现基线为 `Kaguya-19/refactor/core_agent_loop_0831`（核对提交
`20b88268dc8fd8d600facf7fc68af907769cc36d`，并包含本 worktree 尚未提交的模块化改动）。现有
[AgentLoop Modular Framework TRD](03-agent-loop-modular.zh.md) 和
[Module Communication SOP](../pilotdeck-module-communication-sop.zh.md) 继续有效；本文扩展的是进程内模块化、
作用域、生命周期和组合模型，不重定义 Module Protocol v2。

### 1.1 核对材料

本次结论不是按 DSH 包名猜测。判断以 `0.1.2-alpha.2` 发布契约为基线，并与本机固定版本源码 checkout
`/Users/a1/Desktop/claw/openbmb/deepseek-harness-dsh-v0.1.2-alpha.2` 交叉核对：该 checkout 的 HEAD 为
`0a53fb55bea101816fa226bb964ae2bed71c343b`（`release/dsh-0.1.2-alpha.2` 合并提交）。发布包的
`package.json`、README、构建入口和 bundle patch，以及源码中的 package manifest、Definition/Provider/Consumer
实现共同作为本文件的证据；源码路径只用于解释实现，不等同于 npm 发布物中的 `lib/` 路径。

下列条目均以 alpha.2 可观察的契约为准；若源码 checkout 与发布说明存在表述差异，优先采用可导出的类型、实际
composition 和测试所证明的行为，不把未发布的实验实现写成 alpha.2 事实：

- `dsh-scope`：父子 scope、按 scope 可见的 registry layer、注册 effect 与 dispose；
- `dsh-agent` / `dsh-agent-loop`：可替换工厂、`AgentHandle`、停止、排空、作用域撤销和 session detach；
- `dsh-session`：进程内仅追加事件日志、typed event、surface/message 派生与 flush checkpoint；
- `dsh-session-persistence`：独立于 Session core 的 backend coordinator；JSONL 与 SQLite persistence
  provider 均可独立装配，`dsh-base` 的默认组合使用 JSONL；
- `dsh-session-query-sqlite`：独立的可丢弃派生索引，不是 SQLite persistence provider，也不是状态真源；
- `dsh-session-projection`：实时事件驱动、`stateVersion`、一致性快照、变更通知与 checkpoint；
- `dsh-system-prompt` / `dsh-tools`：按 scope 注册、遮蔽、限制和可撤销 contribution；
- `dsh-user-approval` / `dsh-user-questions`：交互服务、应答者与策略分离；
- `dsh-subagent`：服务定义、具名 provider、工具 consumer 与运行所有权分离；
- `dsh-app-boot` / `dsh-base`：profile、bundle、patch 和启动失败回滚。

PilotDeck 侧核对了真实调用链，而不只看目录名：`AgentRuntimeDependencies`、`AgentSession`、
`SessionRouter`、`createAgentSession`、`SubAgentSession`、`ToolRegistry`、`DefaultContextRuntime`、
`PluginRuntime`、`createLocalGateway`、Session event/projection 和 Web history reader。

再次按 alpha.2 发布产物核对后，需要特别保留以下 DSH 语义，不能只复制接口名称：

- DSH scope 不是普通 DI 容器。注册所用的 scoped context 同时决定 contribution 的可见性和释放 owner，
  parent/child layer、事件路由和 effect teardown 使用同一 scope identity；
- DSH `AgentHandle` 是只交给创建者的 teardown capability，同时 factory provider 也是结构性 owner；create/resume
  在发布前完成 scoped setup，失败时回滚未发布的 agent、session 和全部 contribution；
- DSH Session 日志不是事后 transcript。所有模型可见输入和 turn/step/tool 控制事实先成为 durable event，模型历史、
  UI、恢复、fork、query 和 telemetry 再从日志派生；
- DSH subagent 是 Definition、具名 Provider、tool Consumer 和 owner 分离的 seam；in-process fork 只是一个 provider，
  不是 core loop 内固定的特殊分支；
- DSH profile/bundle 是有序插件树与 patch 层，不是另一份 runtime dependency object。

本 roadmap 不要求引入 Cordis；目标是保留这些 ownership、state 和 composition 性质，并用 PilotDeck 现有 TypeScript
边界实现。

### 1.2 本轮复核证据

本轮同时核对 DSH `0.1.2-alpha.2` 的发布实现、README、`.d.ts`、`dsh-base` dependency closure，以及本 worktree
的实际 consumer/wiring。以下事实作为 roadmap 排序依据：

| 架构性质 | DSH 发布契约 | PilotDeck 当前证据 | 结论 |
| --- | --- | --- | --- |
| Session 真源 | `dsh-session` 明确规定 model-visible facts 先写 append-only log；`turn/start`、`step/start`、`assistant/chunk`、`tool/call`、`tool/result`、`request/header` 均是 typed event | `AgentTranscriptEntry` 已补 turn/step、context/instructions、最终 request、canonical stream、tool call/result 和 inbox mutation；AgentSession durable state 已改读 projection | WP9C/WP9D 已完成；WP10C 已接入动态 context/instruction 事实 |
| Session 恢复 | DSH seed 要求完整领域校验，并对未闭合 turn/step/tool call 做拒绝或 crash repair | `SessionRuntime` 已同时校验 envelope 与 turn/step/tool/inbox 领域关系，并保留 gap/branch/orphan、legacy 日志和 crash tail 兼容；storage 已支持 checkpoint + tail | WP9D 已完成，cache 失效时回退 full replay |
| Agent 发布 | DSH `create/resume` 在 agent/session 未发布时执行 setup，可在发布点同步 commit；失败完整回滚 | `AgentFactoryProvider` 已在 create/resume/recreate 外围提供 unpublished setup、同步 registry commit、失败 rollback 和 provider co-ownership | WP10B 已完成；后续 contribution 接入复用该 transaction |
| Scope | DSH 用同一 scope identity 决定 registry 可见性、event admission 和 effect teardown | `ScopedServiceRegistry`/`AgentRuntimeScope` 已覆盖 service inheritance、override 和 teardown，但未覆盖 contribution/event | 当前 scope 是可复用基础，不是完整 DSH scope 等价物 |
| Projection | DSH registry 单次订阅 committed stream，domain 只注册纯 fold；checkpoint 带 state version 与 event watermark | `SessionProjectionDriver` 已有增量 cell、统一 `asOfSequence`、版本化 codec，AgentSession/Web consumer 已迁移；默认 projection、checkpoint store、恢复和 flush 已接通 | live/cold consumer 与 checkpoint 闭环已完成 |
| Subagent | DSH 是 named provider registry；provider、tool consumer、continuation 和 run owner 分离；continuation manager 持有 child `AgentHandle`，child Agent inbox 是唯一 FIFO admission owner | PilotDeck 已有 named provider/generation、detached `prepareContinuable`、Agent-owned durable FIFO；`SubagentContinuationManager` + `NativeSubagentContinuationHost` 已持有 live child handle，并把 initial/follow-up 全部提交到该 inbox；v2 continuable descriptor 在首个 enqueue 前持久化 cold-resume composition；无 live activation 时可经 host inspect/resume 从 parent-owned child log 重建；exact live-parent 以 active handle + directory object identity 授权；Gateway 为每个 handle 注册精确绑定的 `subagent`/`send_message` consumer | R0.3 native M3；provider、inbox、manager ownership/admission、descriptor、cold-resume、settlement、child-first graph 和 nested consumer 已有。Gateway continuable sidecar 已通过 live/cold follow-up 与 parent-close；仍缺 one-shot、parent abort、late terminal 及 remote/queued provider parity |
| Composition | DSH profile 是有序 bundle patch 层，boot 失败会 teardown 已启动 plugin tree | PilotDeck 仍由 `createLocalGateway.ts` 和 default factory 集中手工装配 | profile/bundle 必须最后收敛，不能提前复制 dependency bag |

因此，本轮复核后的总判断是：PilotDeck 已形成一组可用的模块化基础设施，`core/agent` 在当前阶段达到 M3，多项调用
seam 达到 M2；但尚无覆盖 Session、Agent、Contribution 和 Composition 全链路的 M4 模块。后续工作应继续以 ownership
和 source of truth 闭环为验收标准，而不是以新增目录或接口数量计数。

### 1.2.1 可复核发布产物锚点

为避免把 DSH 的 README 描述误当成架构契约，本次判断以 `dsh-v0.1.2-alpha.2` 发布包的
`lib/index.js`、`lib/types/*.d.ts` 和 `dsh-base/cordis.patch.yml` 为主证据，并以 README 与 package
dependency closure 交叉验证。表中的 `packages/...` 是 npm 包对应的逻辑模块名，不是本机 alpha.2 源码路径。
PilotDeck 侧对应当前 worktree 的实际实现。

| 语义 | DSH 模块/产物锚点 | PilotDeck 对应锚点 | 本 roadmap 的解释 |
| --- | --- | --- | --- |
| scope identity、父子继承、事件路由、释放边界 | `dsh-scope`：`lib/index.js`、types | `src/agent/scope/ScopedServiceRegistry.ts`、`AgentRuntimeScope.ts` | scope 同时决定可见性和 owner；仅有 service token 不足以宣称 DSH scope 完成 |
| agent factory、发布事务、teardown capability | `dsh-agent`：`lib/index.js`、types | `src/agent/scope/AgentFactoryProvider.ts`、`AgentRegistry.ts`、`src/gateway/SessionRouter.ts` | setup 必须在 publish 前完成，失败需回滚；`AgentHandle` 只交给创建者 |
| append-only session、surface replacement、flush | `dsh-session`：`lib/index.js`、types | `src/session/events/SessionRuntime.ts`、`src/session/projection/` | 原始日志是真源，surface/projection 可重建；replacement 不物理删除原始 tool result |
| persistence 与 projection 分离 | `dsh-session` / `dsh-session-projection`：README、`lib`、types、base manifest | `src/session/persistence/`、`src/session/projection/` | backend 只负责 durable append/load/flush，projection cache 可丢弃并从 log + tail 恢复 |
| prompt/tool scoped contribution | `dsh-system-prompt` / `dsh-tools`：base manifest 与 alpha.2 文档 | `src/context/prompt/PromptContributionRegistry.ts`、`src/tool/registry/ToolRegistry.ts` | prompt 可注册不代表工具出现第二真源；schema 必须只读派生自 ToolRegistry |
| compaction policy 与 consumer | `dsh-compaction-basic` / `dsh-command-compact`：base manifest 与 alpha.2 文档 | `src/context/compaction/{CompactionPort,CompactionOrchestrator,NativeCompactionPort}.ts`、`src/agent/session/ManualCompactionController.ts`、`src/gateway/SessionRouter.ts` | Definition、auto orchestration、durable bracket/replacement 与 native `/compact` consumer 已有；剩余为 profile provider selection、cold-resume/retry contract 与 remote/sidecar parity |
| approval/question provider | `dsh-user-approval` / `dsh-user-questions`：base manifest 与 alpha.2 文档 | `src/interaction/InteractionProfile.ts`、`src/permission/PermissionDecisionPort.ts`、`src/tool/elicitation/`、durable interaction adapters | answerer、policy、audit、reconnect 分层；`interactive`/`headless`/`disabled` 已选择 Gateway、deterministic 或 fail-closed provider，Gateway-owned reconnect provider 也已存在；resume extension 已透传 `ownedElicitation`，bridge replay DTO consumer 已完成；最终 profile/bundle provider lifecycle 尚未形成 |
| continuable subagent ownership | `dsh-subagent`：`lib/index.js`、types；`dsh-agent` inbox types | `src/agent/sub/{SubagentProvider,SubagentProviderRegistry,SubagentDescriptor,SubagentContinuationManager,NativeSubagentContinuationHost}.ts`、`src/agent/scope/AgentHandle.ts`、`src/agent/session/{AgentSession,AgentTurnInbox}.ts` | provider 只准备 detached seed；manager 持有 child handle；Agent inbox 是唯一 FIFO。PilotDeck 已补 v2 descriptor、durable enqueue、FIFO/atomic claim、cold inbox restore、wake pump、manager ownership/admission、provider-independent cold-resume core、exact live-parent identity、settlement 和 child-first drain；application child configurator 为每个 nested handle 安装精确 consumer，不得另建 queue |
| profile、bundle、boot rollback | `dsh-app-boot`：`lib`、types；`dsh-base/cordis.patch.yml` | `src/cli/createLocalGateway.ts`、`src/cli/pilotdeck-agent-loop-default-factory.ts` | DSH 的 bundle 是有序 patch composition；PilotDeck 仍是手工 composition root，须最后收敛 |

这些锚点只用于审计和 contract 设计，不要求 PilotDeck 复制 DSH 的包名、Cordis API 或目录层级。

### 1.3 DSH 架构分层核对

DSH 的发布包不是一组彼此平级的 sidecar，而是按 Definition、Provider、Consumer 和 Composition 形成分层依赖：

| 层 | DSH 代表包 | 架构职责 | PilotDeck 对照结论 |
| --- | --- | --- | --- |
| Core identity/lifecycle | `dsh-scope`、`dsh-agent`、`dsh-agent-loop` | scope identity、live agent registry、factory、driver、teardown capability | Agent factory transaction 与 provider co-ownership 已闭环；initiator/event/contribution 尚未统一到同一 scope identity |
| Durable session | `dsh-session`、`dsh-session-persistence-*` | append-only 领域日志、surface、恢复校验、持久化协调、flush checkpoint | event/persistence、durable vocabulary、crash tail 校验、AgentSession projection consumer 和 storage lifecycle 已形成 |
| Derived state | `dsh-session-projection`、`dsh-session-projection-cache`、`dsh-session-query-sqlite` | committed-event fold、一致快照、可丢弃 checkpoint/query index | live driver、默认 codec、checkpoint + tail、原子 store 和 fail-soft 回退已形成；query index 不在当前必需范围 |
| Request assembly | `dsh-system-prompt`、agent instructions、time/tmux context、attachment/spill | scoped contribution、稳定 request snapshot、模型可见上下文 | registry consumer 与 durable context/instruction 已接入；仍是 turn admission、runtime context 仍兼容性留在 system prompt；browser upload 的 durable storage/turn lease 已拆开，通用外部 attachment lifecycle 仍未形成，Spill storage 的 I/O seam 已闭合 |
| Interaction | `dsh-user-approval`、`dsh-user-questions`、permission presets、ask-user tool | policy、answerer、question lifecycle、durable audit 分离 | approval port、permission lifecycle audit、scope-owned elicitation channel、durable question audit、Gateway/headless/disabled profile composition、exact-binding reconnect、stale-reply rejection 和 bridge dialog replay 已有；最终 profile/bundle registry 仍是 composition 缺口 |
| Execution | `dsh-tools`、fs/subprocess/sandbox/shell/jobs/web/MCP/skill providers | tool schema/execution aggregate 与底层执行能力分离 | ToolPort 已有；底层 execution world 仍由 builtin/runtime 直接组合 |
| Context reduction | `dsh-compaction-basic`、tool-result pruner、compact command | compaction policy、durable bracket、surface replacement、summarizer provider 分离 | PilotDeck 已抽出 port/orchestrator，完成 durable bracket/replacement transaction 和 native command consumer；profile provider selection、cold-resume/retry contract 与 remote/sidecar parity 仍未形成完整 seam |
| Delegation/orchestration | `dsh-subagent`、in-process/remote providers、subagent tools、workflow/goal/schedule | named provider、one-shot/continuable child、tool consumer 和 ownership 分离 | one-shot native provider、continuable preparation、v2 durable descriptor、Agent-owned 跨 turn inbox、live continuation ownership/admission manager、cold-resume core、exact live-parent identity、settlement、child-first graph 和 local nested Gateway wiring 已建立；Gateway continuable sidecar 的 live/cold follow-up 与 parent-close 已对拍，remote provider、one-shot、abort 和 late-terminal parity 仍缺 |
| Application composition | `dsh-app-boot`、`dsh-base`、profile bundles/patches | 有序装配、profile override、启动失败回滚、卸载 | 仍由 CLI/default factory 手工装配，是最后收敛项 |

这个分层说明了两个不能混淆的概念：一是“能力族”不等于“一个协议端点”；二是“已有 Port”不等于整个能力族已完成
模块化。PilotDeck 应复用 DSH 的 ownership 和 state discipline，但不需要复制其 package 数量、Cordis API 或部署形态。

### 1.4 DSH 全量能力族的范围处理

DSH workspace 还包含 settings、credentials、storage、workspace、identity、feedback、todo、guard、UI/client、SDK/API、
runtime diagnostics 和 test-support 等能力族。它们已经纳入范围核对，但不应全部转化为本 roadmap 的 AgentLoop 模块化
工作包：

- settings、credentials、storage、workspace 属于应用基础设施；只有当 Agent runtime 直接依赖其具体实现时，才需要抽取
  runtime-facing port；
- feedback、todo、goal、plan、schedule、jobs、workflow 属于可选业务 capability，应在 scope/registration 基础稳定后
  按实际复用和替换需求逐个 provider 化；
- UI/client、API/SDK、ACP 和 host 属于 application/transport consumer，不是 core seam 的 owner；
- diagnostics、invariants 和 test-support 是横切验证设施，应消费稳定 Definition，不进入业务 dependency bag；
- code-runtime、terminal、webhook、remote subagent 等只有在 PilotDeck 出现对应部署需求时才进入后续工作包，不为追求
  DSH package 对称而预建空模块。

因此，本 roadmap 的“未模块化”仅表示 PilotDeck 当前核心调用链中仍存在 ownership、state、lifecycle 或 composition
缺口，不表示必须为 DSH 的每个发布包建立一一对应目录。

### 1.5 复核后需要显式保留的差异

本节把 alpha.2 发布契约与本机 rc.8 源码中仍可见的设计方向分开使用。尤其是 `preStep()` 等未随 alpha.2
产物下载的 agent-loop 内部细节，只是目标语义参考，不能写成 alpha.2 的精确源码事实。后续实现必须避免三个表面相似、
实际语义不同的映射：

1. **Prompt snapshot 边界**：DSH 在每次 `preStep()` 中调用 `systemPrompt.assemble()`，组装结果在该 step 的
   provider retry 循环内保持稳定；下一 step 会重新组装。PilotDeck 的 durable context adapter 已向
   `ContextPrepareInput` 注入 admission `stepId`，且 native provider retry 的真实调用路径已验证：请求在 retry 前
   一次性组装，registry 在第一次 provider attempt 后更新也只能影响下一次 request。由于本分支不修改
   `AgentLoop.ts`，它仍没有与 DSH `preStep()` 等价的公开 admission hook；host/remote provider 的 retry 也必须
   各自服从同一 prepared-request contract，不能据此宣称完整 step-stable 模块已经完成。
2. **System prompt 与 durable context**：DSH `dsh-system-prompt` 同时管理 system section、variable、tool schema view
   和 runtime context provider；其中 runtime context 会在 step admission 时物化为 durable user-role snapshot。
   `dsh-agent-instructions` 的 baseline/change 也进入 Session log，而不是每次请求临时读取后只拼进 system prompt。
   PilotDeck 后续必须把“稳定 system section”和“需要留痕的动态上下文/指令”分开建模。
3. **Tool schema 真源**：DSH 的 tool provider 参与 request assembly，但 PilotDeck 已有 `ToolRegistry` 作为工具定义真源。
   WP10 只能增加从 scoped ToolRegistry 到 request assembly 的只读 snapshot adapter、排序和限制视图，不能建立第二套
   可独立注册的 tool definition registry。

此外，DSH agent-scoped contribution 依赖 create/resume 的 unpublished setup transaction。PilotDeck 已先实现 registry
primitive，并在 WP10B 补齐 Agent factory 的原子发布、失败回滚和 provider co-ownership；WP10C 已接入真实 consumer 和
durable context/instruction 基础链路，但在 runtime context 改为 durable user-role surface、request admission 暴露稳定
`stepId`、contribution owner 与 Agent scope 统一之前，仍不能标记为完整模块化。

## 2. 执行结论

PilotDeck 已完成的主体是 AgentLoop 调用边界和跨进程 adapter：

- LLM：`ModelInvokerPort`、Router native adapter、host model consumer；
- Capability：`ToolPort`、ToolScheduler native adapter、host capability consumer；
- Context：`AgentContextRuntime` 与 host context consumer；
- Interaction：`PermissionDecisionPort` 与 host permission consumer；
- Checkpoint：`AgentLoopSeedState` 的受控读投影；
- Transport：Module Protocol v2、进程内 runtime、NDJSON sidecar；
- Session foundation：`SessionRuntime` committed stream、JSONL/InMemory provider、Transcript compatibility
  facade、实时 `SessionProjectionDriver` 和内置 projection registry；
- Prompt/context foundation：scoped section/variable/runtime-context registration、严格变量渲染、generation snapshot、
  ToolRegistry 只读 schema adapter，以及 `context_snapshot`/`agent_instructions` durable facts；
- Agent publication：`AgentFactoryProvider` 在 unpublished handle 上完成异步 setup，再同步提交到
  `AgentRegistry`；create/resume/recreate 失败会等待 owned resource rollback，provider unload 会排空全部 handle。

这些工作已经建立了可替换调用 Port，但还不是完整的 DSH 风格模块体系。主要缺口是：

- `AgentRuntimeDependencies` 仍承担大型 service locator；
- `createAgentSession` 仍集中创建和连接 runtime；publication transaction 已独立，但具体 runtime/provider 选择仍集中；
  `SubAgentSession` 已使用 child scope，但具体 provider/loop 创建仍集中；
- ToolPort 把 fs、shell、subprocess、sandbox、web、jobs、subagent 等执行能力压成一个聚合接口；
- Transcript 已是 typed JSONL 并支持 replay，`SessionRuntime` 已拥有序号、JSON materialization 和提交事件流；
  `SessionPersistence` backend 及 required subscriber 已独立，AgentSession durable state 已改读 live projection；
- Transcript 已记录 accepted input、durable message、turn/step 边界、最终 model request、canonical stream、tool
  call/result、inbox mutation、turn result、metadata 和 sidechain reference；默认 AgentSession/Web consumer 已消费核心
  projection，剩余缺口是清理无 projection provider 时的 legacy fallback，以及补齐尚未纳入 projection 的边缘 read model；
- `SessionProjectionDriver` 已支持 committed-event 增量 cell、一致性 `asOfSequence` 快照、变更通知、动态注册
  和版本化 checkpoint codec；AgentSession 与 Web incomplete-turn consumer 已接入；默认 projection codec、精确日志
  anchor、JSON/InMemory store、checkpoint + tail restore、turn-end 和 dispose flush 已形成闭环；
- `ScopedServiceRegistry` 已提供 service lease、replacement 和 drain/dispose，Agent factory 已补发布前 setup transaction
  和失败回滚；`AgentScopeLiveEventBus` 已补 exact/ancestor-only 的 volatile event routing；尚缺 DSH 式通用 scoped contribution
  layer，不能把现有 prompt/tool/hook 的具体 owner 泛化为第二个 registry；
- prompt registry 已接入 `DefaultContextRuntime`，dynamic context/instructions 会在 `model_request` 前持久化；但 runtime
  context 仍兼容性拼入 system prompt，snapshot 仍是 turn admission 而不是 DSH 的 step-stable admission；
  user questions 已有 channel lifecycle、durable audit、统一 interaction policy/deadline 与 reconnect contract；
  `interactive`/`headless`/`disabled` profile 已进入 local Gateway composition，resume 时 channel owner 也会完整透传；
  browser dialog 已从 replay DTO 恢复显示，并通过 terminal snapshot 收敛断线 turn；LLM policy、telemetry 和 hooks
  仍未形成完整独立 seam；
- profile/bundle/boot 组合仍散落在 CLI factory 和手工 `new` 中。

因此迁移顺序应为：

```text
Session Event/Projection foundation
        -> Agent Scope/Ownership
        -> Session source-of-truth closure
        -> Agent publication transaction
        -> Subagent inbox / continuation ownership
        -> Prompt Registry
        -> Durable Request Context / Instructions
        -> Compaction
        -> Interaction
        -> Execution World
        -> LLM Policy
        -> Lifecycle/Telemetry/Extension
        -> Profile/Bundle Composition
        -> Optional Transport Projection
```

不应先按工具目录数量拆几十个 sidecar，也不应先引入全局 DI 容器。

## 3. 模块化判定标准

一个目录、类或接口只有同时满足下列条件，才记为“完成模块化”；仅移动文件或增加 wrapper 不算完成。

| 维度 | 必需证据 |
| --- | --- |
| Definition | 有稳定、最小、宿主无关的契约；不泄漏具体 runtime、registry 或 transport 类型 |
| Provider | 至少一个 native provider；provider 明确拥有的资源、scope 和 dispose 行为 |
| Consumer | 核心调用方只依赖 Definition，不直接 `new` 或读取 provider 内部状态 |
| Composition | provider 的选择发生在 profile/bundle/composition root，不发生在业务循环内部 |
| Lifecycle | 注册返回可撤销 handle；替换或卸载可阻止新调用并等待在途调用 drain |
| State | durable state 的 owner、事件写入点、projection 和恢复语义明确 |
| Testability | contract test 可复用于 native/host provider；有 replacement、dispose、replay 测试 |
| Transport | 仅在确有跨语言、隔离或部署收益时增加；transport 不能拥有第二套业务状态 |

成熟度标记：

- `M0`：目录或具体实现，没有稳定 seam；
- `M1`：有接口或 registry，但 consumer 仍绑定具体实现/集中 wiring；
- `M2`：Definition/Provider/Consumer 已分离，可注入和 contract test；
- `M3`：具备 scoped registration、replacement、drain/dispose；
- `M4`：具备 profile/bundle 组合，并按需提供可靠 transport projection。

## 4. DSH 与 PilotDeck 对照矩阵

| DSH 能力 seam | PilotDeck 当前实现 | 成熟度 | 关键差距 | 目标形态 | 跨进程 |
| --- | --- | ---: | --- | --- | --- |
| `core/agent-loop` | `AgentLoop` + `ModelInvokerPort` + `ToolPort` | M1-M2 | Model/Tool 调用边界已到 M2，但 loop 仍读取宽依赖对象并直接创建 `SubAgentSession`；turn-scoped capability view 未形成 | AgentLoop 只消费 turn-scoped capability view，subagent tool 通过稳定 consumer seam 调用 manager/provider | 已有，保留 |
| `core/agent` | `AgentSession` + `AgentRegistry/AgentHandle` + `AgentFactoryProvider` + `SessionRouter` | M3 | unpublished async setup、同步 publish、create/resume/recreate rollback 和 provider co-ownership 已闭合；runtime 构造内容仍集中，尚未进入 profile/bundle | registry factory 创建完整 scoped agent，handle 只暴露给 owner，provider unload 可停止并排空其全部 agent | 默认否 |
| `core/session` | `AgentSession`、`TurnRunner`、`SessionRuntime` | M1-M2 | durable vocabulary、领域校验和默认 AgentSession projection consumption 已闭合；legacy state 仍作为无 projection provider 的兼容 fallback | `SessionRuntime` 拥有完整 durable event log，所有默认 runtime durable 派生状态只读 projection | 默认否 |
| `session-projection` | `SessionProjectionDefinition/Registry/Driver`、内置 Transcript/subagent/Web/file-history projections | M2 | committed event 已增量驱动 cell，并提供一致 snapshot/change feed/default codec；checkpoint store、恢复、flush 和失效回退已接通，尚未进入 profile/bundle 组合层 | 所有 durable 派生状态由已提交事件增量驱动，并可从日志/检查点重建 | 默认否 |
| `session-persistence` | `SessionPersistence` + JSONL/InMemory providers + required runtime binding | M2 | runtime 与 backend 已分层；尚缺 create/list、write-behind checkpoint 和更多 crash repair 语义 | `SessionPersistence` 只负责 create/append/load/flush/list，Session core 负责事件语义 | 可选 |
| `checkpoint/seed-state` | `AgentLoopSeedState` parser/projection | M1 | 仅验证 host-safe 初始文件状态；没有独立 owner、日志或生命周期 | 作为 Session projection 的兼容输入，最终由 durable state 重建 | 已有 host 输入 |
| `transport/module-protocol` | Module Protocol v2、in-process runtime、NDJSON sidecar、sidecar ports | M2 | transport 已独立，但还缺跨 provider 的统一 lifecycle/negotiation 复用 | 保持为可选 adapter，不承载业务状态 | 已有 |
| `core/scope` | `ScopedServiceRegistry` + `AgentRuntimeScope` + ToolRegistry scoped view + session-owned PromptContributionRegistry + `AgentScopeLiveEventBus` | M2 | service inheritance/override/teardown、显式 blocked token、prompt registry ownership 和 exact/ancestor-only live event routing 已接入 main/subagent；通用 contribution layer 仍未形成，不能把既有 prompt/tool/hook owner 伪装为统一 registry | `SessionScope`/`AgentScope` 同时决定 service、contribution、event visibility 和 teardown owner | 否 |
| `core/context-runtime` | `AgentContextRuntime`、Default/Null provider、host consumer | M2 | 聚合接口过宽，内部 contribution 与 policy 尚未分离 | 保留聚合 consumer port，内部由独立 contribution/policy seam 组合 | 已有 host consumer |
| `core/system-prompt` | `PromptContributionRegistry`、ContextRuntime、prompt/instructions/extension resolver、`context_snapshot`/`agent_instructions` | M2 | consumer、严格变量渲染、ToolRegistry snapshot、durable facts、agent profile surface 和 frozen extension snapshot 已接通；生产 composition 已默认选择 `user_message`，直接 `DefaultContextRuntime` 仍保留 `system_prompt` 兼容默认；native 与 host model adapter 均在 prepare 边界固定 canonical request snapshot；仍缺真实 remote bridge retry 对拍，以及 DSH `preStep()` 等价的独立 admission hook | section/variable registry + ToolRegistry snapshot adapter；动态 context/instructions 进入 Session log 和模型历史 surface | 可选 |
| `context/compaction` | `CompactionPort` + `CompactionOrchestrator` + native adapter + `ManualCompactionController` | M2 | stage Definition、provider orchestration 和 Context consumer 已统一；native `/compact` 由 session-owned controller、idle maintenance admission 和 Router reservation 投影，Gateway 不拥有第二状态；replacement surface 已可与 boundary 单事件提交，失败写入 `compaction_failed`。仍缺 profile provider selection、cold-resume/retry contract、remote/sidecar parity 与跨部署 provider replacement/drain 证据 | CompactionPort + profile-selected policy/provider + durable replacement transaction | 默认否 |
| `interaction/user-approval` | `InteractionProfile`、`ProfiledPermissionDecisionPort`、PermissionRuntime、session-owned permission audit adapter、`GatewayPermissionBus`/hook、bridge replay consumer | M2 | `interactive` profile 保留 Gateway ask；`headless`/`disabled` 只将底层 `ask` fail-close，不改 allow/deny/cancel；duplicate、late answer、abort、timeout、reconnect 和 stale reply 已有 contract。bridge 已以真实 WS 覆盖旧 binding 重连、permission DTO 重放、旧答复拒绝、当前答复、后续 model/tool 与 terminal frame；最终 profile/bundle registry 留待 P6 | session-scoped approval provider | 已有 host consumer |
| `interaction/user-questions` | `InteractionProfile`、`PilotDeckElicitationChannel`、`GatewayElicitationChannel`、session-owned durable elicitation adapter、`ask_user_question` 工具、bridge replay consumer | M2 | profile 已选择 Gateway、deterministic 或 disabled question provider；Gateway/headless channel 都有 stop-new、pending reject、drain/dispose，child scope 屏蔽 channel，question lifecycle durable audit 已有。`ResumeSessionDependencyExtension` 已接受/合并 `ownedElicitation`，resumed handle dispose 会释放 owned channel；bridge 已以真实 WS 覆盖 question replay、当前 binding answer、后续 model/tool 与 terminal frame；最终 profile/bundle registry 留待 P6 | `UserQuestionPort`，由 scope policy 决定可用性；pending request 由 owner drain/cancel | 可选 |
| `core/tools` | ToolRegistry、ToolRuntime、ToolScheduler、ToolPort | M1-M2 | ToolPort 调用边界为 M2，ToolRegistry 已有 scoped view、exact registration handle 和 local registry dispose；extension tool 已在 availability preflight 后直接注册到最终 session-owned registry，不形成第二套 schema 真源；底层执行世界仍耦合 | 保留 ToolPort；registry contribution 保持 session-owned，底层能力另设 seam | 已有 host consumer |
| `fs/subprocess/sandbox/shell` | `FsPort`/`SubprocessPort`/`ShellPort`/`DetachedShellPort`/`SandboxPort` + builtin consumers 与本地执行实现 | M1-M2（Fs/Subprocess/Shell/Sandbox 与 UI terminal lifecycle 首段） | `FsPort` 已覆盖 `stat`、binary/text read、line-range read、text write、`readDirectory`，并由 project composition root 选择 Node provider；`SandboxedFsPort` 在 `read-only` 拒绝 mutation，在 `workspace-write` 以 consumer 提供的授权 root 对 fresh canonical target 做 containment（含 symlink 祖先），是 trusted-process fence 而非执行不可信代码的 kernel sandbox。`read_file`、`write_file`、`edit_file`、`edit_notebook` 和 `walkFiles` 是注入式 Consumer，保留路径安全、媒体解析、去重、snapshot/stale-write、忽略目录、排序和取消语义；`SubprocessPort` 已提供 shell/direct-executable 两条本地路径；`ShellPort` 现已成为 `bash` 的首选窄 Definition，`DetachedShellPort` 已承接 `task_*` 的后台进程启动/终止；macOS Node provider 已用 Seatbelt 对 `execute_code`、前台 `bash` 和 detached `task_*` 的 exact argv 实施 `read-only`/`workspace-write`，并由 `agent.sandboxMode` 经 bundle 组合。UI `TerminalSessionRegistry` 已唯一拥有 PTY/sessionKey/socket/buffer/timeout，handler 仅消费其 reconnect、I/O、exit/detach API，old PTY/socket 不能影响 replacement，server shutdown 会 dispose remaining PTY；浏览器 consumer 只允许 `wsRef.current` 对应的 socket init、message、close/error 改变 view state。受限 RPC 移除宿主侧 `bash`/`write_file`/`edit_file` 以避免绕过；Linux/Windows process provider、Agent terminal tool Definition 与 task reconnect 仍待后续边界收敛 | 完整 `FsPort`（含目录、attachment 读写能力）、`SubprocessPort`、跨平台 `SandboxPort`、`ShellPort`/`DetachedShellPort`/terminal tool provider | 按需 |
| `attachment/spill` | AttachmentResolver、FileArtifact、ToolResultBudget、`send_attachment`、`UploadStore` artifact lease | Attachment reader/delivery M2；browser upload durable storage M2；Spill storage M2 | `AttachmentPort` 已将源文件读取从模型投影中分离，`AttachmentDeliveryPort` 也已将 `send_attachment` 的 post-policy realpath/metadata inspection 分离，local Gateway 显式选择 Node provider；browser upload 的 `UploadStore` 继续拥有 project authorization/completion/hash/source artifact/retention，Gateway turn 只消费 disk-backed hard-link lease，正常 terminal release 或 TTL cleanup 均不依赖 UI/Gateway 进程内共享状态。`ToolResultSpillPort` 已将独占写入/copy I/O 从 budget policy 抽离，且由 `ProjectRuntimeRegistry` composition root 选择 Node provider；fake-provider contract 覆盖大文本、别名冲突、媒体和失败诊断。Session artifact retention/query 与通用外部 attachment lifecycle 仍未形成独立能力 | attachment/spill definition + storage provider + model/tool consumers | 按需 |
| `llm/llm` | Router、provider、ModelInvokerPort | M2 | provider 调用与 route/materialize/policy 边界仍有交叉 | provider invocation 与 routing policy 分离 | 已有 host consumer |
| `llm-retry/token-meter` | `RouterRetryPolicy`、`RouterUsageObserver`、`RouterTokenMeter`、model `RetryPolicy` | M2（Retry/Usage/Token 首段） | transient/zero-usage retry admission 与 backoff 已从 `RouterRuntime` 的配置读取逻辑中抽出为 `RouterRetryPolicy` Definition/Native Provider；session usage cache、request accounting、stats flush/dispose 已抽出为 `RouterUsageObserver`；输入/输出 token 估算已由 `RouterTokenMeter` Definition/Native Provider 提供，subagent budget 与成功/失败 usage fallback 均通过注入 seam；routing/fallback/cache 仍在 RouterRuntime | RouterRetryPolicy、RouterUsageObserver、RetryPolicy、TokenMeter seam | 默认否 |
| `subagent` | `SubagentProvider` + native provider + `AgentRuntimeScope` policy + `AgentTurnInbox` + `SubagentContinuationManager` + `NativeSubagentContinuationHost` | M3（R0.3 native closure） | named provider、generation lifecycle、v1 one-shot/v2 continuable descriptor、detached preparation、durable FIFO、live child handle ownership/admission、provider-independent cold-resume core、exact live-parent identity、parent-owned JSONL、settlement、child-first graph、final-disposal race 及 Gateway nested consumer 已接入；Gateway continuable sidecar 已通过 live/cold follow-up 与 parent-close，仍缺 one-shot、abort、late terminal 和 remote/queued provider parity | child AgentScope + 可替换 subagent provider + continuation manager/AgentHandle + 唯一 inbox owner | 可选 |
| `jobs/task` | `BackgroundTaskPort` + `BackgroundTaskRuntime` + `task_*` builtin + `ExecutionWorldBundle` | M2（native task control + owner fence） | Definition、native provider、工具 consumer、registry composition 和 bundle-owned drain 已闭环。model-facing `list/get/getOutput/wait/stop` 以 exact `sessionId` 访问，跨 session 的 task 如同 unknown；rejected detached exit 结算为 `failed` 并照常释放等待者/发 completion，accepted spill writes 在 dispose 前串行 drain。没有 DSH 的 owner-scoped completion inbox/wakeup、durable job state 或 reconnect | 保留 port/provider 分离；completion consumer、reconnect 和 durable job record 必须另立业务语义工作包 | 通常否 |
| `schedule/cron` | `CronControlPort` + `CronAgentGatewayPort` + `CronManager`/`CronRuntime` + scheduler/store + six `cron_*` tools | M2（schedule control seam） | Gateway 与 tools 共享 provider-neutral control port；cron fire/runtime/manager 只消费 submit/abort/close facade，native provider 仍独占 project runtime、scheduler/store、active-run 与 stop。`cron_update`/`cron_run_now` 已从既有 RPC 接入 agent tool registry。DSH `schedule` 是 root-agent/session-event-scoped reminder；PilotDeck 当前 cron 是 project-owned scheduler，故不能标记为 durable schedule parity。跨部署 provider、profile selection 与 schedule ownership/reload contract 仍待定义 | 控制 port + project-owned native scheduler/provider + narrow turn facade + profile-selected transport consumer；只有明确产品需求时才另立 session-scoped durable reminder | 可选 |
| `plan/todo` | `PlanTodoPort` + `NativePlanTodoRuntime` + `plan-todo.state` projection + `todo_write`/plan mode/ToolRuntime consumers | M2（native durable capability） | Definition、session-bound native provider、三个 consumer 和 local Gateway composition 已闭环；approved plan、whole-list todo write、side-effect progress 与诊断均从 committed session event 投影恢复，生产路径不再以 `Map<sessionId, ...>` 为真源。旧 `PlanTodoState` 只保留为无 projection composition 的兼容 adapter。DSH 默认在下一 turn/start 清空 todo，而 PilotDeck 为已批准计划保留跨 turn checklist 与诊断，属于刻意的产品语义差异；profile/bundle provider selection 和跨部署 parity 仍待后续收敛 | 保持 session event/projection 为唯一状态；AgentLoop 继续只消费既有 handle，provider 选择与 session composition 日后纳入 profile/bundle | 通常否 |
| `always-on` | `AlwaysOnControlPort` + `AlwaysOnAgentGatewayPort` + `AlwaysOnRuntime`/`AlwaysOnManager` + scheduler/store/workspace providers | M2（native control seam） | Definition、native provider、Gateway RPC consumer 与 CLI composition 已闭环。`DiscoveryFire`/runtime/manager/standalone apply 只消费 submit/abort/close facade；Gateway 不再保存 operation callback，而是委托 control port。`abortRun` 只接受既有 `always-on:turn-event` 提供的 session key，native provider 以 active run context 或仍在执行的 control run 验证 project ownership 后才调用普通 turn abort；`aborted` 仅表示 abort 请求被 Gateway 接收，不宣称业务 terminal 成功。runtime stop 会 stop-new 并等待 scheduler tick 和已接纳 apply/rerun 的 terminal cleanup；state、workspace、lease 仍由 project provider 持有。profile/bundle selection 与 remote/sidecar E2E parity 仍未完成，不能标为完整 workflow/schedule 对等 | project-scoped orchestration provider；保持窄 turn facade、control consumer 与 store/workspace owner 分离，ProjectRuntime/profile 日后持有 provider selection/start/stop/reload | 可选 |
| `workflow/goal` | 没有通用业务 runtime；只有 subagent、cron 与 always-on 的专用调用链 | M0 | 尚未有可复用的 run handle、owner、durable vocabulary、cancel/settlement 或明确产品 caller；不能为追求 DSH 包对称预建 workflow/goal registry | 先完成业务合同；若确有多 agent 编排需求，按 `WorkflowEngine` 的 live handle、owner cleanup、typed lifecycle 和 child ownership 单独实现 | 按需 |
| `mcp/runtime` | `McpRuntimePort` + native runtime + Project/Session MCP owner + MCP-to-tool bridge | M2（runtime call seam） | bridge 与 composition 已只消费 port/factory，shared/per-session runtime 仍由既有 ProjectRuntime/SessionMcpRuntimeRegistry 拥有；`GatewaySessionResourceLeaseBundle` 已使 session preparation、session dispose 和早期失败共用 `per-session MCP -> plugin contribution -> project runtime` 的反向释放顺序。plugin reload、LSP 与通用 non-Agent provider lifecycle 未闭环 | provider-neutral runtime Definition + existing exact owner/lease + profile-selected provider | 按需 |
| `web/lsp/skills` | web、LSP、extension skills 等 runtime | M1 | contribution 和 execution ownership 分散 | provider registration + scope policy | 按需 |
| `hooks` | HookRuntime、LifecycleRuntime、CommandHookExecutor + ShellPort consumer | M1-M2 | callback/async registry 已有 generation、stop-new、drain、dispose；command hook 已通过共享 `ShellPort` 注入 stdin、timeout、abort 与结果解析；frozen plugin hook contribution 已随 session-owned lifecycle 建立，async hook 已有显式 complete/cancel 与 late completion rejection；scope live carrier 已可投影 hook transition，仍缺业务级 pending hook 的 durable resume/cancel contract | lifecycle subscriber registry + disposable effect + execution-world provider | 默认否 |
| `session-telemetry` | telemetry 与 Agent events | M1 | live/durable/telemetry event 边界未完全固化 | typed observer seam，不反向控制 session state | 可选 |
| `extensions` | PluginRuntime、PluginRegistry、ExtensionResolver | M1-M2 | refresh 已发布 generation-aware replacement，并对 removed plugin 执行异步 dispose；Agent-scoped prompt/tool/hook contribution 已以冻结 snapshot、session-owned registry 和 lifecycle 组合；telemetry、command、MCP/LSP 等非 Agent-scoped provider 尚未形成统一的 generation/reload consumer | contribution handles + generation + drain/dispose + scope binding | 否 |
| `bundle/boot/profile` | CLI、`PilotDeckRuntimeProfile`、`ProjectAutomationBundle`、`ProjectRuntimeResourcesBundle`、`LocalGatewayLifecycleBundle`、`PilotDeckServerShutdownBundle`、`ChannelAdapterBundle`、`ChannelLifecyclePort`、`createLocalGateway`、default factory | native M2；跨部署 profile/boot M1 | Always-On/Cron 已从 CLI 手工生命周期收敛为 bundle；每个 ProjectRuntime generation 的 model provider、plugin runtime、router、execution world、MCP provider 与 memory service 也已由 resource bundle stage/dispose，保持 partial-build cleanup、MCP-before-plugin release 和 idempotent disposal。R5.32 已以不可变 runtime profile 统一 sandbox、runtime-context surface 与 interaction selection。Gateway application 的 watcher、Gateway admission、subagent manager/provider、SessionRouter、per-session MCP、runtime invalidation 与 telemetry observer/base shutdown 也已有唯一 lifecycle owner；CLI server 的 channel adapter config mapping、exact handle replace/remove/rollback、late-start cleanup 和 automation -> server/channel -> mapper flush -> Gateway -> telemetry shutdown chain 均已有 native owner。其余 composition root 仍过大，完整 deployment profile 与全应用 boot rollback 未形成 | declarative profile/bundle 装配 | 否 |
| API/client/host | Gateway、WebSocket、channel adapters | M1-M2 | 不应与进程内 seam 同步重构 | 只消费稳定 session/application facade | 已存在 |

### 4.1 当前已经形成的模块

当前已经形成的是第一批“调用边界或基础设施模块”，可作为后续 Definition/Provider/Consumer 模板；它们不等于
DSH 对应子系统已经完整闭环：

```text
llm/          ModelInvokerPort + router adapter + host consumer
capability/   ToolPort + scheduler adapter + host consumer
context/      AgentContextRuntime host consumer
permission/   PermissionDecisionPort host consumer
checkpoint/   AgentLoopSeedState projection
transport/    module runtime + sidecar server + sidecar ports
session/      SessionRuntime + Persistence providers + Projection Registry/Driver/providers
scope/        typed token + AgentRuntimeScope + parent/child service ownership
agent/        AgentRegistry + AgentHandle + AgentFactoryProvider + SessionRouter publication/lifecycle ownership
subagent/     SubagentProvider + native adapter + child scope + durable turn inbox + live continuation handle manager
prompt/       scoped contribution registry + strict rendering + Context consumer + durable context/instruction facts
interaction/  shared outcome/deadline Definition + permission/question channel adapters + durable lifecycle audit
compaction/   CompactionPort + native adapter + CompactionOrchestrator auto consumer
execution-world/ FsPort + SubprocessPort + ShellPort + DetachedShellPort + Node native providers + read_file/bash/task consumers
mcp/runtime  McpRuntimePort + native provider + MCP-to-tool bridge + existing Project/Session owners
jobs/task    BackgroundTaskPort + native runtime + task_* consumers + live completion projection
schedule/cron CronControlPort + CronManager/Runtime + scheduler/store + cron_* consumers
model/policy/ RetryPolicy Definition + native request/stream retry provider
router/policy/ RouterRetryPolicy Definition + native router retry provider
router/policy/ RouterRequestMaterializer Definition + native request materializer
router/policy/ RouterCachePolicy Definition + native cache-aware routing provider
router/usage/ RouterUsageObserver Definition + native cache/stats provider
router/fallback/ RouterFallbackPolicy Definition + native config-driven fallback provider
router/provider/ RouterModelInvocationPort Definition + native ModelRuntime adapter
router/policy/ RouterOrchestrationPolicy Definition + native orchestration admission provider
```

其中 `llm`、`capability`、`context-runtime`、`permission`、`interaction`、`execution-world/FsPort`、`execution-world/SubprocessPort`、`execution-world/ShellPort`、`mcp/runtime`、`jobs/task`、`schedule/cron`、`RouterRetryPolicy`、`RouterRequestMaterializer`、`RouterCachePolicy`、`RouterUsageObserver`、`RouterTokenMeter`、`RouterFallbackPolicy`、`RouterModelInvocationPort`、`RouterOrchestrationPolicy` 和
`model/policy/RetryPolicy` 已达到调用边界层面的 M2；其中 Execution World、RetryPolicy、RouterRetryPolicy、RouterRequestMaterializer、RouterCachePolicy、RouterTokenMeter、RouterFallbackPolicy 和 RouterModelInvocationPort 仍只是能力族首段；`checkpoint`
当前主要是 host-safe seed state 投影，尚不是独立状态 owner。Session committed event、persistence backend
和主动 projection driver 作为基础设施已形成 M2，但 core Session 只到 M1-M2。Scope service primitive 具备
parent/child、override、generation、stop-new、drain 和 dispose；`AgentRuntimeScope` 已让 subagent 继承
router/context/permission 并拥有 child ToolRegistry/ToolRuntime/scheduler，ToolRegistry scoped view 动态委托 parent，
不再复制 definitions。它尚未覆盖通用 contribution/event ownership，因此 `core/scope` 仍只到 M1-M2。
AgentRegistry/AgentHandle 已接管 Gateway session 的 close/recreate/shutdown 生命周期；`AgentFactoryProvider` 已补
unpublished setup、同步 publish、失败 rollback 和 provider unload drain，`core/agent` 达到本阶段 M3。与 DSH 的完整
profile composition 与通用 contribution scope 仍有明确距离；scope-filtered live event routing 已具备 native M2 基础。`transport` 已经是独立模块，
但它不能作为其他能力完成模块化的替代证据。Prompt registry 已完成 parent/child shadow、exact-handle 撤销、共享
generation、严格变量渲染、调用时 snapshot 和 ToolRegistry schema copy；`DefaultContextRuntime` 与 host context 已携带
structured materialization，session recorder 在 model dispatch 前写入 context/instruction fact，因此 system-prompt seam
达到 M2。Agent-scoped plugin prompt/tool/hook 已通过同一 frozen extension generation、session-owned registry 和
lifecycle 组合完成；system-prompt seam 尚未达到 M3，是因为默认 profile rollout、host/remote retry parity 与独立
step admission hook 尚无完整证据。

用执行状态归类，当前可以概括为：

- 已形成 M2 调用/基础设施边界：LLM、Tool aggregate、Context aggregate、Permission、Interaction 基础、Transport、
  Session Persistence、Session Projection、Subprocess/Shell foreground/DetachedShell 首段、jobs/task、schedule/cron、RetryPolicy 首段、Router
  retry/usage/token/fallback/materialize/cache 首段；
- 已形成 M3 生命周期边界：Agent publication/lifecycle；
- 部分模块化：AgentLoop、core Session、Scope、ToolRegistry、Checkpoint、Subagent、Prompt/Context integration、
  Compaction、Interaction、Execution World、LLM Policy；
- 尚未形成完整 seam：Subagent remote/queued provider 与 sidecar parity、Prompt 默认 profile/host parity 与独立 admission hook、
  Compaction profile selection/cold-resume-retry/remote parity、Interaction 最终 profile-bundle registry、Execution World 的
  跨平台 process enforcing Sandbox 与 Agent terminal tool、LLM runtime provider registry/health lifecycle 与更细粒度 orchestration policy、非 Agent-scoped Extension provider、
  Orchestration providers、Profile/Bundle/Boot。

### 4.2 尚未完成模块化的主体

按架构阻塞程度排序：

1. Subagent lifecycle closure：one-shot、continuable preparation、v2 durable descriptor、Agent-owned 跨 turn FIFO、live manager ownership/admission、cold-resume core、exact live-parent identity、settlement、child-first graph、final-disposal race 和本地 Gateway nested host/tool wiring 已完成；下一步仅按部署需求处理 remote/queued provider 与 sidecar parity；
2. Prompt/Context 收尾：默认 profile 的 runtime-context user-role rollout、host/remote provider retry parity，以及 DSH
   `preStep()` 等价的独立 admission hook；
3. Compaction profile provider selection、cold-resume/retry contract 与 remote/sidecar parity；native command consumer、manual force、surface replacement transaction 已完成；
4. User questions/approval 的最终 profile/bundle contract（共享 policy、deadline provider、fail-closed、permission/question lifecycle audit、Gateway reconnect 与 bridge replay 已接入）；
5. fs/subprocess/sandbox/shell/attachment/spill 执行世界（FsPort 读写、Subprocess、Shell foreground、DetachedShell、browser upload artifact lease 与 Spill storage seam 已完成首段；Node `SandboxedFsPort` 已覆盖直接文件 mutation，macOS sandbox 已覆盖 `execute_code`、foreground/detached shell；跨平台 process sandbox、Agent terminal tool/task reconnect 和通用外部 attachment lifecycle 待拆）；
6. retry/token accounting/router policy（RetryPolicy 首段已完成）；
7. lifecycle/hooks/telemetry/extensions 的非 Agent-scoped provider registration；
8. jobs/task、schedule/cron、plan/todo、always-on、workflow/goal、web、LSP、MCP、skills 等可选 orchestration/capability 的
   provider 化；其中 `jobs/task` 的最小 task-control port、`schedule/cron` 的 control port 与 `plan/todo` 的 session durable
   capability 已完成。前者仍不是 durable owner-scoped job，后者也不是 DSH agent/session-scoped schedule；`plan/todo` 的
   production composition 已从进程内 session map 收敛至 event/projection。`always-on` 应保持 project-scoped；`workflow/goal`
   在没有业务 caller 前只做设计 gate，不能预建 registry；
9. profile/bundle/boot composition。

以上是按架构缺口排序。child scope、Session 真源闭环和 Agent publication transaction 已完成；SubprocessPort 与
RetryPolicy 只是首段，不能把整个 Execution World 或 LLM Policy 标记为完成。实现依赖仍须保持
`Subagent continuation ownership -> 10C-C contribution lifecycle（已完成基座） -> 默认 profile/host retry parity -> 11/12
-> 13/14 -> 15 剩余 provider lifecycle -> 16`：Subagent manager 复用既有 child scope 和 Agent inbox，不需要修改
`AgentLoop.ts`；10C-C 已稳定 request/contribution owner，接下来由默认 profile 与 provider parity 收尾 request admission，
随后 Compaction 与 Interaction 的完整 policy 才共享相同的 durable/lifecycle contract。Execution World 与 LLM policy 在
scope/session contract 稳定后可并行推进。

### 4.2.1 核对后的路线判断

本次核对把“已有接口”和“已完成模块”明确区分如下：

| 判断 | 当前证据 | Roadmap 处理 |
| --- | --- | --- |
| Session 已有 source-of-truth 基础 | `SessionRuntime` 是 sequence/parent/commit owner；JSONL/InMemory 只是 persistence provider；projection driver 可从 checkpoint + tail 或 full replay 重建 | 保持 WP9 为已完成基础，不再新增 transcript 状态副本；后续 compaction 必须写入同一 durable surface |
| Agent publication 已接近 DSH lifecycle | `AgentFactoryProvider` 在 publish 前完成 setup，失败回滚并由 `AgentHandle` drain/dispose | 标记为 M3；剩余工作属于 profile composition 和通用 contribution/event ownership，不回头重写 factory transaction |
| Prompt/context 还不是 DSH 完整语义 | registry snapshot、ToolRegistry schema view、durable instruction/context facts、agent profile surface 和 durable adapter 注入的 admission `stepId` 已接通；生产 composition 默认已切到 `user_message`，native `streamModel` provider retry 已复用一次组装的 prepared request；`AgentLoop.ts` 仍未暴露与 DSH `preStep()` 等价的独立 admission hook，host/remote retry parity 仍不完整 | 以已完成的 10C-C contribution lifecycle 为基础，补真实 remote parity 和独立 admission hook。完成前不删 `model_request` 完整快照 |
| Compaction 算法不等于 compaction 模块 | `CompactionEngine`、micro、snip、budget、overflow 各自可测试；`DefaultContextRuntime` 已通过 `CompactionPort` 编排它们；durable bracket、单事件 replacement、replacement failure compensation 与 native command consumer 已接入 | WP11 的 Context-level Definition/Provider/Consumer 与 P2 native command 已完成；剩余工作集中在 profile selection、cold-resume/retry contract 与跨部署 parity |
| Sidecar 不代表模块化完成 | Module Protocol v2 只证明 transport adapter 可替换，不能证明 scope、durable state 或 provider lifecycle 已闭环 | 只为跨进程需求增加 adapter；不把 Session/Scope/Projection 暴露成第二套远程真源 |

结论：当前最重要的工作不是继续拆目录，而是把每个未完成 seam 的 owner、snapshot 边界、失败语义和 teardown
写成可执行 contract。任何只增加 wrapper、但仍由 composition root 或 context runtime 隐式选择具体实现、没有独立
provider/lifecycle 证据的改动，都只能算 M1 兼容层，不能在 roadmap 中标记为完成。

### 4.3 代码证据与判定

| 观察 | 当前代码证据 | 判定 |
| --- | --- | --- |
| AgentLoop 已有窄 Port，但仍消费宽依赖 | `AgentLoop` 创建 `ModelInvokerPort`/`ToolPort`，同时继续读取 context、router、token、plan、elicitation、file history、subagent、lifecycle 等依赖 | AgentLoop port 化已开始，runtime capability view 未完成 |
| Session 已有 owned handle | `AgentHandle` 包装 submit/abort/steer/snapshot，跟踪在途 generator；`SessionRouter` 通过 `AgentRegistry` 持有 handle，close/recreate/shutdown 等待 drain 并释放 storage subscriptions | 工作包 7 已完成；continuable manager 已使用 AgentHandle，foreground one-shot `SubAgentSession` 仍保留独立 lifecycle |
| Agent 发布事务已形成 | `AgentFactoryProvider` 跟踪 unpublished transaction 和全部 owned handle；setup 完成后同步调用 `AgentRegistry.register/replace`；异步 create/resume/recreate 入口等待 storage/projection/scope rollback | WP10B 已完成；失败 replacement 保留旧 handle，provider unload 阻止迟到 publish 并 drain 全部实例 |
| Tool registry 已支持 scoped view | child registry 动态委托 parent，按 profile allowlist 和 `requiredRuntimeCapabilities` 过滤；parent 后续 register/replace/unregister 会立即反映到 child | WP8 已消除 registry definition copy；通用 registration handle 和 contribution layer 仍待后续 |
| Subagent 已接入 child scope | `AgentRuntimeScope` 继承 router/context/permission，child scope 覆盖并拥有 ToolRegistry/ToolRuntime/scheduler；所有退出路径 dispose；`subagentProvider` 也作为 scoped token 继承/覆盖 | WP8 与 WP8A 基础已完成；provider generation/unload/removal lifecycle、v1 one-shot/v2 continuable descriptor、cold-resume core、exact live-parent identity、settlement、child-first graph、final-disposal race 和 per-child nested Gateway wiring 已有；remote/queued provider 与 sidecar parity 仍属于部署收尾 |
| SessionRuntime committed stream 已接通 | `SessionRuntime` 唯一分配 sequence/parent、稳定 JSON snapshot、串行提交并发布可撤销 subscriber；writer facade 与 resume 共用该 owner | 工作包 3 已完成 |
| Session durable 读写路径已闭合 | `AgentTranscriptEntry` 已覆盖 turn/step、最终 model request、canonical model event、tool call/result 和 inbox mutation；`AgentSession` 从一致 projection snapshot 读取 messages/usage/permission denials/metadata，Web incomplete-turn 也由 projection 派生 | WP9C 已完成；无 provider 的自定义 transcript 仍保留 legacy fallback，默认 runtime 不再以该副本为 durable 真源 |
| Session persistence backend 已分层 | `SessionPersistence` 只提供 append/load/flush；JSONL/InMemory provider 通过 required committed subscriber 组合，失败时不推进 runtime sequence | 工作包 4 已完成；create/list、write-behind 和 crash repair 属于后续增强 |
| Projection 已具备实时 driver | `SessionProjectionDriver` 订阅 committed stream，维护 per-definition cell、统一 `asOfSequence`、change feed、动态注册和版本化 checkpoint codec；resume/recreate 使用同一 storage restore；checkpoint envelope/store、default codec、tail replay 和生命周期写入已接通 | WP9D 已完成；cache 始终可丢弃，任何拒绝或失败均回退 full replay |
| File history projection 已接通 | `file_snapshot_recorded` 属于 `AgentTranscriptEntry`；Gateway 等待 writer append，并从 `file-history.snapshots` 一致快照重建 `FileHistoryStore` | 工作包 1 和工作包 5 的 file-history 部分已完成 |
| Owned registration 基础已建立 | `ScopedServiceRegistry` 提供 typed token、父子继承/覆盖、generation、scope/provider lease、stop-new、drain、异步 dispose 和失败聚合 | 工作包 6 已完成；Gateway AgentHandle、subagent child scope、session-owned PromptContributionRegistry、最终 ToolRegistry、HookRuntime 与 live event carrier 已迁移；剩余是非 Agent-scoped provider 与通用 contribution layer |
| Scope 当前覆盖 runtime service、Agent-scoped contribution 和 live event | `AgentRuntimeScope` 已覆盖 agent/subagent service inheritance，并可持有 session-owned prompt/tool/hook lifecycle；`AgentScopeLiveEventBus` 让 exact scope 的 event 只向自身和 ancestor subscriber 投递，scope dispose 同步 stop-new 并按 subscriber owner drain；Hook execution 与 background-task completion 的 Gateway projection 都以 `own()` 释放 exact source subscription，后者不释放 project-owned task runtime；`PluginRuntimeExtensionResolver` 在 session composition 时冻结 generation-aware command/skill/prompt/tool/hook/MCP contribution snapshot；尚不提供通用 contribution layer | 与 DSH `createScope(ctx)` + scoped registry/effect 的覆盖面仍不同；后续 telemetry、command、MCP/LSP provider 必须复用同一 ownership 模型 |
| Web history read model 已投影化 | artifact、status、turn error 和 token usage 由四个版本化 projection 派生；`readSessionMessages` 只把结果映射为 WebMessage/tokenUsage | 工作包 2 已完成；Web 仍保留 message flatten、compact 显示和 incomplete-turn 等非本工作包逻辑 |
| Prompt/context 基础链路已接通 | `DefaultContextRuntime` 消费 session-owned `PromptContributionRegistry`，严格渲染变量并复用 ToolRegistry-derived schema snapshot；agent profile 可选择 `runtimeContextSurface`，Gateway native composition 与 sidecar payload 均透传；生产 profile 默认已切换为 `user_message`，直接 runtime 保留 `system_prompt` compatibility；plugin prompt/tool/hook contribution 从同一 frozen extension snapshot 进入 session-owned lifecycle；durable context adapter 在 provider assembly 前注入并回传 admission `stepId`，recorder 在 model dispatch 前写 `context_snapshot` 和 instruction baseline/change，resume/recreate 恢复 instruction state；native provider retry 已复用同一 prepared request | WP10C-A/B 仍部分完成；10C-C 已完成，host/remote retry 与独立 admission hook 尚缺 |
| Compaction 已有第一版 provider seam | `CompactionPort` 定义 budget/policy/summary/micro/snip/recovery；`CompactionOrchestrator` 组合 stage provider；`createNativeCompactionPort()` 适配现有算法；`ManualCompactionController`、`AgentHandle`、`SessionRouter` 和 Gateway 组成 native command consumer | WP11A/11C 与 P2 native command 已完成；timeout abort signal、busy/FIFO admission 和 replacement failure 已有 contract。仍缺 profile 级 provider 选择、cold-resume/retry contract、remote/sidecar parity 与跨部署 provider replacement/drain |
| Extension/hook 卸载语义已有 Agent-scoped 闭环 | `HookRuntime` 已支持 stop-new/drain/dispose；其 `CallbackHookExecutor` 与 `AsyncHookRegistry` 提供 generation/精确 handle，async hook 支持显式 complete/cancel 且拒绝 late completion；`PluginRuntime.refreshWithReport()` single-flight，dispose 设置 stop-new gate 并等待当前 refresh；`PluginRegistry.replaceAll()` 先发布新 generation，再暴露 removed 集合并异步执行 plugin dispose；session composition 用同一 frozen snapshot 安装 prompt/tool/hook | 10C-C 已完成；仍缺业务级 pending hook durable resume/cancel、telemetry、非 Agent-scoped command/MCP/LSP provider |
| 后台 task control seam 已闭环 | `BackgroundTaskPort` 只定义 start/list/get/output/wait/stop；`BackgroundTaskRuntime` 结构性实现该 port 并继续封装 `DetachedShellPort`、output ring/spill、wait/stop、stop-new/drain/dispose；它另提供 failure-isolated typed completion subscription。`ProjectRuntime` 经 `ExecutionWorldBundle` 持有 native provider，`task_*` 和 `createBuiltinRegistry` 只声明 port；Gateway session 以 `AgentRuntimeScope.own()` 持有 exact subscription 并按 session 投影 live `agent_status` | DSH `jobs` 的可落地第一段与第二条真实 scope-owned live consumer 已完成。completion 既不是 Session durable event，也没有 DSH `tool-jobs` 的 owner inbox/wakeup，后两者必须另行定义业务语义 |
| Composition root 集中 | `createLocalGateway.ts` 当前约 1982 行，集中创建 Router、Plugin、Context、MCP、FileHistory、Elicitation、Plan 和 Session dependencies | Profile/bundle 应最后收敛，不能先大改工厂 |

### 4.3.1 直接依赖清单与边界

以下清单是本轮对 `node:fs`/`node:fs/promises` 直连的定向审计结果。它只统计 AgentLoop 核心调用链中会影响
Execution World ownership 的直连；Session persistence、Gateway upload、CLI bootstrap 等本身就是 Node provider 或
应用适配器，不应为了“零 Node import”而错误塞进 `FsPort`。

| 直连点 | 当前判断 | 归属与下一步 |
| --- | --- | --- |
| `src/tool/builtin/editNotebook.ts` 的 `readFile`/`stat` | E1 已完成 | `FsPort` Consumer；已迁入注入式 `readFile`/`stat`/`writeText`，并由 registry 复用共享 provider；保留 notebook JSON、snapshot、stale-write、`file_not_found` 和非 regular file 语义；focused fake/native contract 已覆盖 |
| `src/tool/builtin/filesystem/walk.ts` 的 `readdir` | E2 基础完成 | `FsPort.readDirectory` + Node provider 已落地，`walkFiles` 改为注入式 Consumer；保留忽略目录、稳定排序、文件类型、权限错误和取消语义；glob/ripgrep 的搜索执行仍留在 E3 |
| `src/tool/builtin/filesystem/ripgrepFiles.ts`、`src/tool/builtin/grep.ts` 的目录/文件探测 | E3 基础完成 | `grep` target/stat 与 mtime 排序已消费注入 `FsPort.stat`；ripgrep 进程已消费 `SubprocessPort.executeFile`，保留参数、空结果、退出码、超时、取消和错误语义；搜索算法与 glob/ripgrep pattern 仍由 Consumer 拥有 |
| `src/tool/builtin/filesystem/syntaxDiagnostics.ts` 的 checker 进程 | E3 基础完成 | Python/Bash 语法 checker 已消费注入 `SubprocessPort.executeFile`，stdin、超时、stdout/stderr 截断和诊断解析仍由 Consumer 拥有；不再直接持有 `node:child_process` |
| `src/context/attachments/AttachmentResolver.ts` 的文件读取/元数据 | E4-A 已完成（reader seam） | `AttachmentPort` 已有 Definition、Node provider、Resolver consumer 和 Gateway composition；不要把附件模型投影耦合到通用 `FsPort`。尚未拥有 attachment upload/storage、dedupe、restart 或 cleanup，不能等同 DSH attachment capability |
| `src/context/budget/ToolResultBudget.ts` 的 spill `mkdir`/`writeFile`/`copyFile`/`access` | E4-B 已完成（storage seam） | `ToolResultSpillPort` 承接独占写/copy，`ProjectRuntimeRegistry` 显式选择 Node provider，`ToolResultBudget` 只持有 reference schema、token policy 和 alias state。fake-provider contract 覆盖文本、alias collision、媒体和失败诊断；artifact retention/query 是 Session lifecycle 的后续能力，不应塞回 budget 或 provider |
| `src/tool/builtin/executeCode.ts` 的临时目录、脚本文件和删除 | 未完成但边界独立 | `CodeRuntime`/`SandboxPort`；不与普通 workspace `FsPort` 混合，需保留 timeout、abort、cleanup |
| `src/tool/builtin/planFile.ts` 的计划文件读写 | 已完成首段 | 属于 Plan capability；`PlanStoragePort` 已承接目录创建与文本读取，Gateway composition 显式选择 Node provider；plan workflow 的 durable domain contract 仍独立于该 I/O seam |
| `src/context/instructions/InstructionDiscovery.ts` 的 instruction 发现 | 已完成 I/O seam | 属于 Context/Instruction capability；`InstructionStoragePort` 已承接目录枚举与文件读取，Gateway composition 显式选择 Node provider；instruction source 的 durable baseline/change 继续由 Context/Session contract 负责，不以目录 API 作为最终 seam |

由此，Execution World 的下一步不是“把所有 Node fs 调用统一替换”，而是按 ownership 分成三条线：
`FsPort`（workspace 文件/目录）、`SpillPort`/`AttachmentPort`（模型与工具产物）、`SandboxPort`/`CodeRuntime`
（临时执行环境）。每条线都必须分别具备 Definition、Node provider、Consumer、scope owner、适用的 retention/cleanup 和 contract test。

## 5. 目标依赖图

```text
Application Profile / Bundle
        |
        +-- SessionFactory
        |     +-- SessionRuntime (live append-only log)
        |     +-- SessionPersistence provider
        |     +-- SessionProjectionRegistry + driver
        |     +-- SessionScope
        |     `-- AgentRegistry
        |
        +-- Agent Profile
        |     +-- ModelInvokerPort
        |     +-- ToolPort
        |     +-- ContextAssembler
        |     +-- InteractionPorts
        |     `-- CapabilityView
        |
        +-- Capability Providers
        |     +-- Fs / Subprocess / Sandbox / Shell
        |     +-- Subagent / Jobs / Workflow / Plan
        |     `-- Web / LSP / MCP / Skills
        |
        +-- Policy Providers
        |     +-- Permission / Retry / Token Meter
        |     `-- Lifecycle / Telemetry
        |
        `-- Optional Transport Adapters
              +-- Module Protocol v2 sidecar
              `-- future remote providers
```

依赖方向必须保持：

```text
Definition <- Provider
Definition <- Consumer
Composition -> Provider + Consumer
Transport -> Definition
Definition -X-> Transport / CLI / Gateway / concrete provider
```

Session 状态流必须只有一条：

```text
domain producer
      -> SessionRuntime.append(typed event)
      -> committed event stream
           +-> SessionPersistence.append/flush
           +-> SessionProjectionDriver.apply
           `-> optional observers / telemetry

resume = SessionPersistence.load -> SessionRuntime.restore -> projections replay/restore
```

`TranscriptWriter` 在迁移期只是 `SessionRuntime.append()` 的兼容 facade；JSONL 是 persistence provider，
不是第二个 Session 模型。Web、Gateway 和 CLI 只读 projection/application facade，不各自扫描并解释日志。

## 6. 核心目标契约

下面是目标职责，不要求一次性采用这些具体命名。

### 6.1 Session Event 与 Projection

- `SessionRuntime.append(event)`：唯一领域事件提交入口，负责 sequence、无损 JSON 校验、冻结和 committed event 分发；
- `SessionPersistence.append/load/flush/list`：独立的 durable backend seam；现有 `SessionEventStore` 先作为兼容 provider 演进；
- `SessionRuntime.flush()`：等待所有 persistence provider 到达明确 durability checkpoint；
- `SessionProjectionRegistry.register(definition)`：注册 projection，返回 disposable handle；driver 只订阅一次 committed event stream；
- projection 声明 `name`、`stateVersion`、state schema、`initialState`、同步 `reduce`，以及可选 wire view/snapshot codec；
- `snapshot(session)` 返回带 `asOfSequence` 的一致切面，Web reader 不再自行折叠同一领域状态；
- 现有 Transcript entry 迁移为 event schema v1，JSONL 文件格式保持兼容；
- live AgentEvent 不自动持久化，只有显式映射的 durable event 才进入 SessionRuntime；
- 不要求本阶段照搬 DSH 的压缩行格式、SQLite 后端或 Cordis event API。

### 6.2 Scope、Registry 与 Ownership

- `SessionScope` 拥有 session 生命周期资源；
- `AgentScope` 从 SessionScope 派生，可覆盖 model、tools、interaction 和 policy；
- `AgentRegistry.spawn(profile)` 返回 `AgentHandle`；
- `AgentHandle.dispose()` 先禁止新 turn，再 cancel/drain 在途执行，最后反向释放 owned effects；
- provider registration 返回 handle，replacement 使用 generation 防止旧 provider 的迟到结果覆盖新状态；
- subagent 使用 child scope 继承/屏蔽 capability，不再复制 registry 或按工具名硬编码排除。

### 6.3 Context 与 Interaction

- system prompt section、variable、instruction source 和 extension contribution 独立注册；
- ContextAssembler 在 turn 开始时读取稳定 snapshot，turn 内不受热更新破坏；
- approval、user question、elicitation 分成独立 port；
- scope policy 决定某 agent 是否可提问、是否可请求权限，不由工具名决定；
- permission preset 是 policy provider，不写入 ToolRuntime 或 sidecar transport。

### 6.4 Execution World 与 LLM Policy

- ToolPort 保持“模型可见工具列表与批量执行”的聚合职责；
- fs、subprocess、sandbox、shell 是 Tool provider 依赖的底层能力，不直接塞入 ToolPort；
- RouterPolicy 决定目标 provider/model；ModelProvider 执行 canonical request；
- RetryPolicy、TokenMeter、UsageObserver 通过独立 seam 组合；
- retry attempt 属于 provider/policy 内部，除非宿主协议明确需要，不提升为公共 session 身份。

## 7. 分阶段 Roadmap

### Phase 0：冻结规则与验收基线

目标：在继续拆分前统一模块判定、依赖方向和回归证据。

交付：

- 建立 seam inventory，记录 owner、scope、provider、consumer、state、dispose、transport；
- 为 native/sidecar 当前行为固化 parity fixture；
- 标注 durable/live/policy 三类事件；
- 建立禁止依赖检查：Definition 不得导入 CLI、Gateway、sidecar 或具体 provider。

允许：新增文档、contract test、依赖检查脚本。

禁止：批量移动目录、改变 Transcript 格式、引入容器框架、修改 `AgentLoop.ts`。

退出门槛：所有候选 seam 均有 owner 和迁移顺序；当前 native/sidecar 基线可重复运行。

### Phase 1：Session Event Store 与 Projection Registry

目标：把现有 Transcript 演进为明确的 Session event source of truth，并把 core Session、projection 和
persistence 的职责分开，而不是另建第二套日志。

交付：

- Phase 1A，补齐现有兼容基础：
  - 把 `file_snapshot_recorded` 纳入 `AgentTranscriptEntry`，连接 `FileHistoryStore.onSnapshotRecorded` 与 resume replay；
  - 把 Web artifact、status、token usage、error 等 read model 迁到版本化 projection；
  - 保留 fork/replace 等确实需要原始日志变换的命令路径，并显式标为 command/migration consumer。
- Phase 1B，分离 live Session 与 persistence：
  - 在现有 `SessionEventStore` 之上引入 `SessionRuntime`/`SessionJournal`，拥有 append、sequence、事件校验和 committed stream；
  - 抽出 `SessionPersistence` backend contract，JSONL/InMemory provider 不拥有领域投影；
  - resume 统一为 `load -> restore -> replay`，不再由 writer、AgentSession 和 Web reader分别维护状态。
- Phase 1C，升级 projection driver：
  - projection cell 随 committed event 增量推进；
  - 提供一致性 snapshot、change notification、state schema/version 和可选 checkpoint；
  - 将 messages、usage、permission denials、metadata、compact boundary、subagent reference、file history
    作为首批内置 projection。
- 保留旧 `AgentTranscriptWriter` facade，内部转发到 SessionRuntime；旧 JSONL 继续可读。

允许：session/transcript、session/resume、projection adapter 和 focused tests。

禁止：改变现有 JSONL entry 顺序语义；让 sidecar 或 Gateway 成为 event owner；一次性删除 writer API。

退出门槛：旧 transcript 可无损 replay；新旧 projection 结果等价；明确标记可忽略的未知 event 可诊断并跳过，
其他未知 event 拒绝；`append -> projection -> flush -> restart -> replay` 测试通过；同一时刻不存在两个
sequence owner 或两个 durable writer。

回滚点：feature flag 切回 legacy replay，JSONL 文件无需降级转换。

当前进度：Phase 1A、Phase 1B 和 Phase 1C 的本轮基础目标已完成。`SessionRuntime` 具备 typed append、唯一 sequence/parent
owner、稳定 JSON materialization、串行 commit、可撤销 subscriber、失败隔离和状态恢复；
`SessionPersistence` 已抽为独立 append/load/flush contract，JSONL/InMemory provider 通过 required subscriber
组合；Transcript facade、`ProjectSessionStorage` 与 resume 共用该 runtime owner。
`SessionProjectionDefinition`、`SessionProjectionRegistry`、可撤销 registration 和
`SessionProjectionDriver` 已建立；driver 随 committed event 增量推进 per-definition cell，提供统一
`asOfSequence` snapshot、change notification、动态注册/移除、hydrate 和可选版本化 checkpoint codec。
现有 Transcript replay 已拆为 conversation、turn summary、metadata、compact boundary、subagent reference
五个版本化 projection；Web history 的 artifact、status、token usage 和 turn error 也已拆为四个独立 projection。
`file_snapshot_recorded` 已进入 `file-history.snapshots` projection，Gateway 的 resume/recreate 从同一 projection
snapshot 恢复并可继续 rewind，Web reader 只消费对应 projection 结果。

projection checkpoint 持久化闭环已完成：wire envelope 带 session、全局水位、精确日志锚点和 per-projection
version/watermark/state；JSON/InMemory store、默认 projection codec、storage restore/flush、checkpoint + tail、turn-end
与 dispose 写入均已接通，cache 失败保持 fail-soft。AgentSession 的
messages/usage/denials/reload metadata 已改读同一 live projection snapshot，Web incomplete-turn 查询也已投影化；event vocabulary 已覆盖
完整 turn/step、最终 model request、canonical stream、tool call/result 和 inbox mutation；`appendRecorded/restore` 会同时校验
envelope 与 turn/step/tool/inbox 领域关系，并兼容 sequence gap、branch、missing-parent orphan、legacy-only 日志和未闭合
crash tail。因此当前成果应标记为“Session infrastructure M2，core Session M1-M2”，不能标记为
完整 DSH Session 架构完成。

### Phase 2：Agent Scope、Registry 与 Owned Lifecycle

目标：解决主 agent/subagent 的能力作用域、资源 ownership 和释放语义。

交付：

- `SessionScope`、`AgentScope`、registration handle；
- `AgentRegistry`/`AgentHandle`，统一 spawn、cancel、drain、dispose；
- `createAgentSession` 改为消费已组合的 session runtime；
- `SubAgentSession` 改为创建 child scope，不再 clone registry/runtime；
- capability allow/deny 使用 policy/descriptor，不再按工具名硬编码。

允许：新增 scope/registry facade，先以 adapter 包装现有 registry 和 scheduler。

禁止：在本阶段重写 AgentLoop 状态机；改变工具执行顺序和并发语义；默认允许 subagent 嵌套。

退出门槛：parent/child 隔离、provider override、late event、cancel/drain、double dispose 和资源泄漏测试通过。

回滚点：composition flag 继续选择 legacy `createAgentSession`/SubAgentSession wiring。

当前进度：工作包 6 已完成通用 `ScopedServiceRegistry` 基础。父子 scope 可以继承和局部覆盖 provider；替换会先
发布新 generation，再等待旧 provider 的在途 lease 排空；scope teardown 会停止新调用、等待 child scope 和
继承调用、释放全部本地 provider，并聚合 disposer 失败。工作包 7 已完成 `AgentRegistry / AgentHandle`：
SessionRouter 的 close、dirty recreate 和 shutdown 现在会停止新 turn、abort 在途 AgentSession、等待 generator
退出，并 flush/dispose session storage 的 projection 与 persistence subscription。工作包 8 已完成：
`AgentRuntimeScope` 让 child 继承 router/context/permission，child 自己拥有 ToolRegistry/ToolRuntime/scheduler；
ToolRegistry scoped view 动态委托 parent，不复制 definition；`requiredRuntimeCapabilities` 与 profile allowlist 共同决定
工具可见性，`SubAgentSession` 不再包含 agent/plan/always-on/ask-user 名称黑名单；成功、失败、abort 和 timeout 路径
都会释放 child scope。Phase 2A 的 service scope 与 Agent publication 目标已完成；Phase 2B 的通用 contribution/event
scope 仍未完成。WP10B 又补齐 DSH Agent factory 发布语义：create/resume/recreate
在未发布状态完成异步 setup，所有 await 成功后同步提交到 registry；任一步失败都通过 handle-owned resource graph 回滚
session、storage、projection 和 scope，factory provider 卸载会阻止迟到 publish 并排空其全部 handle。该实现位于
session/agent factory 与 composition 层，未修改 `AgentLoop.ts`。通用 contribution/event scope 仍留待后续工作包。

### Phase 3：System Prompt、Context Contribution 与 Compaction

目标：先把 prompt assembly 从集中实现演进为可注册、可排序、可撤销 contribution，再把动态 request context 和
workspace instructions 变成可恢复的 Session fact；最后把 compaction 从具体 Context 实现拆成基于 Session surface 的策略、
执行 provider 和 durable transaction。

交付：

- prompt section、variable 和 runtime-context provider definition；
- ToolRegistry 到 request assembly 的只读 schema snapshot adapter，不建立第二套工具定义真源；
- native provider 包装现有 identity/persona、skills、MCP instructions、time/project context；
- workspace instruction baseline/change 与需要审计的动态 context 作为 durable Session fact；
- DSH 目标语义为 step-stable snapshot；本分支兼容实现可先使用显式标注的 turn-stable snapshot；
- host context consumer 继续作为同一 Definition 的 transport adapter。
- `CompactionPort`、trigger policy、summarizer provider 和 optional tool-result pruner 分离；
- compaction 以 Session durable bracket + surface replacement 表达，command/auto/overflow 只是不同 consumer。

允许：在 ContextRuntime 外增加 contribution registry 和 compatibility assembler。

禁止：把宿主 prompt 复制到 sidecar；在 contribution 中直接修改 Session 状态；无规则拼接字符串。

退出门槛：prompt 顺序、去重、ToolRegistry 单一真源、cache stability、snapshot 边界、native/host context 对拍通过；
动态 context/instruction 可从 durable log 重建；compaction 的成功、跳过、失败、abort 和 crash tail 均可从 durable log
判定，原始 tool result 不被物理删除。

Phase 3 的执行顺序固定为：

1. 10C-A：在不修改 `AgentLoop.ts` 的前提下，为 request admission 产生稳定的 step identity，并使 prompt/context
   snapshot 绑定到该 identity；在此之前继续保留 turn-stable compatibility snapshot。
2. 10C-B：将 runtime context 从“仅拼入 system prompt”的兼容路径扩展为可恢复的 durable user-role surface；system
   section、runtime context、workspace instruction 的 owner 和 projection 必须分开。
3. 10C-C（已完成）：prompt、tool schema、instruction、hook registration 已接入同一 frozen extension generation 和
   session-owned lifecycle；ToolRegistry 仍是唯一 schema 真源，HookRuntime 已有 stop-new、drain、dispose、显式
   complete/cancel 与 late-result rejection。后续新增 Agent-scoped contribution 必须复用此路径。
4. WP11-A：先抽 compaction Definition 和 provider adapter，不改变现有算法和 AgentLoop 调用形状。
5. WP11-B：把 policy、full summary、micro projection、snip、overflow recovery 组成一个 context provider，并以
   contract tests 验证 no-op、失败保留原历史、abort 和 emergency 顺序。
6. WP11-C：最后增加 durable compaction bracket/surface replacement；只有 replacement 可由 live、restart 和 crash-tail
   replay 判定后，才允许把兼容 boundary/message 逐步降级为 facade。

### Phase 4：Interaction Seams

目标：拆开 approval、user questions、elicitation 和 presets，形成 session/agent scoped interaction world。

当前状态：P3-A 已完成。`InteractionProfile` 明确选择 `interactive`、`headless`、`disabled`：
`createLocalGateway` 按 explicit option -> legacy `autoElicitation` -> project config -> interactive default 的优先级
组合 question/permission provider；`ProfiledPermissionDecisionPort` 只处理底层的 `ask`，因而不会把既有的
allow/deny/cancel 结果改写为另一套状态机。这个 profile 仅是 composition selection，不拥有 Gateway pending request、
session history 或 reconnect state。

P3-B 已完成 ownership 修复：`ResumeSessionDependencyExtension` 和其 merge 会透传
`ownedElicitation`，使 resume 的 channel 与初始 create/dirty recreate 同样由 `AgentRuntimeScope` stop-new、drain、
dispose；`interactionReconnect` 仍由 Gateway/base dependency 所有，不会随着 session extension dispose。定向回归覆盖
resumed handle 的 owned channel release 与重复 dispose 幂等；既有 child-scope contract 覆盖不误释放 parent channel。

P3-C 已完成 browser dialog restore：它只消费现有 `InteractionReconnectPort` 的 JSON-safe replay DTO，在 exact binding
确认后恢复显示；不创建第二个 pending request、不重新发出 permission/question 审计，也不让旧 binding 的 answer
重新生效。Web bridge 的远端 `submit_turn` stream 在 socket close 后同样失效；真实 bridge+WS 断线 E2E 已分别覆盖
pending question 和 pending permission，以及 answer 后的 tool/model/terminal event 投影和 terminal snapshot 清理。
Gateway 在 30 秒 grace window 内保留 terminal replay prefix，bridge 仅在首次 snapshot 以 DTO 重绘 interaction，之后按
稳定 cursor 投影后续事件。因此这不是第二个 reconnect/pending-state owner，完成条件不是“能重绘 dialog”而是断线后整段 turn
仍可完整收束。

交付：

- `ApprovalPort`、`UserQuestionPort`、可选 `ElicitationPort`；
- permission preset/policy provider；
- headless、interactive gateway、subagent 的明确 provider/profile；
- waiting request 的 cancel、timeout、session dispose 语义。

允许：兼容现有 `PermissionDecisionPort` 和 gateway hooks。

禁止：把 question 伪装成普通 tool result；缺 provider 时静默等待；由工具名判断 agent 是否可交互。

退出门槛：allow/deny/ask/cancel/timeout/reconnect，以及 subagent no-interaction contract test 通过。

### Phase 5：Execution World Seams

目标：把 ToolPort 背后的底层执行能力独立出来，优先处理风险和复用价值最高的能力。

顺序：

1. 固化已完成首段的 `SubprocessPort` consumer/provider contract；
2. `FsPort`；
3. `SandboxPort`；
4. `ShellPort`（首段已完成）/terminal session；
5. web、jobs、LSP、MCP 等按需求迁移。

每个 seam 均需 Definition、local provider、tool consumer、scope policy 和 contract tests。文件历史、权限、审计和
观察事件通过组合 policy 接入，不嵌入平台 provider。

禁止：把每个 seam 自动暴露为 Module Protocol endpoint；改变现有 ToolScheduler 的批量/并发/结果顺序。

退出门槛：native provider 与旧工具结果等价；sandbox boundary、abort、timeout、partial failure 和 cleanup 测试通过。

### Phase 6：LLM Provider 与 Policy Seams

目标：保持 ModelInvokerPort 稳定，同时拆开 invocation、routing、retry、token 和 usage policy。

交付：

- provider invocation registry；
- RouterPolicy/RequestMaterializer；
- RetryPolicy；
- TokenMeter/UsageObserver；
- model capability/limit lookup provider。

禁止：改变 canonical model event；把 provider 内部 attempt 直接提升为 Session event；破坏 prompt cache key 稳定性。

退出门槛：routing、fallback、retry、abort、usage、cache、context limit 和 native/host model 对拍通过。

### Phase 7：Lifecycle、Telemetry 与 Extension Registration

目标：在已完成的 Agent-scoped prompt/tool/hook contribution lifecycle 之上，收敛非 Agent-scoped provider 的注册、替换
和释放，而不是合并所有 event bus。

交付：

- telemetry observer registration handle；
- command、MCP/LSP 等非 Agent-scoped provider registration handle；
- 复用既有 scope-filtered live event carrier，并明确 live/durable/policy event 的投影边界；
- PluginRuntime refresh 产生 generation-aware non-Agent-scoped contribution diff；
- provider unload 先停止新 dispatch，再 drain callback/async hook，最后 dispose；
- 明确三类事件：live AgentEvent、durable SessionEvent、policy/capability event。

禁止：用一个无类型全局 event bus 替换所有事件；让 telemetry observer 改写 session 真源；热更新跨 turn 修改 snapshot。

退出门槛：plugin reload、removed non-Agent-scoped provider、in-flight hook、duplicate registration、observer failure 隔离和
业务级 pending-hook resume/cancel 测试通过。

### Phase 8：Profile、Bundle 与 Boot Composition

目标：将集中式 factory/manual wiring 收敛为显式 profile 和 bundle。

交付：

- profile 描述 agent 能力集合、interaction 模式、policy 和 provider 选择；
- bundle 组合 session、agent、capability 和 application facade；
- native CLI、Gateway、headless、sidecar 使用不同 profile，共享同一 Definition；
- 逐步缩小 `AgentRuntimeDependencies`，最终只保留兼容 facade 或删除。

禁止：业务 runtime 读取全局容器；profile 包含 transport 专属业务字段；一次性重写 `createLocalGateway`。

退出门槛：组合快照测试、缺失 provider 诊断、profile override、启动/关闭顺序和现有 CLI/Gateway E2E 通过。

### Phase 9：按需增加 Transport Projection

目标：仅对有跨语言、进程隔离或独立部署需求的 seam 增加 transport adapter。

候选优先级：model、tool aggregate、permission、context 已存在；后续可能是 sandbox/subprocess 或 remote subagent。

每个新增 transport profile 必须补齐 schema、capability negotiation、cancel/deadline、idempotency、status/resume 和
native/remote contract parity。Session event store、projection registry 和 scope registry 默认不跨进程暴露。

## 8. 可执行工作包

以下顺序按可独立评审、可回滚的 PR 粒度拆分。后一个工作包不得通过复制前一个尚未稳定的接口来抢跑。

| 顺序 | 工作包 | 主要改动 | 依赖 | 完成信号 |
| ---: | --- | --- | --- | --- |
| 1 | File history durable event | 增加 typed `file_snapshot_recorded`；Gateway 写入；resume 重放；兼容旧日志 | 当前 EventStore 基础 | 崩溃重启后 rewind/diff state 等价 |
| 2 | Web history projections | 抽出 artifact、status、token usage、turn error projection，Web 只消费结果 | 1 | `readSessionMessages` 不再为这些领域重复扫描 entries |
| 3 | SessionRuntime committed stream | 建立 live append-only aggregate、typed append、sequence owner、subscriber API；writer facade 转发 | 1-2 | live 与 replay projection 对同一日志结果一致 |
| 4 | Persistence backend split | 将 JSONL/InMemory 收敛为 persistence provider，统一 load/append/flush；resume 只走 SessionRuntime | 3 | append/flush/crash/restart 契约测试通过 |
| 5 | Live projection driver | 增量 cell、`asOfSequence` snapshot、change notification、schema/version、可选 checkpoint | 3-4 | Web/Gateway 可读取一致 projection snapshot |
| 6 | Owned registration primitives | `RegistrationHandle`、generation、stop-new/drain/dispose；scope-aware registry layer | 5 | replacement、late result、double dispose 测试通过 |
| 7 | AgentRegistry / AgentHandle | 统一 live session 的 submit/abort/idle/dispose；SessionRouter 持有 handle 而非裸 session | 6 | close/evict/shutdown 会等待完整 teardown |
| 8 | Subagent child scope | 通过 AgentRuntimeScope 创建 child runtime；用 capability policy 替代 registry clone 和工具名黑名单 | 7 | parent/child 隔离、禁止嵌套和取消传播测试通过 |
| 8A（provider/inbox/manager/descriptor/cold-resume/exact-parent contract 基础完成） | Subagent provider 与 continuation ownership | `prepareContinuable` 只返回 detached spec；`AgentTurnInbox` 拥有 durable FIFO；`SubagentContinuationManager` 持有 live handle、按 child 线性化 lifecycle，并用 `followup()` 提交 initial/later input；v2 descriptor 在首条 admission 前记录 resumable composition；absent activation 经 host inspect/resume 从 child-owned log 恢复；exact parent handle 经最小 live directory 授权 | 8、9、10B | provider generation/drain、v1/v2 descriptor、durable enqueue/claim/restore、manager materialize/admit/durable-parent/exact-live-parent 校验/cold-resume/rollback/drain、settlement、child-first graph、final-disposal race 与本地 nested host/tool wiring 已有 contract/E2E；remote/queued provider 与 sidecar parity 留给部署 gate |
| 9 | Session source-of-truth closure | 按 9A-9D 补 envelope/domain 校验、durable vocabulary、projection consumer 和 checkpoint persistence | 5、7 | 模型可见输入与 turn/tool/inbox 状态可仅由日志重建，live/restart/fork 等价 |
| 10A（已完成） | Prompt registry core | section/variable/runtime-context contribution；scoped registration handle；确定性顺序；ToolRegistry 只读 schema adapter | 6、8-9 | registry contract、shadow、撤销、顺序、重复名和单一工具真源测试通过 |
| 10B（已完成） | Agent publication transaction | create/resume 在 unpublished scope 中 setup；同步 publish；失败回滚；factory provider co-ownership | 7-10A | setup 不可提前观察；任意失败无泄漏；provider unload 会停止并排空全部 handle |
| 10C（进行中） | Prompt/context integration | DefaultContextRuntime 迁移到 registry；native/host assembler 对拍；动态 context 与 workspace instruction baseline/change durable 化 | 9、10A-10B | cache/snapshot 边界稳定；live/restart request material 等价；无第二套 tool schema 或 instruction 真源 |
| 10C-A（部分完成） | Step-stable admission | durable context adapter 为 request admission 注入稳定 `stepId`，snapshot generation 与 step 绑定；native 与 host model adapter 在 prepare 边界复制并冻结 canonical prepared request；保留 turn-stable compatibility fallback | 9、10A-10B | registry 在第一次 provider attempt 后更新时，retry 仍使用旧 prompt、下一 request 才读取新 generation；同一 prepared invocation 的 host retry 已有 requestId 变化/request material 不变 contract，真实 remote bridge 对拍和 DSH `preStep()` 等价公开 hook 仍缺 |
| 10C-B（部分完成） | Durable runtime-context surface | `agent.runtimeContextSurface` 已成为 profile 配置并由 Gateway native composition、AgentRuntimeConfig 与 sidecar payload 透传；生产默认 profile 已选择 `user_message`，该 profile 将动态 runtime context 物化为 durable synthetic user message；system section 与 durable context/instruction 分离；直接 `DefaultContextRuntime` 保留 `system_prompt` compatibility | 10C-A | profile 下 live/restart/replay surface 等价；context persistence 失败阻断 dispatch；真实 remote bridge parity 与完整部署验证仍缺 |
| 10C-C（已完成） | Agent-scoped contribution lifecycle closure | session composition 每次以 `PluginRuntime.acquireContributionSnapshot()` 获取一个 immutable extension generation lease；plugin prompt 注册到 session-owned `PromptContributionRegistry`；extension tool 经 availability preflight 后直接注册到最终 session-owned `ToolRegistry`，不可用工具写入同一 registry diagnostics；frozen plugin hook settings 注入 session-owned `HookRuntime`；`HookRuntime`/`CallbackHookExecutor`/`AsyncHookRegistry` 已具备 generation、stop-new、drain、dispose、显式 complete/cancel 与 late-result rejection；`PluginRuntime` refresh 采用 single-flight，dispose 有 stop-new gate 并等待当前 refresh；`PluginRegistry.replaceAll()` 先发布新 generation，退役插件实例等待精确 lease release 后才 dispose | 6、10A-10B | Node 22 build 与 Agent scope、prompt resolver、extension tool、callback hook、plugin lifecycle 的 focused contract tests 通过；同名重载按实例而非逻辑 key 退役。后续业务级 durable pending-hook、telemetry、command 与 MCP/LSP 进入 WP15，不再阻塞 10C |
| 11A（已完成） | Compaction definition/adapter | 新增最小 `CompactionPort`，保留现有 Compaction/Micro/Snip/Overflow native adapter；context sidecar 可选转发 `try_auto_compact` | 9、10C-A | DefaultContextRuntime 只依赖 port；算法结果与现有 focused tests 等价；host adapter/protocol contract 通过 |
| 11B（基础完成） | Compaction policy provider | 分离 budget evaluation、auto policy、full summarizer、micro projection、snip 和 emergency recovery；command/auto/overflow 作为 consumer | 11A | `CompactionOrchestrator` 已成为唯一 auto consumer；stage-only provider 自动补齐统一编排，no-op、warning/blocking、summary failure、micro/snip ordering、emergency overflow contract 通过；P2 native command 已复用同一 provider，仍需 profile selection 与跨部署 retry/result policy |
| 11C（部分完成） | Durable replacement transaction | compaction `started/completed/failed` bracket 已由 durable context adapter 写入；completion 延迟到 replacement durable commit，失败时写入 `compaction_failed` 并通过 TurnRunner 外围 abort 阻止下一次模型 dispatch；replacement surface 与 compact boundary 仍合并为单个 durable event，并由 projection 在 completed turn 后原子呈现 | 9、10C-B、11B | 已证明 bracket 的 live/replay/crash-tail 校验、单事件 replacement 边界、append failure compensation 与 P2 native command 的 terminal turn；完整完成仍需 profile selection、cold-resume/retry contract、remote/sidecar parity 和原始 tool result 审计 contract |
| 12（P3-A/B/C 已完成；bundle 收敛待 Phase 8） | Interaction seams | Approval/UserQuestion/Elicitation 独立 port；session-owned permission/question lifecycle audit；scope-scoped interaction policy/deadline provider；`interactive`/`headless`/`disabled` provider profile；waiting request teardown | 8、10B-10C | permission/question started/completed/failed audit、channel provider、deterministic headless answerer、child no-interaction blocking、permission duplicate/late/abort/teardown/timeout 和真实 Gateway round-trip 已具备。`InteractionProfile` 与 `ProfiledPermissionDecisionPort` 已进入 config/local-Gateway composition；resume 也会透传 owned elicitation channel；`InteractionReconnectPort` 已覆盖 WS disconnect/reconnect replay、exact previous binding、stale reply rejection、JSON-safe replay DTO 和 Gateway shutdown drain。P3-C 额外以真实 bridge+WS 覆盖 question/permission dialog replay、answer 后 tool/model/terminal 投影和 terminal snapshot 清理；剩余仅为最终 profile/bundle registry 收敛 |
| 13（部分完成） | Execution world seams | 固化 Fs/Subprocess/Shell foreground/DetachedShell 首段，再按 Sandbox -> Agent terminal tool 拆 Definition、Provider、Consumer 和 scope policy | 6、12 | `FsPort` 已完成读写、目录和 search metadata 首段（Node provider、read/write/edit/notebook/walk/glob/grep consumers、injected fake/native contract）；`SandboxedFsPort` 已把 direct write 的 read-only deny、workspace-root containment 和 fresh canonical target 置于 provider；`SubprocessPort` 已完成 shell/direct-executable 首段并有注入 provider contract；`ShellPort`/`DetachedShellPort` 已接入 `bash`/`task_*`/hook consumers；macOS `SandboxPort` 已封装 `execute_code`、foreground shell 与 detached shell 的 exact argv，native 结果等价，abort/timeout/cleanup contract 可复用；Fs attachment、跨平台 process sandbox、Agent terminal tool/task reconnect 尚未闭环 |
| 14（部分完成） | LLM policy seams | 拆 provider invocation、routing/materialize、retry、token meter、usage observer、fallback、cache、orchestration | 6、10C | `RetryPolicy`、`RouterRetryPolicy`、`RouterRequestMaterializer`、`RouterCachePolicy`、`RouterUsageObserver`、`RouterTokenMeter`、`RouterFallbackPolicy`、`RouterModelInvocationPort` 与 `RouterOrchestrationPolicy` 已完成首段并覆盖 request/stream/router retry、session usage cache、stats flush/dispose、subagent budget、成功/失败 usage fallback、决策到 canonical request 的 materialize、cache-aware sticky selection、fallback attempt planning、eligibility、model invocation delegation 与 orchestration admission；provider invocation registry 与更细粒度 routing 仍未拆分 |
| 15（WP15-A、WP15-B telemetry 首段已完成） | Remaining Extension provider lifecycle | 以已完成的 `10C-C` 为基础，先使 `PluginRegistry` 的 generation snapshot 成为可释放 lease：新 generation 立即可选，旧实例只在所有持有 session release 后 dispose，runtime/AgentHandle rollback 与 teardown 都释放该 lease。WP15-B 增加 app-owned typed telemetry observer registry，registration handle 提供 generation、replace、stop-new、in-flight drain 和 disposer，Gateway 的既有 `TelemetryClient` 经 live-only wrapper 接入；Agent scope live event carrier 已完成，后续只将 command、MCP/LSP 纳入同一 ownership 模型，并为业务级 pending hook 定义 durable resume/cancel | 6、10C-C、13-14 | WP15-A 已覆盖 lease-retirement、同名 instance reload、stop-new/drain/dispose 和 releasable contribution snapshot；WP15-B 已覆盖 observer replacement、异步 drain、failure isolation 和 Gateway shutdown ownership。完整 WP15 仍需 plugin reload/removed non-Agent provider、in-flight hook 和 pending-hook resume/cancel；不会引入绕过既有 session-owned lifecycle 的第二套 contribution 生命周期 |
| 16 | Profile/bundle/boot | profile/bundle 装配；启动失败逆序回滚；缩小 `createLocalGateway` 和 dependency bag | 10B-15 | native/headless/sidecar/Gateway 由 profile 创建并按 owner 有序关闭 |

当前状态（2026-09-09）：工作包 1 已完成并由 InMemory/JSONL、Gateway restart/resume 和 rewind 测试覆盖；
工作包 2 已完成，artifact、status、token usage 和 turn error 均由版本化 projection 派生；工作包 3 已完成，
contract test 覆盖并发顺序、调用时 snapshot、subscriber dispose/失败隔离、restore 后继续追加，以及 live/replay
projection 等价；工作包 4 已完成，JSONL/InMemory 实现独立 persistence contract，并覆盖 append/flush/restart 与
required backend failure 不推进 sequence。工作包 5 已完成：driver、file-history projection、Gateway 一致快照读取、
live/cold 等价和 checkpoint version fallback 均有 focused test。工作包 6 已完成：typed token、parent/child
inheritance/override、generation、late completion、stop-new/drain/dispose、double dispose 和 disposer failure
aggregation 均有 contract test。工作包 7 已完成：AgentHandle 跟踪 turn 生命周期，AgentRegistry 统一 replacement/removal，
SessionRouter close/recreate/shutdown 等待 teardown，storage-backed handle 释放 projection/persistence subscription。
工作包 8 已完成：child scope 继承 router/context/permission，覆盖并拥有 child tool runtime；ToolRegistry 使用动态 parent
view，capability metadata 替代名称黑名单，并覆盖 parent 动态变更、嵌套拒绝和 scope teardown 测试。工作包 9C 已完成；
工作包 9D `Checkpoint persistence` 已完成；工作包 9 的 Session source-of-truth closure 达到当前退出门槛。
工作包 10A 已完成：`PromptContributionRegistry` 提供 parent/child named shadow、exact registration handle、共享
generation、调用时冻结的异步 snapshot、complete-section 冲突校验和级联 dispose；
`createToolRegistryPromptSchemaSource()` 只从现有 ToolRegistry 读取并复制 canonical schema，不建立第二套工具定义真源。
工作包 10B 已完成：`AgentFactoryProvider` 管理 unpublished create/replace transaction，异步 setup 成功后才同步 publish；
setup/publish/restore/构造失败会等待 handle-owned storage、projection 与 scope 回滚，failed replacement 保留旧 handle；
provider double-dispose、pending setup unload、全部 handle drain 和 subscription cleanup 均有 focused test。`SessionRouter`
已改走该 provider，dirty recreate 只在新 handle 发布后发出 eviction。WP10C 已完成基础链路：
`DefaultContextRuntime` 消费 prompt registry，默认变量与 scoped variable 严格插值，ToolRegistry-derived schema snapshot
同时供 prompt 和最终 request 使用；native/host `ModelContext.materialization` 可携带 runtime context 与 instruction layers；
session recorder 在 `model_request` 前提交 `context_snapshot` 和 `agent_instructions`，支持 baseline/change/remove、resume/recreate
恢复和持久化失败阻断 dispatch；session AgentRuntimeScope 会拥有并在 handle dispose 时释放 registry。WP10C-A 已接入 admission
`stepId`：durable context adapter 从 recorder 读取下一 step，在 provider assembly 前注入，并将同一 identity 回传到
`ContextMaterialization` 与 `context_snapshot`。WP10C-A 已用真实 native path 验证：`AgentLoop` 将一次 assembly 传给
`ModelInvokerPort`，`streamModel` 在 provider retry 内复用该 prepared request；第一次 attempt 后 registry 热更新不会影响 retry，
只影响下一 request。当前 native 与 host adapter 还会在 prepare 边界复制并冻结 canonical request，因此调用方可在同一
prepared invocation 上重试 host module call，而不重新组装 prompt/tool snapshot；contract test 已覆盖 requestId 改变但
request material 不变，并验证 `runId`、`operationId`、`idempotencyKey` 和嵌套的 `operationDeadline` 在 retry 间保持不变。
sidecar server 还会在同一 operation 的后续成功 attempt 到达后清除旧 module failure，避免已恢复的 retry 被错误投影为最终失败。
它仍是部分完成：`AgentLoop.ts` 没有与 DSH `preStep()` 等价的独立 retry/admission hook，真实 remote
bridge 的 retry/断线对拍和跨部署 provider contract 尚未完成。WP10C-B 已将 `agent.runtimeContextSurface: "user_message"` 接入 profile：runtime context
不再进入 system prompt，而是以带 `synthetic/purpose` metadata 的 user-role message 插入最新真实 user request 前，并随
`context_snapshot` 持久化；live、cold replay、incomplete tail 和 projection checkpoint 已有 focused coverage。为保持 native
行为，生产 composition 已使用 `user_message`，但直接 `DefaultContextRuntime` 仍保留 `system_prompt` compatibility；因此 10C-B 仍需完成真实 remote/restart 对拍。10C-C 已完成：每个 session
只消费一个 frozen extension generation；plugin prompt 注册到 Agent-owned `PromptContributionRegistry`，extension tool 经
availability preflight 后直接注册到最终 session-owned `ToolRegistry`，不可用工具记录在同一 registry diagnostics；plugin hook
settings 注入 session-owned `HookRuntime`。ToolRegistry 返回 exact registration handle，replacement 会使旧 handle 失活，owned
child registry 会在 scope teardown 时 dispose，且不影响 parent registry；HookRuntime/CallbackHookExecutor/AsyncHookRegistry
提供 generation、stop-new、drain、dispose、显式 complete/cancel 和 late completion rejection。仍待完成的是默认 user-role
profile rollout、host/remote retry parity、业务级 pending-hook durable resume/cancel，以及非 Agent-scoped extension provider。

WP11A 已完成 Definition/adapter 迁移。`CompactionPort` 现在只包含宿主无关的 Definition，native provider 独立位于
`context/compaction/NativeCompactionPort.ts`；当前 compaction 的事实边界是：`CompactionPort` 定义 budget/policy/summary/micro/snip/recovery
五类 context-level capability，`createNativeCompactionPort()` 适配现有算法，`CompactionOrchestrator` 是唯一 auto consumer，
`DefaultContextRuntime` 只负责组合和委托，stage-only provider 通过 `withCompactionOrchestrator()` 自动接入同一编排；
context host-module 已可选转发 `try_auto_compact`，并在跨进程时剥离不可序列化的 `budgetEvaluator`；旧的 `CompactionEngine`、`MicroCompactionEngine`、`SnipEngine` 和 `ContextOverflowRecovery` 仍保留为 native provider，
不改变算法和 `AgentLoop.ts` 调用形状。WP11B 的 auto consumer 基础已完成，WP11C 仍未完成全部目标：虽已抽出 `CompactionOrchestrator` 组合 stage provider，
并补齐 deferred completion、replacement append failure compensation 和外围 abort；P2 已补 native command consumer、idle-only admission 和 Gateway deadline abort。尚缺 profile 级 provider 选择、cold-resume/retry 等价以及 remote/sidecar 的完整结果语义。当前已补齐 durable lifecycle bracket：durable context adapter
在每次 auto/reactive compaction 前写入 `compaction_started`，成功或跳过写入 `compaction_completed`，异常写入
`compaction_failed`；领域校验拒绝带未闭合 bracket 的 `turn_result`，但允许无终态的 bracket 作为 crash tail 留待恢复。
同时保留 replacement transaction 的第一段：`control_boundary`
可携带 `replacementMessages`，Transcript writer 以单个 committed event 写入 boundary 与 model-visible replacement
surface；conversation projection 只在该 turn 已完成后呈现 replacement，crash tail 不会暴露半完成 surface；replacement append 失败会关闭 deferred bracket 为 `compaction_failed` 并 abort 外围 TurnRunner，阻止下一次模型 dispatch；旧的
boundary + durable-message transcript 继续兼容。该段不宣称已经完成完整 compaction lifecycle。

E1 `Notebook filesystem consumer` 已完成：`editNotebook.ts` 不再直接依赖 Node `fs/promises`，而是注入
`FsPort` 并与 `read_file`/`edit_file`/`write_file` 在 `createBuiltinRegistry` 中复用同一 provider；validate/execute
路径均复用 `readFile`、`stat`、`writeText` 和 snapshot freshness contract。fake provider、Node provider 对拍、stale
snapshot、非文本 JSON、非 regular file 及 replace/insert/delete 路径均有 focused contract test。E2 `Directory boundary` 已完成基础
实现：`FsPort.readDirectory` 由 Node provider 提供，`walkFiles` 通过注入 provider 递归并固定排序、忽略目录、节点类型和取消语义；E3
`Search execution boundary` 也已完成基础实现：`glob`/`grep`/`ripgrepFiles` 通过共享 `FsPort`/`SubprocessPort` 组合，保留现有
pattern、输出、空结果、mtime 排序、退出码、timeout/abort 错误语义，fake/native 对拍已覆盖。

WP8A 已完成基础 provider seam：`src/agent/sub/SubagentProvider.ts` 定义 named provider、capabilities、run request、
run handle 和 sidechain writer contract；`SubAgentSession.run()` 只负责从当前 scope/provider registry 选择并委托，
原有 child loop 创建、generator 驱动、report normalization 保留在 `runNative()` 作为 native provider 实现。
`SubagentProviderRegistry` 提供唯一 name lookup、generation replacement、stop-new、在途 run lease、drain/dispose；
`AgentRuntimeScope` 增加 provider 与 registry token，`createAgentSession` 在无外部 registry 时组合并拥有 native registry，
在多 provider 且未指定选择时显式失败。外部 scope/provider 不会被隐式接管或释放。已有 contract 覆盖 provider 请求透传、
child scope inheritance/override、publish-first replacement、unregister、provider removal lifecycle、run drain、failure/abort/timeout
和 teardown，且未修改 `AgentLoop.ts`。provider lifecycle 使用独立 typed capability event，不混入 durable Session event。
`SubagentDescriptor` 保留现有 one-shot v1 durable shape，并为 continuable child 增加 v2、detached composition identity；v2
固定记录 registry provider、definition、parent session、label 和解析后的 child model/provider。manager 在 provider 工作前完成字段
校验与 provider 名归一化，materialization 后先将 descriptor 写入 child log，再用同一预分配 turn anchor 调用 `followup()`；因此
`subagent_descriptor` 位于首条 `agent_turn_enqueued` 前。conversation projection 明确忽略 v1/v2 descriptor，checkpoint codec
同时严格验证两版完整字段并拒绝 schema drift；v1 日志保持兼容。
`prepareContinuable` 现在只允许具备 continuation capability 的 provider 参与，调用方 abort 在 admission 前 fail-closed，provider
generation 在 preparation 期间保持 lease，返回值会被复制为 detached、lossless JSON creation spec；因此 provider 不拥有 child
Agent、handle、turn 或 dispose。`AgentTurnInbox` 现由每个 `AgentSession` 持有，从 `agent_turn_enqueued`、
`agent_turn_discarded` 和带 `inboxItemId` 的 `turn_started` 重建唯一跨 turn FIFO；`AgentHandle.followup()` 先提交 durable
admission，再唤醒单一 background pump，返回的 item/turn id 只表示已接受，不是 result handle。`turn_started` 与 FIFO claim
在同一 durable admission 边界完成；start append 失败保留 pending item，direct turn 与 queued turn 共用正确的 idle/drain
边界，dispose 会 stop-new、丢弃未 claim 项并排空 active turn。`SubagentContinuationManager` 已完成 live
ownership/admission 基础：provider preparation 后由 host factory 返回未运行的 child `AgentHandle`，manager 发布 live
activation 后调用该 handle 的 `followup()` 接受首条输入，后续输入沿用同一路径。每个 child 的 start/follow-up/dispose
线性化，durable parent session attribution 不匹配会拒绝；R0.1 进一步要求调用携带 exact parent `AgentHandle`，并以
`directory.get(parent.sessionId) === parent && parent.state === "active"` 授权。provider prepare、host create、descriptor
persistence、host inspect/resume 之后以及 durable enqueue 前都会重新校验，same-id replacement 的旧 handle 会 fail closed。
首条 admission 失败会回滚 handle，manager drain 会阻止新调用、等待已接受的
materialization 并释放全部 activation。首条 admission 失败时，已写 descriptor 但未写 enqueue 的 unpublished child 会被回滚且
child id 不会返回给调用方；该 crash-safe seed 状态不等于已发布 activation。cold-resume core 现已进入同一个 manager：缺少 live
activation 时先由 host `inspect()` 读取 child log，只 fold `sessionId === childSessionId` 的 child-owned 事件，避免把 fork 前缀中的
祖先 descriptor 当作当前 child；随后校验 descriptor 的 durable parent、直接用 v2 composition 调用 host `resume()`，再经既有
`AgentHandle.followup()` admission。该路径不查询 provider registry，并覆盖并发 single materialization、provider 已卸载、调用方
abort、无效/one-shot descriptor 和 admission failure rollback。`AgentHandle.followup()` 也会在 admission tail 后、durable enqueue
前重新检查 cancellation 和 transient authorization，已 accepted input 不受迟到取消或 parent replacement 影响。R0.2 已将 manager/host/tool 接入生产 composition：`createLocalGateway` 构造单一 shared
`AgentRegistry`、`SubagentProviderRegistry`、native provider、`NativeSubagentContinuationHost` 和
`SubagentContinuationManager`；每个 parent session 在 publish 前绑定 exact handle，并把
`subagent`/`send_message` 两个 consumer 注册到 session-owned registry，销毁时逆序撤销并 unbind。
child storage 复用 parent-owned `subagents/<child>.jsonl` 路径；host create/inspect/resume 统一走
`createAgentSessionWithStorageAsync`，cold resume 只读取 child log + descriptor，不查询 provider registry。
真实 Gateway start、进程重建后的 follow-up/cold resume、provider registry unload、tool rejection 和
one-shot parity 均有 focused contract/E2E 证据。R0.3 还将 activation residency 收敛为 `running/waiting/settled`：
waiting observer 只等 child release、新 admitted work 或 dispose 的显式 wake，绝不与已完成的 `whenIdle()` 竞速；
这样避免 nested child 空闲等待 grandchild 时发生微任务自旋。`NativeSubagentContinuationHost` 通过 application-owned
child configurator 调用同一 composition helper，为每个 child scope 安装绑定该 exact handle 的 local port；`maxDepth: 2`
Gateway E2E 覆盖 `root -> child -> grandchild` 启动与 child-first close。R0.4 已补 final-disposal race 的确定性 contract：
follow-up 若输给旧 activation 的 disposal，会等待 disposal 完成后 cold-resume，绝不调用正在释放的 handle。R0.4 只保留
remote/queued provider 与 sidecar parity，不应提前宣称通过。

DSH 对这一段的直接约束是：`prepareContinuable` 只贡献可持久化 seed data，continuation manager 才创建并拥有 child `AgentHandle`；
所有后续 turn 必须进入 child Agent inbox，manager 不得再造第二套 turn queue。provider replacement/unload 必须等待正在执行的
preparation 释放 generation lease；detached spec 一旦返回即由 manager 拥有，后续 materialization 和 cold resume 不再依赖 provider
仍然注册，也不能因 provider replacement 产生孤儿 child。

WP12 已完成第一段 lifecycle 基础：`PilotDeckElicitationChannel` 增加可选 `dispose(reason)` contract；
`GatewayElicitationChannel` 进入 `active -> draining -> disposed` 状态机，dispose 会 stop-new、拒绝该 session 的
pending request、等待在途 promise settle，并保持幂等；`AgentRuntimeScope` 通过 `ownedElicitation` 明确 provider
owner，child scope 只继承不释放 parent-owned channel；Gateway composition 会为 session channel 声明 ownership。
这使 waiting request teardown 不再依赖 Gateway turn 的旁路清理。随后增加 session-owned durable elicitation adapter，
在不记录答案内容的前提下写入 `question_started`、`question_completed`、`question_failed`，领域校验把未闭合 question
视为 crash tail，并在 `turn_result` 前拒绝 pending question；Agent scope 增加 blocked service token，SubAgentSession
明确屏蔽继承的 elicitation provider。ToolRuntime 现通过 session-owned audit adapter 写入
`permission_started`、`permission_completed`、`permission_failed`；权限 provider/hook 异常和 audit append failure 都保持
fail-closed，未闭合 permission 也会阻止 `turn_result`。`GatewayPermissionBus` 现在拒绝重复 `requestId`，registration
可精确 dispose，迟到回答返回 `{ delivered: false }`；hook 支持 abort 和可选 `timeoutMs`，session/turn teardown
会以明确 deny 结算 pending permission。`createLocalGateway` 现在从显式 `permissionTimeoutMs`、
`PILOTDECK_PERMISSION_TIMEOUT_MS` 或 120 秒默认值向 hook 注入 deadline，并由真实 Gateway round-trip 测试覆盖
allow、timeout 和迟到回答。`GatewayElicitationBus` 现在也拒绝重复 `requestId`，注册返回精确 handle，consume/
reject 会使 handle 失活，避免 registration 被静默覆盖；`GatewayElicitationChannel` 的宿主 emit 失败会立即清理并
拒绝 pending request，observer hook 失败会隔离，取消通知则保持 best-effort。Interaction Definition 现增加了
`PilotDeckElicitationAnswerer`，并提供确定性的 headless first-option provider；CLI 的 `autoElicitation` 只负责组合
该 provider，不再内嵌回答逻辑。WP12 已完成 interaction policy 第一段：`src/interaction/InteractionPolicy.ts`
定义 profile 无关的 allow/deny/ask admission，默认对 disabled、prompts-disabled 和 answerer 缺失保持 fail-closed；
permission hook、Gateway elicitation channel 和 headless answerer channel 作为 Consumer 使用该 policy，
`AgentRuntimeScope` 提供 `interactionPolicy` token，子 scope 可继承或覆盖，session composition 默认选择 native policy。
既有 deadline normalization、duplicate/late/abort/teardown 和 durable audit 保持不变。WP12 的 reconnect contract 现由
`InteractionReconnectPort` 承担：Gateway 是唯一 provider，permission/question bus 仅是该状态的 kind projection；binding 为
`connectionId + generation`，断线只移除 current binding 而不结算 pending request，新连接必须给出 exact previous binding
才可取得 replay snapshot，旧 binding 的迟到 reply 必须返回 `delivered: false`。`GatewayWsConnection` 在 close 时保留有
pending interaction 的 active turn，并在 `reconnect_interaction` 返回 current binding 的 JSON-safe request DTO；elicitation
DTO 明确排除 `AbortSignal`，permission tool input 也经过相同 replay materialization。`InProcessGateway.dispose()` 在
Gateway owner 退出时先 reject question、deny permission，再清理 shared reconnect provider，避免悬挂 promise。该 WS contract
由 close/reconnect/stale-reply focused test 覆盖。这里的 Gateway WebSocket RPC 是 application transport projection，
不属于 Module Protocol v2；因此不应把 `reconnect_interaction` 伪造进
`docs/pilotdeck-module-protocol-v2.schema.json`。WP12 已完成 profile-level headless provider 选择与 resume
`ownedElicitation` ownership merge/lifecycle contract；P3-C 已完成 browser dialog auto-restore：真实 TCP WebSocket E2E 覆盖
pending question/permission、exact old binding reconnect、stale reply reject、answer 后 model/tool/complete frame 与 terminal snapshot
清理。deadline selection 已收敛为 `InteractionDeadlinePolicy`；剩余仅为最终 profile/bundle registry。

### 8.2 P4：LLM Provider Registry、Health 与 Composition Reload

P4 的起点是不把已有的 `RouterModelInvocationPort` 误当成 runtime provider registry。
`src/model/providers/registry.ts` 的 `ModelProviderRegistry` 仍只描述 protocol metadata；旧的
`createModelRuntime(config)` 仍是整份 `ModelConfig` 的 compatibility facade。P4-A/B/C 已新增独立的
`ModelInvocationProviderRegistry`、单 route native provider、registry-backed Router invocation/judge adapter，以及按
`providerId + generation` 隔离的 health state。它们保留 canonical request/event 与 Router policy 边界，也不让 Router 或
session consumer 取得 registry 的 dispose owner。

本工作包的目标是保留 canonical request/event 与 Router policy 的既有边界，让 provider route 具备 DSH 式
Definition / Provider / Consumer / Composition 生命周期：

```text
ModelInvocationProviderRegistry Definition
        <- native per-route provider (provider id + parsed ProviderConfig)
        <- Router registry-backed invocation adapter (stream + complete + capability lookup)
        <- health/fallback policy consumer (route generation-aware observation)
Composition root -> stage config snapshot -> publish all routes atomically -> Router
```

`RouterRuntime` 继续只依赖 `RouterModelInvocationPort`（必要时将 `complete` 抽入同一或平行 judge invocation port），
不得直接依赖 registry、`ModelConfig` 或 `createLocalGateway`。registry 的 registration handle 是 route provider 的 owner：同一
route 的 replacement 必须先 publish 新 generation，旧 generation 停止接收新 lease、等待已有 stream/complete lease drain 后才
dispose；unregister 同样 stop-new/drain/dispose。任何旧 generation 的迟到成功、失败或 health 回报都不能污染新 generation。
配置 reload 必须先 stage/validate 全部 provider，再一次 publish；失败则保留完整旧 route table，不能出现半更新。

P4 的执行顺序固定如下，每项单独评审：

| 子包 | 范围 | 不做什么 | 完成信号 |
| --- | --- | --- | --- |
| P4-A Registry Definition（已完成） | route-id lookup、generation、acquire/release lease、register/unregister/replacement/drain/dispose；保留静态 protocol metadata 名称，避免与 runtime registry 混淆 | 不改 Router policy，不引入 transport | 新请求命中新 generation；旧 stream 完成后恰好一次 dispose；remove 后新请求 fail-closed |
| P4-B Native provider + Router adapter（已完成） | 将每个已解析 `ProviderConfig` 组装为 native route provider；registry-backed adapter 实现 stream、complete 与 capability/protocol/base-url 查询；judge 走同一受控路径 | 不改 canonical event、retry/fallback 语义或 session event | 主请求、judge、capability lookup 都不再绕过 adapter；现有 fake `ModelRuntime` 保持 compatibility adapter |
| P4-C Health policy（已完成） | 将 circuit state 作为 Router policy state，key 至少含 project/session scope、route id 与 provider generation，注入 clock；replacement/unregister 清理或隔离旧 generation state | 不把 health 当 durable session truth，不跨项目共享隐式 breaker | 同 provider 新 generation 以健康初态开始；旧 stream 的失败不打开新 generation；fallback/half-open/abort 语义回归通过 |
| P4-D Composition/reload（已完成） | `ProjectRuntime` 已拥有 provider registry 和 session lease；`prepareSessionRuntime()` 取得 lease，并经 `__configure` disposer 在 handle 已停止 admission、active run 已排空后释放。reload 会 stage/validate 全部 cached project snapshot，再原子 publish 新 runtime；旧 runtime 仅 retire，等待 session lease 与 invocation lease 均排空后才 dispose | 不在此包收敛 Profile/Bundle，不修改 `AgentLoop.ts`，不让 session 或 Router 隐式拥有 registry | lifecycle tests 已证明：invalid snapshot 保留旧 runtime；旧 active stream 和旧 session lease 均释放后才 dispose；新 session 使用新 registry；旧 provider 恰好 dispose 一次 |
| P4-D.1 Ownership hardening（已完成） | `reload()` 现按 queue 串行 stage/publish/retire；`buildRuntime()` 在构造失败时回收已取得的 provider/router/plugin/code/background 资源；per-session MCP 以 exact registration owner 追踪，而不是只按 `sessionKey` 覆盖 | 不扩大为 Profile/Bundle，不修改 Router policy 或 `AgentLoop.ts` | focused tests 已证明：第二次 reload 会等待失败 staging cleanup；partial registered provider 恰好释放；dirty recreate 的旧 registration 不能停止 replacement MCP；registry disposal 清理剩余 registration |

P4-A/B/C 已由 registry replacement/unregister/disposer-failure、Router primary/judge adapter、以及 retiring generation
failure isolation 的 focused tests 覆盖。P4-D 现已覆盖：invalid snapshot 不替换旧 runtime；reload 时旧 active
stream 完整结束；新 session 命中新 registry；最后一个旧 session close 后旧 provider 恰好一次 dispose。P4-D.1 已覆盖
并发 reload 的线性 publish、partial staging cleanup 和 dirty session MCP exact ownership；释放或 disposer 失败不得阻塞其他
retired runtime，pre-content fallback、abort 和 cache material 保持不变。native contract 通过后，remote/sidecar provider parity
仍属于部署 gate，不能因 registry 完成而宣称已完成。

WP15 建立在已完成的 10C-C 之上。WP15-A 已将 `PluginRegistry/PluginRuntime` 的 frozen contribution
snapshot 收敛为可释放 lease：`replaceAll()` 先发布新 generation，旧插件实例按 object identity 而不是 name/source key
退役；有 session 持有旧 snapshot 时不阻塞新 session 选择新 generation，只有对应 AgentHandle dispose/rollback 释放 lease
后才执行旧实例 disposer。WP15-B 已增加 `TelemetryObserverRegistry` 和 `createObservingTelemetryClient`：observer 的
registration handle 以 generation 替换，旧 observer 先 stop-new、等待已开始的 async observe drain，再调用 disposer；
observer callback 失败只进入 typed diagnostics，绝不改变 telemetry caller 或 durable Session 真源；local Gateway 关闭时先
dispose registry，再关闭自有 telemetry provider。`HookRuntime`、`CallbackHookExecutor`、`AsyncHookRegistry` 继续提供
generation、stop-new、drain/dispose、single-flight refresh、显式 async-hook complete/cancel 和 late completion rejection。
剩余工作不是再增加 transport，而是定义业务级 pending hook 的 durable resume/cancel，并将 plugin reload/removed command 与
MCP/LSP provider 纳入同一 generation-aware ownership 模型；scope-filtered live event carrier 已由 R1.2 完成。

### 8.1 工作包 9 的执行拆分

WP9 是状态真源迁移，不应在一个改动中同时改日志格式、AgentSession 状态和 Web 展示。按以下顺序执行：

| 子包 | 范围 | 兼容边界 | 完成信号 |
| --- | --- | --- | --- |
| 9A Log envelope validation（已完成） | `SessionEventLogValidation` 由 `SessionRuntime.restore()`、`appendRecorded()` 和普通 append commit 共用；检查 safe integer sequence、严格递增但允许 gap、已存在 `entryId` 的非空与唯一性、`parentEntryId` 类型和 self-parent | legacy entry 可以没有 `entryId`；branch 是合法拓扑；missing parent/orphan 保持兼容；不要求 sequence 连续 | focused tests 已覆盖非法 sequence、重复 id、self-parent、recorded regression、事务式 restore，以及旧 fork/replace/orphan 兼容 |
| 9B Durable domain vocabulary（已完成） | 增加 turn/step boundary、request snapshot/context、model chunk/final、tool call/result 和 inbox splice 等事件；producer 先写 durable fact，再更新对应 live projection | 保留现有 entry type 作为 schema-v1 compatibility；未知 event 明确忽略；不把所有 live `AgentEvent` 自动持久化 | request/model/tool/inbox 顺序、failure barrier、legacy/crash-tail 和外部 runner compatibility 已有 focused tests |
| 9C Projection consumption（已完成） | `AgentSession` messages、usage、permission denial 和 reload metadata 改读一致 live projection snapshot；Web incomplete-turn 查询改由 Web projection 提供 | 无 projection provider 的自定义 transcript 保留 legacy fallback；fork/replace 仍是显式 command/migration consumer | storage-backed 与默认新建内存 session 使用 projection 真源；live/cold、Gateway replace 与 Web history focused tests 通过 |
| 9D Checkpoint persistence（已完成） | 定义 projection checkpoint wire envelope、版本、水位、原子写/读和失效回退；作为独立 projection-cache seam 接入 session storage，而不是并入 authoritative event persistence | checkpoint 只是可丢弃缓存，事件日志始终权威；version mismatch、越界 watermark、anchor mismatch、损坏内容回退 replay | checkpoint + tail 与 full replay 等价；删除/损坏 checkpoint 不影响恢复；turn-end/dispose 写入失败不影响 session 正确性；Node 22 相关回归通过 |

WP9A 已将破坏事件身份或顺序的问题设为拒绝条件，并保持历史拓扑兼容。尤其没有把 DSH 的 contiguous `seq` 约束直接
套到 PilotDeck：当前 `restoreState()` 和部分迁移路径允许 sequence gap，现有 TranscriptChain 也明确容忍 branch 和
missing-parent orphan。领域平衡校验依赖 WP9B 的新事件词汇，不能提前从旧 transcript entry 猜测。

WP9D 的最终架构决定如下：

1. checkpoint 是独立的 projection cache，不扩张 `SessionPersistence` 的 authoritative event-log 职责；
2. 已新增 envelope、精确 log anchor、JSON 原子替换 store 和 InMemory store；缺失或损坏内容按 cache miss 处理；
3. 默认 transcript、file-history 和 Web projection 均提供严格 codec，`ProjectSessionStorage` 实现
   `event log flush -> checkpoint save`；
4. restore 只在 session、format/version、水位和 anchor 均匹配时接受 checkpoint，然后 replay tail；任何失败回退 full replay；
5. turn result 和 storage dispose 是强制尝试写入点，但 cache 写失败必须 fail-soft，不得使事件日志或 resume 失败。

WP9B 没有照搬 DSH event 名称，而是覆盖同等事实。当前事件覆盖可用于从 committed log 重建：

```text
request = latest request header/context
        + projected model-visible surface
        + claimed inbox input

execution state = turn boundary
                + step boundary
                + model stream/final outcome
                + tool call/result pairing
```

WP9B 的 durable vocabulary 和提交点如下：

| Durable fact | 建议 entry | 必须发生在 |
| --- | --- | --- |
| turn 打开 | `turn_started` | 对外发布 live `turn_started` 之前 |
| step 打开/关闭 | `step_started` / `step_completed` | 最终模型请求提交前；下一 step 或 turn 终态发布前 |
| 动态 request context | `context_snapshot` | 对应 step 的 `model_request` 前；写入 prompt generation 与有序 context snapshot |
| workspace instructions | `agent_instructions` | 对应 step 的 `model_request` 前；首次为 baseline，后续只写 set/replace/remove change |
| 最终模型输入 | `model_request` | `ModelInvokerPort.stream()` 调用 provider 之前；保存最终 `prepared.request` 完整 canonical snapshot |
| canonical stream | `model_stream_event` | 对应 event 交给 AgentLoop 之前；剔除 provider-specific `raw` |
| 工具副作用边界 | `tool_call` | `ToolPort.executeAll()` 调用 delegate 之前 |
| 工具执行结果 | `tool_result` | 结果返回 AgentLoop 之前；与现有 model-facing `tool_result_message` 分工明确 |
| steer mailbox | `inbox_mutation` | insert/cancel/claim/discard 修改内存 mailbox 之前 |
| compaction 生命周期 | `compaction_started` / `compaction_completed` / `compaction_failed` | provider 调用前、provider settle 后或异常路径；未完成 bracket 只能作为 crash tail，不能随 `turn_result` 关闭 |
| compaction surface replacement | `control_boundary.compact_boundary`（携带 `replacementMessages`） | lifecycle completed 后、模型继续使用新 surface 前；boundary 与 replacement 必须同一 committed event |
| permission evaluation/approval | `permission_started` / `permission_completed` / `permission_failed` | ToolRuntime 开始权限评估前、最终决策确定后或 provider/hook 异常路径；未完成 bracket 只能作为 crash tail，不能随 `turn_result` 关闭 |
| turn 关闭 | 复用 `turn_result` | 对外发布 live `turn_completed` 之前 |

实现已新增 session-owned recorder，并在 composition root 给 Model/Tool port 加 decorator，未把持久化逻辑塞回
`AgentLoop.ts`。`TurnRunner` 已在 live `turn_started` 前提交 durable start，并在 live `turn_completed` 前提交
`step_completed` 与 `turn_result`。Model decorator 在 `stream()` dispatch 前写最终 request，每个 canonical event 去除
provider `raw` 后先持久化再交给 AgentLoop；Tool decorator 在副作用前写 call，在结果返回 AgentLoop 前写 result；
ToolRuntime 通过 permission audit adapter 在决策前后记录 permission lifecycle，provider/hook failure 记录失败事实。
Gateway -> SessionRouter -> AgentHandle -> AgentSession -> mailbox 的 steer/cancel mutation 已异步化；mailbox 使用同一串行
mutation queue，并以 offer/claim/ack 模型保持终止边界线性化。

WP9B 已定义 failure semantics：`model_request` 提交失败时不得 dispatch provider；`tool_call` 提交失败时不得开始
副作用；stream/result 提交失败时停止继续消费并让 turn 进入可恢复错误；domain validator 对新 vocabulary 校验
turn/step/tool pairing，但纯 legacy 日志仍走兼容路径。完整 request snapshot 是 PilotDeck 当前阶段的必要过渡事实，因为
recovery prompt、materialize 和 context rewrite 尚未全部有独立 durable event；后续 surface/context contribution 闭环后再评估
是否缩减为 DSH 式 request header + derived surface。

WP9B 最小验证集已覆盖：request/chunk/tool/result 的顺序；tool call 在副作用前提交；request/tool-call 持久化失败阻止
provider 或 tool dispatch；inbox insert/cancel/claim/discard；open step 和 dangling tool call 的 crash recovery；legacy-only
日志兼容；native port 与 `__agentLoopFactory` 外部 runner 行为兼容。

即使 WP9D 已完成，projection checkpoint 也不可成为 resume 必需输入。`AgentSessionState`、`SessionMetadataStore` 和
Transcript replay facade 暂作为无 projection provider、旧 factory 与迁移命令的兼容层保留；删除前必须证明仓库内无 fallback consumer。

近期执行优先级固定为 `P4-E.1 ExecutionWorldBundle ownership（已完成） -> P4-E.2 sandbox（Node `FsPort` mutation fence、macOS `execute_code`
与 foreground/detached shell 已完成；Linux/Windows process provider、Agent terminal tool 与 task reconnect 待补） -> P4-E.3 余下 LLM policy 与已启用部署的 parity gate -> P5 非 Agent-scoped provider lifecycle /
telemetry -> P6 Profile/Bundle/Boot`。P0 remote/sidecar subagent、P1 host/remote prepared-request retry 和 P2
compaction profile/retry/parity 均是按部署形态启用的 gate，不阻塞 native 主线。Interaction P3-A/B/C 的
profile composition、ownership 和 bridge replay，以及 10C-C contribution lifecycle 均已完成，是这条路径的既有基座。
跨 turn Agent inbox、live manager ownership/admission、continuable descriptor 和 provider-independent cold-resume core 已完成；
R0.1 exact live-parent identity、R0.2 concrete deployment host/tool、R0.3 settlement/child-first graph/native nested consumer 与 R0.4 final-disposal race 已完成；下一步仅按需补 remote/sidecar parity gate，之后处理 admission/profile、user-message profile 的
composition 接入与 plugin contribution scope binding，然后进入 Compaction policy/replacement；Execution 与 LLM policy 在共同依赖稳定后
可以分支并行。在 contribution registry 完成前，不应把 prompt 拼接逻辑分散到更多调用方；在动态 context/instruction
durable 化前，不应把 `model_request` 完整快照删减为较弱的 header；在 Session 真源闭环前，不应删除 legacy transcript facade。
本分支继续遵守约束：不修改 `src/agent/loop/AgentLoop.ts`，优先通过 port、adapter、session facade 和
composition root 外围演进。

## 9. 迁移与兼容策略

1. 采用 strangler pattern：先定义 seam 和 adapter，再迁 consumer，最后删除 legacy path；
2. 现有 public facade、Transcript JSONL 和 Gateway API 在各阶段默认兼容；
3. 每个新 provider 先以 shadow/dual projection 对比，不双写两个状态真源；
4. 通过 composition flag 选择 legacy/new provider，flag 不进入 AgentLoop 业务逻辑；
5. provider replacement 使用 generation，迟到结果只可完成旧 handle，不得进入新 scope；
6. replay schema 只做向前兼容追加；破坏性迁移必须有独立 migration 和回滚样本；
7. 删除 legacy API 前必须证明仓库内无 consumer，并经过至少一个发布周期。

## 10. 验收矩阵

| Gate | 每阶段最低要求 |
| --- | --- |
| Contract | 同一套 provider contract tests 覆盖 native 和 host/remote adapter |
| Lifecycle | register、replace、cancel、drain、dispose、double dispose、late result |
| State | append、flush、crash/restart、replay、unknown event、projection version |
| Durable truth | 每项模型可见输入和 turn/step/tool 控制事实可由 committed log 重建；无旁路状态真源 |
| Scope | parent inheritance、child override、deny、isolation、resource cleanup |
| Publication | unpublished setup 不可被观察；setup/commit 失败完整回滚；provider unload 排空其创建的 handle |
| Behavior | normal text、tool loop、model error、tool error、abort、max turns |
| Compatibility | 旧 Transcript、旧 factory facade、Gateway/API、CLI |
| Parity | native vs sidecar canonical trace 无未解释 semantic diff |
| E2E | 至少一个真实 Gateway session；涉及 transport 时增加真实 sidecar deployment |

验证应遵循由小到大的顺序：contract/unit -> session replay -> native integration -> sidecar parity -> Gateway E2E。
只有共享行为或 composition 发生变化时才扩大到全量测试。

## 11. 风险与回滚条件

出现下列任一情况时停止扩大迁移范围并切回上一 provider/facade：

- 同一 Session 出现两个 durable state owner；
- replay 后 messages、usage、metadata、permission denial 或 file state 不等价；
- dispose 后仍接受新调用，或旧 provider 的迟到结果污染新 generation；
- subagent 获得 parent profile 明确禁止的 capability；
- native/sidecar 出现无法由 transport 字段解释的 semantic diff；
- 新 profile 只能通过修改 AgentLoop 状态机才能维持旧行为；
- plugin reload 导致在途 turn 的 contribution snapshot 改变。

回滚优先使用 composition flag 和兼容 adapter，不回写或降级用户已有 Transcript。

## 12. 非目标

- 不照搬 Cordis API、包粒度或仓库布局；
- 不为每个 DSH package 在 PilotDeck 创建对应目录；
- 不把每个能力都变成 HTTP/stdio sidecar；
- 不引入第二套 Session、Turn、Run、Transcript 或 operation 状态；
- 不在本 roadmap 中重写 AgentLoop 状态机；
- 不把 StaffDeck 的 TaskFrame、Harness、SOP 或租约字段纳入 PilotDeck core contract；
- 不以“文件已移动”或“增加接口但 consumer 仍依赖具体实现”作为完成标准。

## 13. 完成定义

PilotDeck 达到本 roadmap 的目标，不以 package 数量判断，而以以下结果判断：

1. 新 agent/session 可以由 profile 组合，无需复制 registry 或手工 new 整套 runtime；
2. 所有核心 capability 均有明确 Definition、Provider、Consumer、scope 和 dispose owner；
3. 模型可见输入、turn/step/tool 控制事实和 durable session state 可仅由事件日志和版本化 projection 重建；
4. provider 可在不修改 AgentLoop 的情况下替换，并能安全 drain/dispose；
5. subagent 通过 child scope 获得最小能力集，不依赖工具名黑名单；
6. agent create/resume 在发布前完成 scoped setup，失败时原子回滚，provider unload 可排空其创建的所有 handle；
7. native、sidecar 和 Gateway 路径共享 contract，并保持可解释的行为对拍；
8. transport adapter 可选，业务模块不依赖 transport。

## 14. 2026-09-10 审计收敛

本节是对本 roadmap 的执行版结论。它把 DSH 已经证明的架构性质与 PilotDeck 当前代码证据分开，避免把“存在一个 Port”或“存在一个目录”误判为完整模块化。

### 14.1 对照结论

| DSH 必须具备的性质 | PilotDeck 当前证据 | 判定 |
| --- | --- | --- |
| scope identity 同时决定可见性、事件路由和 effect owner | `src/agent/scope/ScopedServiceRegistry.ts`、`AgentRuntimeScope.ts`、`AgentScopeLiveEventBus.ts` 已有 parent/child、override、generation、stop-new、drain、dispose 与 exact/ancestor-only live event routing；session-owned prompt/tool/hook 已接入同一 frozen extension generation，通用 contribution layer 尚未统一 | native M2，未完成 DSH 全量等价 |
| Agent-scoped extension contribution 可冻结、替换和释放 | `PluginRuntime.snapshotContributions()` 在 session composition 固定一代 extension；`registerExtensionPromptContributions()`、`registerAvailableExtensionToolContributions()` 与 session-owned `HookRuntime` 分别将 prompt/tool/hook 接入最终 owner；ToolRegistry 保持唯一 schema 真源，HookRuntime 支持 stop-new/drain/dispose 与 async complete/cancel | 10C-C 已完成 |
| Session append-only log 是真源，projection 可丢弃并重建 | `src/session/events/SessionRuntime.ts` 拥有 sequence/commit；`src/session/persistence/` 与 `src/session/projection/` 已分层并支持 checkpoint + tail/full replay | 基础闭环已完成，core Session 仍保留 legacy fallback |
| Agent create/resume 在 publish 前 setup，失败完整回滚 | `src/agent/scope/AgentFactoryProvider.ts`、`AgentRegistry.ts`、`AgentHandle.ts` 已实现 unpublished setup、同步 publish、rollback、provider unload drain | 当前 M3 |
| interaction 的 policy、answerer、audit、teardown 分离 | `InteractionProfile` 已将 Gateway、deterministic 和 disabled/fail-closed provider 选择接入 config/local Gateway；`ProfiledPermissionDecisionPort` 只 fail-close 原本的 ask；`InteractionPolicy`、`InteractionDeadlinePolicy`、durable audit 与 Gateway-owned reconnect 仍保持各自 owner。resume 会透传 `ownedElicitation`；bridge 已以真实 WS 覆盖 DTO replay、exact-binding reconnect、旧 binding 拒绝、当前答复与 terminal replay | M2，P3-C 已完成 |
| subagent 是 named provider，continuation 与 Agent ownership 分离 | provider/registry 已提供 generation lifecycle 和 detached preparation；Agent inbox 已提供 durable FIFO；`SubagentContinuationManager` + `NativeSubagentContinuationHost` 已持有 live child handle，并覆盖 materialize、v2 descriptor persistence、initial/later admission、durable parent attribution、exact live-parent authorization、parent-owned JSONL、provider-independent cold-resume、rollback、settlement、child-first drain、final-disposal race 和 Gateway consumer；child configurator 为 nested handle 安装精确 port，并由 `maxDepth` capability gate 限制 | R0.3 native M3；remote/queued provider、sidecar parity 尚缺 |
| profile/bundle/boot 负责 provider 选择、patch 顺序和启动回滚 | `ProjectAutomationBundle`、`ProjectRuntimeResourcesBundle`、`LocalGatewayLifecycleBundle`、`PilotDeckServerShutdownBundle`、`ChannelAdapterBundle`、`SessionInteractionBundle`、`SessionToolCompositionBundle`、`SessionContextRuntimeBundle`、`SessionFileHistoryBundle`、`SessionPlanTodoBundle`、`SessionSubagentTranscriptBundle` 和 `SessionSubagentContinuationBundle` 已拆出 native composition/rollback owner；R5.32 以 `PilotDeckRuntimeProfile` 将 sandbox、runtime-context 与 interaction 的 project-generation selection 收敛为不可变配置；`createLocalGateway.ts` 仍集中其它 session composition，尚无跨 native/headless/sidecar/Gateway 的完整 deployment profile/boot contract | native M2；完整 DSH profile/boot 仍待收敛 |

### 14.2 当前执行顺序

```text
native 主线： P3-A 12 interaction profile/provider selection（已完成）
                 -> P3-B resumed channel ownership/disposal（已完成）
                 -> P3-C browser replay projection（已完成；不新建 pending state）
                 -> P4-A/B/C 14 LLM registry/Router adapter/generation health（已完成）
                 -> P4-D ProjectRuntime lease + atomic reload（已完成）
                 -> P4-D.1 reload/staging ownership hardening（已完成）
                 -> P4-E.1 13 ExecutionWorldBundle ownership（已完成）
                 -> P4-E.2 enforcing sandbox（macOS `execute_code` + foreground/detached shell 首段已完成）/ UI interactive terminal lifecycle（R4-B.1 已完成；Agent terminal tool、task reconnect、Linux/Windows provider 待）
                 -> P4-E.3 13/14 余下 policy 与部署 parity
                 -> P5  15 非 Agent-scoped extension provider lifecycle / telemetry
                 -> P6.0 R5.8 SessionInteractionBundle（已完成）
                 -> P6  16 Profile/Bundle/Boot

部署/组合 gate： P0  remote/sidecar subagent parity（按需）
                 + P1  host/remote prepared-request retry parity
                 + P2  compaction profile selection、cold-resume/retry contract、remote/sidecar parity
              它们按具体部署形态验收，不阻塞已完成的 P2 native command 或 P3 的 native 开发。
```

不得跳过前置 contract：

1. `8A` 的跨 turn inbox、live manager ownership/admission、continuable descriptor、cold-resume core、R0.1 exact live-parent identity、R0.2 concrete deployment host/tool、R0.3 settlement/child-first graph/native nested consumer 与 R0.4 native final-disposal race 已完成；剩余仅是按实际部署需求补 remote/sidecar/queued provider parity gate，不阻塞 native 主线。manager 必须继续调用现有 `followup()`，不得新增第二套 turn queue。
2. `10C-C` 已完成：每次 session composition 固定一代 extension snapshot，prompt/tool/hook 分别注册到 session-owned
   `PromptContributionRegistry`、最终 `ToolRegistry` 和 `HookRuntime`；reload 后旧 generation 只能完成已获准的在途工作，不能污染后续 turn。当前 P1 只收尾 `10C-A/B`：生产默认 profile 已切到 `user_message`，剩余是证明 host/remote provider 复用同一 prepared request；`AgentLoop.ts` 不修改，保留 `model_request` 完整快照和 legacy facade。
3. `11` 只允许通过 `CompactionPort` 选择 policy/provider；command、auto、overflow 必须共享同一 durable bracket/replacement 语义，并验证 abort、timeout、retry、restart 等价。
4. `12` 统一 `allow/deny/ask/cancel/timeout/reconnect` 结果词汇；没有 answerer 时必须 fail closed，pending request 必须由 session/agent owner stop-new、drain、dispose。Gateway reconnect 已要求 exact previous binding、拒绝 stale reply，并在 owner shutdown 结算 pending request；P3-A 已通过 profile 选择 headless provider，P3-B 已让 resume 透传 elicitation ownership。P3-C 的 browser dialog auto-restore 不得创建第二套 pending state。
5. `13/14` 复用既有 scope 与 Session contract；不得把 Fs/Subprocess/Sandbox 或 retry/token policy 再塞回 `AgentLoop.ts` 或 `AgentRuntimeDependencies` 的无界字段。
6. `15` 只处理已完成 10C-C 之外的 extension 工作：业务级 pending-hook durable resume/cancel、telemetry 与非 Agent-scoped command/MCP/LSP provider。Agent-scoped event carrier 已由 R1.2 提供；其余能力只可在相同 ownership 模型下演进。R5.8 已独立收敛 session interaction composition，不等待未获批的 pending-hook durable contract。

### 14.3 近期可交付切片

| 切片 | 目标 | 最小退出门槛 |
| --- | --- | --- |
| P0 · Subagent continuation parity（按需） | 在已完成 R0.1-R0.4 native closure 之上，补 remote/sidecar/queued provider parity | provider 只返回 detached seed；manager 不建 queue，initial/follow-up 全部调用 Agent inbox；cold resume 仅依赖 child log + exact live parent authorization；parent close/recreate 先递归释放 child；native nested Gateway E2E 与 final-disposal race 已通过；remote/sidecar provider parity 按部署需求通过；失败/取消/超时/未知终态不映射为成功 |
| P1 · Prompt/Context parity（部署 gate） | 将 `user_message` 设为默认 runtime-context profile，并使 host/remote provider 遵守 native 已验证的 prepared-request retry contract；保持 10C-C 的 frozen contribution lifecycle | 默认/host/remote 的 live/restart/replay request material 等价；第一次 provider attempt 后的 registry 更新只影响下一 request；不修改 `AgentLoop.ts`，且 `model_request` 保持完整快照 |
| P2 · Compaction contract（native command 已完成） | native `/compact` command、idle-only maintenance admission、timeout abort handoff 与 durable terminal result 已完成；后续收敛 profile provider selection、cold-resume/retry contract 与跨部署 parity | success/skip/failure/abort/busy 由 durable log 与 Gateway 一致判定且不物理删除原始 tool result；restart/retry 需先明确是否 materialize live session；Gateway command 不进入 LLM request |
| P3 · Interaction composition（已完成） | P3-A 已将 policy/deadline/reconnect 组合进 `interactive`/`headless`/`disabled` profile；P3-B 修复 resumed channel ownership；P3-C bridge 已基于 replay DTO 恢复 dialog，消费 active/terminal snapshot | resumed session 的 owned channel stop-new/drain/dispose；profile 缺失 answerer 时 fail-closed；bridge 用 exact previous binding 重连，只消费 Gateway replay snapshot；真实 WS 已证明 permission/question 的当前 binding 答复、后续 model/tool event 与终态可见，不创建第二套 pending state 或第二条 turn stream |
| P4 · Execution/LLM seams | P4-A/B/C 已完成 runtime provider registry、Router/judge adapter 与 generation-aware health；P4-D/D.1 已完成 `ProjectRuntime` session lease、retire/drain、原子 config reload、serialized staging cleanup 和 per-session MCP exact ownership；E7 已将 execution-world 资源 owner 从 `ProjectRuntimeRegistry` 手工列表收敛为单一 disposable bundle。E5-C 已以 Node `SandboxedFsPort` 限制 direct filesystem mutation，并在 macOS 对 `execute_code`、foreground/detached shell 实施 process enforcing sandbox；R4-B.1 已完成 UI PTY/socket lifecycle。下一步只处理有真实 consumer 的 Agent terminal tool Definition、task reconnect、目标平台的 process sandbox，以及剩余的 provider/deployment parity；不再把“interactive terminal”笼统列为未拆分模块 | native/host 结果与 canonical trace 等价；reload 不切断旧 active session/invocation；新 session 只使用新 runtime；最后一个旧 lease 后 provider 才 dispose；并发 reload 无交错 publish/retire 且 staging 不泄漏资源；bundle partial-build/dispose 恰好一次；隔离 profile fail-closed；abort/timeout/cleanup 与 ToolScheduler 并发语义不变 |
| P5 · Non-Agent-scoped extensions | WP15-A 已完成 extension snapshot lease 的 generation/instance retirement；WP15-B telemetry 首段已由 Gateway-owned typed observer registry 完成 registration/replacement/drain/dispose 与 failure isolation；Agent scope live event carrier 已完成；后续为 plugin reload、command、MCP/LSP 定义 provider owner、generation refresh 和 business pending-hook durable resume/cancel | 已证明旧 plugin instance 会等持有 snapshot 的 session release 才 dispose；observer replacement 不接收后续 event，旧 async callback drain 后才 dispose，失败不改变 telemetry caller。完整 P5 仍要求 reload、removed provider、scope isolation 和 pending-hook resume/cancel 均无跨 session 泄漏或第二真源 |
| P6 · Composition | 将 `createLocalGateway` 的手工 wiring 逐步下沉为 profile/bundle，并保留兼容 facade；transport 只按部署需求附加 | 缺失 provider 有诊断；启动失败逆序回滚；native/headless/sidecar/Gateway 共享 Definition，且没有第二套业务状态 |

### 14.3.1 P2 的最小可交付设计

DSH 的 `dsh-command-compact` 只是 human-command adapter：它在 agent idle 时调用 compaction service，不能拥有
另一套 compaction state，也不能把 `/compact` 当作普通 user message 送入模型。PilotDeck 已让
`CompactionPort`、`CompactionOrchestrator`、durable bracket/replacement、session-owned command consumer 和
idle maintenance owner 复用同一条链路；P2 的已完成 native 三段如下：

| 顺序 | 改动边界 | 实现约束 | 退出门槛 |
| ---: | --- | --- | --- |
| P2.1（已完成） | Manual force policy | `CompactionAutoCompactInput` 已增加显式 manual-force 语义；只绕过 auto threshold，仍要求 budget 与 summary provider；orchestrator 向 summary 传入 `trigger: "manual"` | 低于自动阈值仍可手动 compact；缺预算/summary 明确 skip；auto/reactive 测试保持等价 |
| P2.2（已完成） | Agent/session maintenance consumer | `AgentHandle.runMaintenance()` 与 follow-up 共用 admission tail；`ManualCompactionController` 为 session-owned consumer，并由 `AgentSession.compact()` 调用 durable context runtime | 成功路径为 `turn_started -> compaction_started -> replacement boundary -> compaction_completed -> turn_result`；失败/取消写平衡 `compaction_failed -> turn_result`；replacement append failure 不会宣告成功，replay 只采纳完成 turn |
| P2.3（native 已完成） | Gateway command projection | `/compact` 只经 `SessionRouter.compact()` 路由既有 handle；Gateway 不创建 session、不保存 history/replacement、不发模型主请求。deadline 传为 maintenance-owned abort signal，Router maintenance reservation 阻止并发普通 turn | busy、skip、success、abort、timeout、failure 由 Gateway 回复与 durable log 一致判定；仍缺 profile provider selection、remote/sidecar parity 和 provider replacement/drain 跨部署验证 |

P2 的 focused test 至少覆盖：manual below-threshold、manual trigger propagation、maintenance busy/cancel/FIFO、durable
lifecycle/replacement/replay，以及 Gateway `/compact` 不发起模型调用。它不修改 `AgentLoop.ts`，也不在 Gateway 建立
第二份 session/context surface；Gateway 仅为 session-owned controller 的 transport projection。

### 14.3.2 P3-C 的浏览器重连投影

P3-C 是 application consumer 的补齐，不修改 `InteractionReconnectPort`、`GatewayElicitationBus`、
`GatewayPermissionBus` 或 Session durable audit 的 owner。当前 bridge 实现已让 Node 侧
`GatewayWsClient`/`RemoteGateway` 只读暴露 server-issued binding；`ui/server/pilotdeck-bridge.js` 在重设远端 Gateway 前
保留该 binding，在新 `hello_ok` 后调用 `reconnect_interaction`，并把 JSON-safe permission/question DTO 映射为既有 UI frame。
它不注册 pending request、不重发审计、不另建 turn queue。原 `submit_turn` stream 会随 socket 关闭失败，因此 Gateway
在 turn 结束后保留同一份 bounded replay buffer 的短时 terminal snapshot；bridge 在成功 reconnect 后读取并轮询
`active_turn_snapshot`，在清除本地 active state 前投影新增 terminal event。真实 WS 对 permission/question 都已验证
旧 binding 拒绝、当前 binding 答复、model/tool event 与 terminal frame；durable transcript 仍是 grace window 到期后的真源。

| 顺序 | 改动边界 | 实现约束 | 退出门槛 |
| ---: | --- | --- | --- |
| P3-C.1（已完成） | Binding 透传 | `GatewayWsClient.interactionBinding` 已只读暴露 `hello_ok` binding，`RemoteGateway` 只读转发；bridge 在 reset 前保留旧 binding，在新 `hello_ok` 后将其作为 `previousBinding` 调用 `reconnectInteraction(sessionKey)`。`nextBinding` 仍只能由 `GatewayWsConnection` 注入 | 不由 bridge 构造/猜测 binding；无旧 binding 或 binding 不匹配时得到 `stale_binding`，不得投影或提交 answer |
| P3-C.2（已完成） | 单一重连协调器 | bridge 只为可能仍有 active turn 的 session 发起一次、去重的 reconnect；接收返回的 JSON-safe request DTO 并映射为现有 permission/question UI frame。DTO 是 view，不注册 `GatewayPermissionBus`/`GatewayElicitationBus` 或写 Session event | 同一 requestId 在 reconnect 多次时不重复展示/不重复创建 pending promise；permission 与 elicitation 的 answer 继续走既有 Gateway RPC |
| P3-C.3（已完成） | Active-turn 事件恢复 | Gateway active replay 在 terminal 后保留 30 秒，同一稳定 event buffer 不会因 pending interaction 结算而移动 cursor；bridge 先投影 active snapshot，之后轮询 terminal snapshot 并在投影新增 event 后清理本地 active state | replayed dialog 的 answer 后，model/tool/terminal event 连续可见；terminal grace window 结束后只读 durable transcript，不建立第二事件流 |
| P3-C.4（已完成） | 端到端契约 | `bridge-interaction-reconnect.spec.ts` 启动真实 Gateway TCP WebSocket，在 pending permission 和 pending elicitation 两种场景分别关闭第一 socket；新 bridge 连接重放 DTO、当前 binding answer 成功、旧 binding 返回 `delivered: false`，并验证后续 model/tool/complete frame | 不新增 Gateway pending state、durable audit 或 turn queue；Gateway shutdown/timeout/session dispose 仍由既有 owner 结算 |

P3-C 选择 bridge 做 coordinator，因为现有 Web 生产路径持有的是 `RemoteGateway`，而
`GatewayBrowserClient` 的 `interactionBinding` getter 尚未接入该路径。除非 Web UI 自身改为直接持有 browser client，
不要并行实现两套 reconnect owner。`active_turn_snapshot` 仍不是 continued subscription，但短时 terminal replay 已保证
断线回放到 UI 的收敛；若后续 UI 的延迟/负载无法接受有界轮询，再单独评审 attach/resume stream，而不是回退到第二 owner。

### 14.3.3 下一组可直接开工的 PR

为避免把“Execution World”作为一个过大的工作包，后续按以下顺序拆成可单独回滚的 PR。每个 PR 都要同时提交
Definition、Node provider、Consumer 注入、composition wiring 和 contract test；只迁移调用点而不补 owner/lifecycle
的改动只能标记为 M1 兼容层。

| 顺序 | PR 目标 | 具体范围 | 退出门槛 |
| ---: | --- | --- | --- |
| E1（已完成） | Notebook filesystem consumer | `editNotebook.ts` 已注入 `FsPort` 的 `readFile`/`stat`；`readNotebook.ts` 复用同一 provider；保留 JSON 错误、snapshot/stale-write 和 `file_not_found` 语义 | fake `FsPort` 可驱动 validate/execute；Node 与旧结果等价；abort/非 regular file 有 contract test |
| E2（已完成） | Directory boundary | `FsPort` 已扩展 `readDirectory` 并迁移 `walk.ts`；已明确 symlink/other 节点、忽略目录、排序、取消和权限错误语义 | `walk` 的 fake/native provider contract 通过；glob 的 ripgrep provider 语义保留并留待 E3 搜索边界；provider replacement 和 dispose 不泄漏句柄 |
| E3（已完成） | Search/checker execution boundary | `grep`/`ripgrepFiles` 的文件探测已走 `FsPort`，ripgrep 与 syntax checker 子进程走 `SubprocessPort.executeFile`（含 stdin）；搜索/诊断输出格式仍由 Consumer 拥有 | fake filesystem + fake subprocess 对拍已通过；空结果、mtime 排序、abort、timeout、signal exit、checker stdin 和 provider missing capability 已覆盖；partial output/missing target 的更细粒度 replay 留给后续 provider parity |
| E4（部分完成） | Attachment/Spill ownership | E4-A 已抽出 `AttachmentPort` reader；E4-B 已抽出 `ToolResultSpillPort`，由 project composition root 选择 provider 并补齐 fake-provider contract；E4-C browser upload 已以 `UploadStore` source artifact + hard-link Gateway turn lease 完成跨进程 retention race。后续只在存在非 browser 的 durable binary product caller 时定义通用 attachment session owner、dedupe、retention/query | 文件产物可从 durable reference 重建；spill 失败不污染模型消息；browser upload 的 UI cleanup 不能破坏已接纳 turn，normal release 与 crash TTL cleanup 均可验证 |
| E5（部分完成） | Code runtime / sandbox | E5-A 已完成 `ExecutionWorkspacePort`；E5-B 已完成 `CodeRuntimePort` 的 interpreter resolve、Python child run、bounded stdout/stderr、timeout/abort/kill 及 stop-new/drain；E5-C 已完成 per-call `SandboxPolicy`、`agent.sandboxMode` 到 execution-world bundle 的组合、macOS Seatbelt provider 与 fail-closed unavailable path。`SandboxedFsPort` 同时在 direct file mutation 上施加 DSH 对等的 trusted-process policy fence；Python RPC、allow-list、工具 dispatch 和结果展示仍由 `execute_code` consumer 拥有；受限 policy 会删除宿主侧 `bash`/`write_file`/`edit_file` helper，不能借 RPC 绕过子进程隔离；不与 workspace `FsPort` 混用 | E5-A/B/C fake/native contract 已通过；Node direct file write 的 read-only deny、workspace-write canonical containment/symlink escape、配置/bundle policy 透传和嵌套 helper fail-close 均有测试。Linux/Windows process enforcing provider 与 Agent terminal tool/task reconnect 尚未完成，因此不能宣称完整跨平台 process sandbox deployment |
| E6（部分完成） | Shell and terminal | 已抽出 `ShellPort` 与 `DetachedShellPort` Definition、Node adapters，并让 `bash`/`task_*` consumers 通过窄 seam 注入；受限 `bash` 在 macOS 由 `SandboxedShellPort` 把精确 `/bin/sh -c` argv 交给同一 `SandboxPort`，并只经 `SubprocessPort.executeFile` 运行；受限 detached task 则由 `SandboxedDetachedShellPort` 经 direct-executable starter 启动同一 exact argv，task identity/output/stop/drain 继续由 `BackgroundTaskRuntime` 持有；`danger-full-access` 保留既有 shell runner。UI `TerminalSessionRegistry` 已完成 PTY/socket exact-owner fencing、reconnect buffer replay、detached timeout 和 shutdown dispose，且旧 close/input/exit 不会触碰 replacement。 | foreground/detached shell 的 read-only deny、workspace-write allow、bundle provider selection、direct-subprocess streaming 与 UI terminal lifecycle 都有 contract；Agent terminal tool、cancel/EOF policy、background task reconnect 以及 Linux/Windows confinement 仍待 terminal provider parity |
| E7（已完成） | ExecutionWorldBundle ownership | 已建立仅包含 execution-world 资源的 bundle factory：`FsPort`、`SubprocessPort`、`ShellPort`、`DetachedShellPort`、`ExecutionWorkspacePort`、`CodeRuntimePort`、`ExecutionTransportPort`、sandbox adapter、attachment delivery、plan storage 与 `BackgroundTaskRuntime`。bundle 自己拥有 `CodeRuntimePort.dispose()` 和 `BackgroundTaskRuntime.dispose()`；`InstructionStoragePort`、`ToolResultSpillPort` 继续留在 Context/Session artifact owner，未为凑 bundle 而迁入 | `ProjectRuntimeRegistry.buildRuntime()` 已只创建/持有 bundle 并向 `createBuiltinRegistry()` 注入窄 port；partial build、normal retire、failed staging cleanup 都通过 bundle dispose 收口，新增 lifecycle contract 覆盖 idempotent dispose、aggregate failure 和 build-failure cleanup |

`InstructionDiscovery`、`planFile` 与 `send_attachment` 已分别取得 `InstructionStoragePort`、`PlanStoragePort` 与
`AttachmentDeliveryPort`，并由 Gateway/CLI composition 显式选择 Node provider。这些 I/O seam 不改变其上层的
Context/Instruction、Plan 和 Attachment capability ownership，也不应被强行并入一个大 `FsPort`。

E5-D 已将 RPC address allocation 和 UDS cleanup 收敛为 `ExecutionTransportPort`，由 composition root 选择 Node
provider；`execute_code` 继续拥有 Python RPC、allow-list 和 nested tool dispatch。该 provider 以 exact transport value
cleanup，TCP 不做路径删除，UDS cleanup 有独立 contract test。

### 14.3.4 R0 的可执行拆分

R0 已拆成四个独立、可回滚切片；R0.1-R0.4 的 native closure 已完成，R0.4 仅保留按部署需求启用的 remote/sidecar/queued
provider parity gate。后续改动继续复用 exact-parent contract，不另建授权或 turn queue。

| 顺序 | 切片 | 主要改动 | 退出门槛 |
| ---: | --- | --- | --- |
| R0.1（已完成） | Exact live-parent identity | 为 `AgentSession`/`AgentHandle` 暴露稳定只读 `sessionId`；向 manager 注入最小 `get(sessionId)` directory；start/follow-up 改为携带 exact parent handle，`parentSessionId` 只从 handle 推导，不再充当授权凭证；host create/resume 请求携带已授权 parent handle；`AgentHandle.followup()` 在 durable enqueue 前重验 transient admission authority | `directory.get(parent.sessionId) === parent` 且 parent active；未注册 parent、same-id replacement 的旧 handle、prepare/create/inspect/resume await 期间或 admission tail 内被替换的 parent 均拒绝并回滚；durable descriptor parent 不匹配时在 resume 前拒绝；contract/竞态测试已覆盖 |
| R0.2（已完成） | Production host/tool wiring | 在 session/application composition 中构造唯一 manager、native host、provider registry 和 shared agent directory；tool consumer 只依赖 continuation contract；parent-owned child storage 复用 durable session layer；保留 one-shot adapter；不在 `AgentLoop` 内增加第二套 owner/queue | 非测试代码存在唯一 manager composition；首条与后续输入都进入 `AgentHandle.followup()`；真实 Gateway session 可 start、follow-up、cold resume；provider unload 后已持久化 child 仍可 resume；create/inspect/resume、Gateway E2E、rollback/dispose 和 one-shot parity focused tests 通过 |
| R0.3（核心实现/contract 已完成） | Settlement + child-first graph | activation 记录 exact parent/child ownership；quiescent + 无 live child 才 settlement；先递归 dispose child，再释放 parent；终态通知由 manager 投递给 live parent | `running/waiting/settled` 由 `AgentHandle` in-flight/inbox 和 child set 推导；dispose-start 在 session resource teardown 前 drain descendant；失败、abort、dispose failure 和无法读取终态均不映射为成功；same-id parent replacement 不接收旧 activation 的通知；nested tree、quiescence、失败词汇、stale parent、Gateway parent-close/dirty-recreate 与 nested close 已有 focused contract/E2E。final-disposal race 已在 R0.4 补充 |
| R0.4（native 已完成；parity 按需） | Deployment gates | native 竞态与关闭顺序已固化；仅在涉及 sidecar/remote/queued provider 时增加 parity | concurrent cold resume 只 materialize 一次；accepted input 不被迟到取消撤回；Gateway parent-close、SessionRouter dirty-recreate 与 `root -> child -> grandchild` native nested close 已验证 child-first drain；旧 activation disposal race 会等待释放后 cold-resume，绝不调用 releasing handle；每个 child 使用自身 local continuation port，默认 depth=1，`maxDepth: 2` 才允许 general-purpose child 再分叉；remote/sidecar parity 为部署 gate；native one-shot 行为保持兼容 |

R0.1 的身份规则直接来自 DSH alpha.2：durable session id 用于日志归属和恢复定位，exact live Agent identity
用于进程内授权。PilotDeck 可以用 exact `AgentHandle` 实现同一性质，但不能继续把可伪造的 parent id 字符串同时当成
address 和 credential。

### 14.3.5 E5 的四段式边界（本轮复核后确认）

DSH 的 `code-runtime`、`sandbox` 与 `subprocess` 是三个不同的 Definition：前者只运行模型编写的程序和宿主 binding，
中者只将精确 argv 按每次调用的 policy 约束，后者才拥有进程树、终端和终止语义。PilotDeck 不能把这些概念复制为一个
大而全的 `SandboxPort`，也不能把代码运行临时目录并入用户 workspace 的 `FsPort`。因此 E5 固定按以下可回滚切片推进：

| 切片 | Definition / Consumer / Provider 边界 | 不得改变的语义 | 退出门槛 |
| --- | --- | --- | --- |
| E5-A · Execution workspace（已完成） | 定义最小 `ExecutionWorkspacePort`：创建私有 execution root、写入指定文件并异步 cleanup。`execute_code` 是唯一 consumer；Node provider 由 project composition root 显式选择 | Python RPC 协议、允许调用的工具集、脚本 cwd、stdout/stderr 截断和结果格式不变 | fake provider 验证 module/script 的路径和顺序；Python spawn 前失败、spawn 失败、abort、timeout 都调用一次 cleanup；UDS socket 与 TCP 两种 transport 的残留行为保持既有测试等价 |
| E5-B · Code runtime（已完成） | 将 interpreter resolve、Python child 启动、受控 env、bounded stdout/stderr 和 timeout/abort/kill 迁至 `CodeRuntimePort`；Node provider dispose 会 stop-new、abort active child 并 await drain；RPC server、binding allow-list 与 tool dispatch 仍属 consumer | `unsupported`、`error`、`timeout`、`cancelled` 的区分不变；在途 host tool 调用不因 runtime replacement 进入新 generation | Node 与 fake runtime contract、resolve/child-exit/timeout/abort/dispose-drain 和 execute_code canonical result 对拍通过 |
| E5-C · Sandbox policy（macOS 首段完成） | 定义每次调用携带的 `SandboxPolicy`，由 `execute_code` consumer 在 CodeRuntime dispatch 前解析；`agent.sandboxMode` 由 ProjectRuntime 传入 bundle。`SandboxedFsPort` 只 fence filesystem mutation：`read-only` 拒绝，`workspace-write` 以 consumer 的授权 root、platform temp roots 和 fresh canonical target containment 后委托同一个 Node provider；它是 trusted-process containment，不取代 process sandbox。macOS Node provider 使用 `sandbox-exec -p` 按 DSH 等价 Seatbelt profile 包装 exact argv：默认拒绝 file-write，仅允许 `/dev/null`；workspace-write 额外放行 workspace、`/tmp`、platform temp 和 execution root。相同 policy 也在 `SandboxedShellPort` 与 `SandboxedDetachedShellPort` 分别包装前台/后台 `/bin/sh -c` 的精确 argv；Linux/Windows 或 probe 失败时受限 mode 明确拒绝 | 需要隔离的 profile 不允许静默 fallback 到未隔离本地进程；RPC helper 不得让宿主侧写入绕过子进程限制；受限 shell 不得退回 shell-string runner | `danger-full-access` passthrough、direct filesystem read-only deny/workspace-write containment、unavailable fail-closed、profile wrapping、macOS read-only denial/workspace-write allowance、per-run roots、配置/bundle policy mapping 与前台/后台 shell bundle selection 已有 contract；受限 RPC 已拒绝 `bash`/`write_file`/`edit_file`。Linux/Windows process provider 与 Agent terminal tool/task reconnect 仍是后续工作 |
| E5-D · RPC transport（已完成） | `ExecutionTransportPort` 拥有 execute-code 私有 RPC address 分配与 cleanup；Node provider 在 TCP 与 UDS 间选择并仅删除自己创建的 UDS path。Python RPC、binding allow-list、nested tool dispatch 继续归 `execute_code` consumer | TCP 不能执行路径删除；UDS cleanup 只作用于该 transport 实例；dirty reload 或 execute failure 不得把另一个执行实例的 socket 删除 | injected transport provider 收到 exact bound transport 的 cleanup；UDS cleanup 和 TCP no-op 均有 contract test |

这样既保留 DSH 的执行世界分层，又避免在 PilotDeck 还没有稳定 code-runtime caller contract 时，提前把 Python helper 协议、
ToolRuntime recursion 和 sandbox policy 混成第二个工具调度器。

### 14.4 审计使用的代码锚点

- Scope/ownership：`src/agent/scope/ScopedServiceRegistry.ts`、`AgentRuntimeScope.ts`、`AgentFactoryProvider.ts`；
- Session source of truth：`src/session/events/SessionRuntime.ts`、`src/session/persistence/`、`src/session/projection/`；
- Subagent：`src/agent/sub/{SubagentProvider,SubagentProviderRegistry,SubagentDescriptor,SubagentContinuationManager}.ts`、`src/agent/scope/AgentHandle.ts`、`src/agent/session/{AgentSession,AgentTurnInbox}.ts`；
- Interaction：`src/interaction/{InteractionProfile,ProfiledPermissionDecisionPort,InteractionDeadlinePolicy}.ts`、`src/permission/decision/PermissionRuntime.ts`、`src/gateway/permission/GatewayPermissionBus.ts`、`src/gateway/permission/createGatewayPermissionHook.ts`、`src/gateway/elicitation/GatewayElicitationChannel.ts`、`src/session/resume/resumeAgentSession.ts`；
- Compaction：`src/context/compaction/CompactionPort.ts`、`CompactionOrchestrator.ts`、`NativeCompactionPort.ts`；
- LLM policy：`src/model/ModelRuntime.ts`、`src/model/providers/registry.ts`、`src/router/policy/{RouterRetryPolicy,RouterRequestMaterializer,RouterCachePolicy,RouterOrchestrationPolicy}.ts`、`src/router/usage/RouterUsageObserver.ts`、`src/router/token/RouterTokenMeter.ts`、`src/router/fallback/runFallbackChain.ts`、`src/router/provider/RouterModelInvocationPort.ts`、`src/router/health/ProviderHealthTracker.ts`；
- Agent-scoped extension contribution：`src/extension/plugins/runtime/PluginRuntime.ts`、`src/context/extension/PluginRuntimeExtensionResolver.ts`、`src/context/prompt/registerExtensionPromptContributions.ts`、`src/tool/registry/registerExtensionToolContributions.ts`、`src/extension/hooks/execution/{HookRuntime,AsyncHookRegistry,CallbackHookExecutor}.ts`；
- Composition root：`src/cli/createLocalGateway.ts`、`src/cli/pilotdeck-agent-loop-default-factory.ts`。

DSH 主证据固定为 alpha.2 发布包契约（`package.json`、README、导出类型/实现和 `dsh-base/cordis.patch.yml`）以及
上述 commit 固定的源码 checkout；逻辑模块对应 `dsh-scope`、`dsh-agent`、`dsh-session`、`dsh-session-projection`、
`dsh-subagent`、`dsh-app-boot` 等包。后续 roadmap 更新必须区分“发布契约证据”和“源码实现锚点”，不要把工作树中
未随 alpha.2 发布的实验改动写成稳定行为；更新顺序仍是先更新本节的判定和退出门槛，再更新模块数量或目录列表。

### 14.5 当前分支验证

本节前述验证记录来自本分支已完成的 Node 22 验证批次；本次复核使用的工作树仍包含未提交改动，故另外记录
当前可直接复核的状态，避免把 P2 半成品误报为已完成：

- 当前 checkout 为 `Kaguya-19/refactor/core_agent_loop_0831`，Node 为 `v25.5.0`；`npx tsc -p tsconfig.json --noEmit`
  通过。项目 `npm run build` 受仓库 Node 22 runtime guard 约束，本轮没有把 Node 25 的结果写成完整 build 通过。
- P3-A 已落地：`agent.interactionProfile` 支持 `interactive`/`headless`/`disabled`，local Gateway 以 explicit option ->
  legacy `autoElicitation` -> config -> interactive default 选择 provider；headless question 使用 deterministic answerer，
  permission 的底层 `ask` fail-close，且不创建 Gateway pending request。本轮 profile/config/Gateway 定向测试 7/7 通过。
  session-title provider 的离线 fetch warning 走既有 fail-soft 路径，不作为 interaction 成功证据。
- P3-B 已落地：resume extension 现在透传 `ownedElicitation`，使 resumed AgentRuntimeScope 与 create/dirty-recreate
  共享 channel ownership 语义；resumed handle 的 release 与重复 dispose 幂等由新增 focused regression 覆盖。
- 当前 worktree 的 `AgentLoop.ts` 已存在一行 `runtimeContextSurface` 透传改动（本轮未修改）。在此 roadmap 下不再扩展
  核心循环；该既有例外须在合入前单独确认，P3-C 已仅通过 Gateway consumer 与 composition root 实现，后续
  验收不得再修改核心循环。
- P3-C 已完成：`GatewayWsClient`/`RemoteGateway` 只读转发 server-issued interaction binding；bridge 在 reconnect 时
  使用 exact previous binding，映射 replay DTO、抑制重复 dialog，并轮询 active/terminal `active_turn_snapshot`。Gateway
  在结束后保留 30 秒 terminal replay，bridge 在投影新 event 后才清理 local active state。`bridge-interaction-reconnect.spec.ts`
  启动真实 TCP WebSocket，分别覆盖 pending question 与 pending permission 的断线、reconnect、旧 binding 拒绝、当前答复、
  后续 model/tool/complete frame；`node --check ui/server/pilotdeck-bridge.js`、`ui` 中 `vitest run
  server/pilotdeck-bridge.test.js`（45/45）及 Gateway active-turn/elicitation/profile 定向测试均通过。
- Compaction P2.1 已落地：`CompactionPort` 增加显式 `manualForce`，`CompactionOrchestrator` 在 manual 路径绕过
  auto threshold、仍要求 budget/summary，并向 summary 传播 `trigger: "manual"`；auto/reactive 现有路径保持不变。
- Compaction P2.2/P2.3 已接入 native 路径：`ManualCompactionController` 是 session-owned consumer，
  `AgentHandle.compact()` 只复用 idle maintenance admission，`AgentSession.compact()` 不运行主 AgentLoop，
  `SessionRouter.compact()` 只路由既有 session，Gateway `/compact` 只做 command projection。该命令不创建新 session、
  不写 `accepted_input`、不发模型主请求，也不在 Gateway 保存 replacement/history。
- P2 当前仍保留 profile provider selection、cold-resume/retry contract 与跨部署 parity 的收尾；`/compact` 的 native success/skip/failure/
  abort/busy/timeout 已有 focused contract，replacement append failure 由同一 durable bracket 记录为 `compaction_failed`。
- 本轮定向复跑 TypeScript no-emit 以及 compaction、maintenance、Gateway command、router lifecycle 等 20 个测试，
  20 个通过。完整 `npm run build` 仍须在 Node 22 环境执行。

本次复核在 Node 22.23.1 下完成以下最小验证：

- `npm run build` 通过；
- 按 Agent scope、Module Protocol、Session event/persistence/projection、Prompt/Context、Compaction、Interaction、
  Fs/Subprocess execution-world 边界运行的既有 focused test 命令共 122 个测试，122 个通过，0 个失败；本轮 E1/E2/E3
  相关 focused tests 共 21 个，21 个通过，0 个失败（E1 5、E2 4、E3 5，另含既有 Fs/Subprocess/search tests 7）；覆盖 durable FIFO、
  cold resume、exact parent、settlement、child-first drain、nested child port、checkpoint + tail replay、prompt snapshot、
  interaction timeout/late answer 和 filesystem/subprocess 注入。

- 2026-09-09 最后复跑：`npm run build` 通过；AttachmentResolver、Gateway attachment guidance、Spill provider、
  tool-result reference/workspace path 与 bash result display 的定向回归共 20 个测试全部通过。其中 Spill 的 4 个
  fake-provider contract 覆盖大文本、alias collision、媒体以及 persistence failure 到 `tool_result_persistence_failed`
  的映射；`ProjectRuntimeRegistry` 已显式注入 Node provider。E4 仅保留 durable attachment storage/retention 的按需后续工作。

- 本轮 E5-A/B/C 与 E7 验证：`npx tsc -p tsconfig.json --noEmit` 通过；SandboxPort、`execute_code`、ExecutionWorldBundle
  和 agent profile 的 focused 回归共 20 个测试全部通过，另有 ProjectRuntime lifecycle/config composition 回归 6 个全部通过。覆盖 workspace root containment/idempotent cleanup、module/script
  写入顺序、Python startup failure cleanup、fake code-runtime canonical result、policy root/config/bundle mapping、macOS Seatbelt
  read-only denial、workspace-write allowance 和 confined RPC 对 `bash`/`write_file`/`edit_file` 的 fail-close。Linux/Windows provider
  与 Agent terminal tool/session 及 task reconnect 尚未完成。

- 本轮 E5-C/E6 复核：受限 `bash` 以 `SandboxedShellPort` 复用 `SandboxPort`，仅将封装后的精确 argv 交给
  `SubprocessPort.executeFile`；受限 detached task 以 `SandboxedDetachedShellPort` 使用同一 policy，并只交给 direct-executable
  starter。macOS bundle contract 证明 read-only 的前台与后台 shell 均不能写 workspace，direct-executable stdout/stderr
  streaming 保持 consumer 可见。Agent terminal tool/session 与 Linux/Windows process provider 仍不受该 provider 覆盖。

- 本轮 E5-C filesystem provider 验证：`SandboxedFsPort` 保持所有 read delegate 原样，仅对 `writeText` 施加 policy；
  `read-only` 返回结构化 `permission_denied`，`workspace-write` 用 consumer 的 resolved root 与 fresh canonical target
  拒绝外部路径及 symlink 祖先逃逸，并把该 canonical target 交给同一底层 provider。`write_file`、`edit_file` 和
  `edit_notebook` 都透传 workspace root；bundle 级 `write_file` read-only、native/file/notebook、shell/task/sandbox、
  `execute_code`、config 与 runtime lifecycle 共 54 个 focused tests，以及 `npx tsc -p tsconfig.json --noEmit` 均通过。

- 本轮 E6 首段验证：`npm run build` 通过；`ShellPort`/`DetachedShellPort` 注入、Node shell expansion、后台 task
  start/stop 与既有 `bash`/`SubprocessPort` 兼容 contract 共 10 个测试全部通过。当前已完成 foreground 与 detached
  provider seam；Agent terminal tool/session、EOF、background task reconnect 仍是后续 parity 工作。

- 本轮 hook/execution-world provider 验证：`CommandHookExecutor` 通过共享 `ShellPort` 执行 command hook；stdin、blocking、
  timeout、cancel 与非阻塞错误结果共 14 个 extension/tool focused tests 全部通过。

- 本轮 Router retry policy 验证：`RouterRuntime` 改为消费 `RouterRetryPolicy`；transient/zero-usage retry admission、
  max-attempts、Retry-After 上限与 backoff 共 17 个 router tests 全部通过，native provider 保持原有默认语义。

- 本轮 Router usage observer 验证：session usage cache、request stats 与 flush/dispose 已由 `RouterUsageObserver`
  承担，`RouterRuntimeDeps.usageObserver` 可注入替代 provider；Router 配置/cache/retry/usage focused tests 共 11 个通过。

- 本轮 Router TokenMeter 验证：新增 `RouterTokenMeter` Definition、native provider 与 runtime 注入；subagent budget、
  成功 usage fallback、失败 usage fallback 和 provider dispose contract 共 3 个新增测试全部通过，连同 native token
  estimate contract，本组 3 个测试通过。

- 本轮 Router fallback policy 验证：新增 `RouterFallbackPolicy` Definition、native config provider 与 runtime 注入；
  fallback candidate 去重、maxFallbacks、eligibility、attempt planning、provider fallback 和 dispose contract 共 2 个
  新增测试通过。更细粒度 routing policy 仍留在后续 P4，不把 fallback 首段完成误判为 LLM policy 全部完成。

- 本轮 Router request materializer 验证：新增 `RouterRequestMaterializer` Definition、native provider 与 runtime 注入；
  cache plan 路由过滤、max-output cap、subagent tag 处理、execute consumer 注入和 provider dispose contract 共 2 个
  新增测试通过。

- 本轮 Router cache policy 验证：新增 `RouterCachePolicy` Definition、native cache-aware provider 与 runtime 注入；
  disabled/no-cache fast path、token-meter delegation、sticky selection、token-saver decision consumer 与 provider dispose
  contract 共 3 个新增测试通过。provider invocation registry 与更细粒度 routing 仍留在后续 P4。

- 本轮 Router model invocation 验证：新增 `RouterModelInvocationPort` Definition/native adapter，并将 Router 的
  multimodal lookup、provider protocol、request stream、model-cap materialization 与 stream execution 改为消费该 port；
  native adapter 与 runtime dispose 组合已由 build 和 Router focused 回归覆盖。更细粒度 provider registry/health composition
  仍留在后续 P4。

- 本轮 Router orchestration policy 验证：新增 `RouterOrchestrationPolicy` Definition/native provider，并将 auto-orchestration
  trigger/continuation admission 从 RouterRuntime 中抽出；native trigger semantics、injected consumer 和 dispose contract
  共 2 个新增测试通过。provider registry 与跨 profile orchestration composition 仍留在后续 P4。

- 本轮 Router policy 组合回归：Router 全部 focused specs 共 31 个测试通过，覆盖 retry、usage、token、fallback、materialize、cache、
  orchestration、config 与既有 token-saver 行为；`npm run build` 与 `git diff --check` 均通过。

- 10C-C 最后复核：`npm run build` 通过；`agent-runtime-scope`、agent-loop factory、plugin runtime extension
  resolver、callback hook executor、plugin registry lifecycle、extension tool contribution 的 focused contract tests 共 33 个通过，
  0 个失败。该组覆盖 frozen extension generation、session-owned prompt/tool/hook lifecycle、availability diagnostics、
  stop-new/drain/dispose、async complete/cancel 和 late completion rejection。

- P1 prepared-request snapshot：`npm run build` 通过；`llm-model-port`、sidecar retry 与 native provider retry focused tests 共 8 个通过，
  0 个失败。native Router 与 host adapter 均在 `prepare()` 边界复制并冻结 canonical request；同一 prepared invocation 的
  再次 module call 使用新的 `requestId`，但 prompt、tool schema、metadata 等 request material 保持一致，且 `runId`、
  `operationId`、`idempotencyKey` 和嵌套的 `operationDeadline` 不变。该验证尚覆盖 host consumer，真实
  remote bridge 的断线/重试对拍仍留在部署 gate。

- P1 default profile rollout：生产 config 与 sidecar composition 在未显式配置时默认选择 `user_message`；`AgentLoop` 将
  profile surface 透传给 ContextRuntime，Context provider 按输入 profile 生成 durable synthetic user message。config、
  ContextRuntime、host context serialization 与 AgentLoop propagation focused tests 通过，直接 `DefaultContextRuntime` 的
  `system_prompt` 默认保持兼容。

- Interaction deadline seam：`npm run build` 通过；deadline policy、Agent scope inheritance/override、Gateway
  elicitation/permission consumer precedence 和既有 Gateway round-trip focused tests 共 29 个通过，0 个失败。
  其中 2 个新增 policy contract、1 个新增 scope contract、2 个新增 consumer precedence contract，其余为既有
  lifecycle/round-trip 回归；现有 timeout、abort、late answer 和 teardown 语义保持不变。

- 2026-09-09 session live-projection / resource lease 复核：`npx tsc -p tsconfig.json --noEmit` 通过；
  `GatewaySessionResourceLeaseBundle`、`SessionMcpRuntimeRegistry`、project runtime lifecycle、
  `GatewaySessionLiveProjectionBundle`、hook projection 与 background-task projection 的 focused tests 共 20 个通过，
  0 个失败。覆盖 session resource 的反向释放、幂等与失败后继续清理，以及两条 live projection 的 exact scope owner、
  session filter、subscription rollback 与 scope dispose 后停止投影。

- 2026-09-09 local Gateway lifecycle/boot rollback 复核：`npx tsc -p tsconfig.json --noEmit` 通过；
  bootstrap、local shutdown、server shutdown 与 project runtime lifecycle 的 focused tests 共 19 个通过，0 个失败。
  覆盖 watcher 优先停止、reverse rollback、正常 boot 的 ownership handoff、每个 shutdown effect 的 failure isolation、
  server 多错误聚合、project runtime cleanup await、stop-new 以及 shutdown 与已接纳 reload 的串行收敛。

- 2026-09-09 Agent publication stop-new 复核：`npx tsc -p tsconfig.json --noEmit` 通过；
  `session-router-lifecycle.spec.ts` 9/9 通过，并与 bootstrap、local/server shutdown、project runtime、session MCP、
  live projection 一组 focused tests 合计 31/31 通过。`SessionRouter.shutdown()` 先停止新建并等待已准入的
  `getOrCreate()` 发布操作；若 factory 在 stop-new 后才返回，handle 会被释放且调用失败，不能在已清空的 session map
  或已开始 dispose 的 provider 后发布 live agent。dirty recreate 也保留相同的关闭与旧 handle drain 语义。

- 2026-09-09 Gateway session permission-rule lease 复核：`GatewaySessionPermissionRuleSetRegistry` 将 fallback
  规则数组从 `ProjectRuntimeRegistry` 的常驻 `sessionKey -> Map` 拆为精确 handle retain。Gateway permission hook 与
  `PermissionContext` 读取同一 `PermissionRuleSet`；dirty recreate 的 old/replacement handle 共享该 entry，最后一个
  handle 释放才删除。partial `sessionOverrides.permissionRules` 的缺失数组也由同一 entry 稳定提供，避免
  `allow + remember` 写入 hook 数组却未进入 PermissionContext。Gateway `grant_session_permission` 也改为只消费
  `GatewaySessionPermissionGrantPort`，不再拥有第二份 grant Map；pre-session grant 由 provider pin 到首次 handle
  acquire，显式 close/gateway dispose 再释放。registry、Gateway consumer、permission round-trip、interaction profile、
  SessionRouter 与 session-resource contract 共 20/20 通过，`npx tsc -p tsconfig.json --noEmit` 与 diff 检查通过。

- 2026-09-09 Scope live-event carrier 复核：`AgentScopeLiveEventBus` 由 `AgentRuntimeScope` 在 root/child
  composition 中建立 parent identity。event 只会从 exact child 上行到 ancestor；sibling 和 child 不会收到 ancestor/sibling
  event。scope dispose 在异步 resource cleanup 前同步 stop-new，且按 subscription owner 等待 in-flight handler；一个
  subscriber 的失败只经该 owner 的 diagnostic callback 报告，不阻断 sibling delivery。`GatewaySessionLiveProjectionBundle`
  已改为 hook/task source -> scope live event -> Gateway status projection，source subscription 仍由 exact scope effect
  清理，durable `SessionRuntime` 未接入该 carrier。scope 与 Gateway focused tests 共 21/21 通过，相关 Gateway/MCP/plugin/
  SessionRouter regression 共 30/30 通过。

Gateway 测试中的 session-title provider 会因离线 fetch 输出重试警告；相关测试仍以预期的 fail-soft 路径通过，
不应将该 warning 解释为模型或 session 主路径成功。

### 14.6 本次架构复核后的执行 roadmap

以下顺序以本工作树的真实依赖关系重新收敛。它不以新增 `Port`、目录或测试数量计完成度；每个工作包必须同时证明
Definition、Provider、Consumer、Composition 与 shutdown/reload 语义。除明确批准的单独核心设计任务外，继续禁止修改
`src/agent/loop/AgentLoop.ts`。

| 顺序 | 工作包 | 解决的 DSH 性质 | 当前起点与范围 | 可验收退出条件 |
| --- | --- | --- | --- | --- |
| R0 | 收敛现有脏工作树 | 基线可重现 | 逐项复跑本分支已新增的 contract test；不扩展功能。WP15-C command catalog 已完成：直接 projection 与真实 Gateway composition 均通过 frozen contribution lease 将磁盘 plugin command 投影到 `commands_list`；测试不再以不匹配的 `query: "command"` 过滤 `/demo:deploy`。Agent scope live carrier 已闭环；P5 剩余是业务 pending-hook durable contract 以及非 Agent-scoped MCP/LSP lifecycle。当前 `ui` 全量 `tsc` 受既有 React 18/19 类型重复影响，R0 必须将其作为独立基线问题记录，不能把该失败归因给 terminal lifecycle 改动 | `diff --check`、受影响的 Node/ESLint/type-focused check 与每个新增 focused test 通过；全量 `ui` typecheck 的既有失败与本轮新增诊断分离后再收敛；失败测试得到最小修正或明确撤回；不把历史“曾通过”当作当前证据 |
| R1（native M2 live carrier 已完成） | 完整 Scope 语义 | 一个 scope identity 同时决定 service、contribution、event admission 与 effect teardown | R1-A 已完成两条真实 live projection：session-local `HookRuntime` 和 project-owned `BackgroundTaskRuntime` 都以 `sessionId` 产生 typed event；R1.0c 已将两条 subscription 的建立、同一 scope `own()` 与失败 rollback 收敛为 `GatewaySessionLiveProjectionBundle`。R1.2 已新增 `AgentScopeLiveEventBus`：child event 仅向自身和 ancestor 路由，scope dispose 同步 stop-new 并等待 exact owner 的 in-flight delivery。Gateway bundle 已将 hook/task source 作为 bus producer、status projection 作为 bus consumer。task provider 继续由 execution world 持有。不引入全局 DI 容器，也不把 durable Session event 放入 live carrier | parent/child 可见性、遮蔽、blocked token、replacement、stop-new、in-flight drain、child dispose 与 ancestor-only event delivery 均有同一套 contract；所有注册都由 exact scope owner 释放 |
| R2 | 非 Agent-scoped extension provider | provider generation、lease、retire/reload | R2-A MCP runtime call seam 已完成：`McpRuntimePort`/factory 隔离 MCP-to-tool bridge 与 native client，shared/per-session composition 复用既有 `ProjectMcpRuntimeProvider`/`SessionMcpRuntimeRegistry` exact owner。R2-A.1 已将 session preparation 中 project runtime、plugin contribution 与 per-session MCP 三个 lease 的成功、dispose、早期失败释放收敛为同一 reverse-order owner。R2-A.2 已将 shared MCP 改为由 frozen `mcpServers` signature 选择的 generation lease：每个 session clone 自己的 ToolRegistry 并只注册该 lease 的 bridge；新 snapshot 发布新 runtime，旧 runtime 直到最后一个对应 session lease 才 stop，失败候选不会中断旧 runtime。`SessionMcpRuntimeBundle` 现拥有 shared/per-session bridge 的 session composition 和 `per-session -> shared -> plugin -> project` release order，Gateway root 仅提供 browser-use spec patch 与诊断。LSP 仍没有真实 lifecycle consumer；command catalog 维持只读投影，telemetry 继续是 live-only observer，禁止再建 runtime registry | plugin reload 先发布新 generation；旧 instance 只服务已经获取 lease 的 consumer，lease drain 后恰好 dispose 一次；removed provider、失败 staging、跨 session 隔离均可验证 |
| R3 | durable pending hook | durable truth 与 live hook execution 分离 | 先定义唯一的业务 consumer 和恢复/取消语义，再将必要状态写入 Session event vocabulary、validation 和 projection；不得只增加“可持久化 registry”而没有 resume/cancel caller | restart、timeout、owner dispose、late completion、retry/cancel 都从同一 session log 推导；live `AsyncHookRegistry` 只是执行器，不成为第二状态真源 |
| R4-A（已完成） | Jobs / task consumer seam | DSH jobs 的 Definition / Provider / Consumer 分离 | 已定义不泄漏 `BackgroundTaskRuntime` 的 `BackgroundTaskPort`：`start`、`list`、`get`、`getOutput`、`wait`、`stop`；现有 runtime 结构性实现 native provider，`task_*` 与 `createBuiltinRegistry` 只消费 port；`ExecutionWorldBundle`/`ProjectRuntime` 继续拥有 provider 的 dispose。R4-A.2 已把模型可见的 read/control 收敛为 exact session access，未新增 completion inbox、持久化或 reconnect 语义 | fake port 覆盖 create/list/output/wait/stop、unknown id、timeout、abort、terminal output、unsupported 和 registry composition；native detached-shell、sandbox、owner fence、rejected exit settlement 与 bundle dispose contract 仍通过 |
| R4-A.1（已完成，native M2） | Schedule / cron control seam | DSH schedule provider、tool consumer 与 app controller 分离 | `CronControlPort` 覆盖 create/list/update/delete/stop/run-now；`CronAgentGatewayPort` 只覆盖 submit/abort/close。`CronRuntime`/`CronManager` 是 native provider 并继续拥有 scheduler/store/active-run/stop；Gateway controller 与六个 `cron_*` tool 共用 control Definition，CLI 只将窄 turn facade 绑定给 cron provider。当前完成的是 project-level control seam，不是 DSH 的 agent/session durable reminder | fake control port 覆盖六个工具的 project/session mapping；fake turn facade 覆盖 CronFire submit、terminal run record 与 active-run release；既有 schedule edit、atomic fire 和 Gateway RPC contract 通过 |
| R4-A.2（已完成，native M2） | Task owner fence / settlement / output drain | DSH jobs-local 的 owner-scoped access、producer rejection settlement 与 teardown drain | `BackgroundTaskAccess` 只承载 exact session identity；`task_list`、`task_output`、`task_wait`、`task_stop` 均透传工具 session，runtime 不暴露其它 session 的 entry。detached provider 的 rejected `exit` 追加诊断并写为 `failed`，仍 resolve waiters 和触发既有 completion；`TaskOutputStore.close()` 等待所有已接纳的串行 spill writes 后再释放内存 | 跨 session list/read/wait/stop 均被 fenced；producer rejection 不会挂住 wait；disk spill 在 runtime dispose 返回前可读。host-internal 无 access 调用仍保留给 project owner；不把它暴露为模型路径 |
| R4-B（R4-B.1 UI terminal lifecycle 已完成） | Execution World parity | 可替换底层 execution provider | R4-A.2 已完成 task 的 native owner fence、settlement 和 output drain。R4-B.1 已将 UI shell 的 PTY/sessionKey/socket/buffer/timeout 移入 `TerminalSessionRegistry`：reconnect、input/resize、exit、old-owner fence 和 process shutdown 都只通过该 provider；浏览器 consumer 以 current-socket identity fence delayed init/message/close/error，旧 socket close/input 或旧 PTY exit 都不能影响 current binding。剩余是 Agent terminal tool Definition、task reconnect 及 Linux/Windows process sandbox。保留当前 Fs/Subprocess/Shell/DetachedShell provider seam 与 ToolScheduler 并发语义。DSH 式 completion inbox/wakeup 或 durable job record 只有在明确业务 caller 后才能另起 scope/session 合同，不与 reconnect 混做 | registry contract 覆盖 reconnect replay、old socket fence、old PTY exit fence、exact timeout kill、queued stale timeout 与 idempotent dispose；browser hook contract 覆盖 stale init/message/close 不污染 replacement；后续 native 与受限 profile 对 Agent terminal abort、EOF、kill、reconnect、cleanup 和 policy-denial 的结果可对拍；无平台实现时 fail-closed |
| R4-C.1（已完成，native M2） | Plan / todo durable capability | DSH `tool-todo` 的 session event + projection + scoped tool consumer | 保持 `AgentLoop.ts` 不变。`PlanTodoPort` 复用既有 handle 形状，`NativePlanTodoRuntime` 仅从 `plan-todo.state` projection 读取状态；approved-plan、whole-list todo write、side-effect progress 和诊断以 `plan_todo_*` 事件提交。`todo_write`、`exit_plan_mode` 和 `ToolRuntime` 作为 consumer，`createLocalGateway` 在 storage/projection 恢复后按 session 装配 native provider。没有平行 `Map<sessionId, ...>` 真源 | focused contract 覆盖 event/domain validation、tool write、side-effect progress、checkpoint+tail 恢复、默认 projection checkpoint 与 session composition；类型检查和 27 个相关测试通过。DSH 的 next-turn reset 并非 PilotDeck 目标语义，跨 profile/provider selection 与 remote parity 留在 P6/G1 |
| R4-C.2（已完成 native M2） | Always-on project orchestration seam | DSH workflow/schedule 的 provider、owner 与 app composition 分离 | 保持 Always-On 为 project-scoped，不塞入 AgentSession。`AlwaysOnAgentGatewayPort` 只允许 submit/abort/close；`AlwaysOnControlPort` 承载 apply/rerun/abort。`AlwaysOnRuntime`/`AlwaysOnManager` 是 native provider，standalone provider 只允许 persisted-cycle apply 并对 rerun/abort fail-closed；InProcess/Remote Gateway 与 WS RPC 是 control consumer，CLI 在启动/reload 时负责 composition。abort 仅允许 active provider-owned session，并沿用普通 turn abort；stores/workspace/scheduler/run cleanup 仍由 provider 拥有 | focused contract 覆盖 Gateway/remote port delegation、active-session ownership、fake turn facade、standalone fail-closed 与 stop-new/drain；scheduler stop 继续等待 active tick，runtime stop 继续等待已接纳 control run 的 terminal cleanup。尚缺 worktree cleanup 的端到端 reload 对拍、profile/bundle selection 和 remote/sidecar E2E parity |
| R4-C.3 | Workflow / goal design gate | DSH `WorkflowEngine` 的 live run、owner cleanup、typed lifecycle 与 child ownership | 在产品先给出多 agent 编排或 goal 的具体 caller 前不实现目录或 registry。设计必须指定 run handle、唯一 owner、event vs external durable store、cancel/timeout、child AgentHandle/inbox ownership、restart/unknown outcome 与 UI/transport consumer | 只有完整业务合同和最少一个真实 consumer 获批后才进入实现；其 contract 覆盖 validation、start/end 一次性、cancel、owner dispose、child cleanup 与 replay，不把 Always-On/cron/subagent state 复制进泛化 workflow |
| R5 | Profile / Bundle / Boot | provider selection、ordered composition、boot rollback | R5.0 已完成：`ProjectAutomationBundle` 从 CLI 提取 Always-On/Cron 的 native composition、窄 Gateway bind、启动、选择性 reload、rollback 与逆序 stop。R5.1 已完成：`ProjectRuntimeResourcesBundle` 从 `ProjectRuntimeRegistry` 提取每个 generation 的 model provider、plugin runtime、router、execution world、MCP provider 和 memory service 的 stage/dispose ownership；registry 保留 project/session lease、publish/retire 与 session composition。R5.2 已完成：`LocalGatewayLifecycleBundle` 从 `createLocalGateway` 提取 config/extension watcher、Gateway admission、subagent manager/provider、SessionRouter、per-session MCP、runtime invalidation 与 telemetry 的 idempotent stop ordering。R5.3 已完成：`PilotDeckServerShutdownBundle` 从 CLI server 提取 shutdown composition。R5.4 已完成：`ChannelAdapterBundle` 从 CLI server 提取 IM adapter 配置映射、session mapper state restore/save、启动集合、reload 与 Weixin re-login；server 继续拥有运行中的 channel handle，Gateway 继续拥有 session/turn。R5.5 已完成：`ChannelLifecyclePort` 使 bundle 以期望 adapter set 驱动 server-owned running handle，按 key 串行 stop/replace；禁用/删除会精确 stop，candidate 启动失败会恢复旧 adapter，Feishu webhook 则只在 candidate 已启动后切换。R5.6 已完成：server close 停止 admission、释放 active channel handle，并让迟到 startup 的 returned handle 自停；shutdown bundle 按 automation -> server/channel -> mapper flush -> Gateway -> telemetry 的依赖顺序执行。R5.8 已完成：`SessionInteractionBundle` 将 session interaction 的真实 provider 选择和 scope-owned callback 回收提取为窄 bundle。R5.9 已完成：`SessionToolCompositionBundle` 将 session tool filtering、availability preflight 和 extension tool registration 收敛为依赖 R2-A.2 MCP generation lease 的窄 bundle；不新增 ToolRegistry 或 MCP runtime owner。R5.10 已完成：`SessionContextRuntimeBundle` 收敛 ToolResultBudget、native compaction provider、InstructionDiscovery、frozen extension prompt registration 和 DefaultContextRuntime 的 session composition；R5.11 已完成：`SessionFileHistoryBundle` 只在既有 session storage/projection 上组合 `FileHistoryStore`，由 storage 继续拥有 durable event、replay 与 projection。R5.12 已完成：`SessionPlanTodoBundle` 将 project-owned plan storage 与 session projection-backed `PlanTodoPort` 组合为既有 Agent dependency。R5.13 已完成：`SessionSubagentTranscriptBundle` 将 parent transcript record 和 child sidechain writer 映射为既有 subagent hooks，child AgentHandle/manager ownership 不迁入 bundle。R5.14 已完成：`SessionSubagentContinuationBundle` 将 exact parent binding、child-first drain callback 与 session-local `subagent`/`send_message` consumer registration 从 Gateway root 取出，manager/host 仍分别拥有 activation 与 child construction。R5.15 已完成：`GatewaySessionModelBundle` 把 session model 的 transcript-backed preference、catalog policy 和 Gateway mapping 收敛为 data-plane consumer。R5.16 已完成：`GatewaySessionHistoryBundle` 收敛 Web history/fork/replace/status 的 storage mapping。R5.17 已完成：`GatewayUploadedAttachmentBundle` 只将已验证 upload 投影为 Gateway attachment。R5.18 已完成：`GatewayCommandCatalogBundle` 从一个 frozen plugin contribution lease 投影 command。R5.19 已完成：`GatewayRuntimeRefreshBundle` 收敛 config subscription、RPC reload、extension invalidation、turn maintenance 和 server notification binding；ConfigStore、ProjectRuntimeRegistry、SessionRouter 与 server 分别保持状态 owner。R5.20 已完成：`GatewayTelemetryBundle` 收敛 observer registry、observing facade 与 native collector lifecycle；外部注入 client 继续归调用方，live observer 仍不成为 durable Session state。保留 `createLocalGateway` 兼容 facade，不一次性重写 2k+ 行 composition root | R5.0 的 provider build/start failure、rollback、selective reload、stop order；R5.1 的 runtime lease、candidate staging、partial-build cleanup、MCP/plugin release order、idempotent disposal；R5.2 的 watcher drain ordering、failure-isolated mandatory cleanup 和 idempotent application shutdown；R5.3/R5.6 的 success/failure cleanup order、idempotent CLI/server stop 与 late-start cleanup；R5.4 的 startup mapping、reload order、Weixin re-login 和 state flush 均有 focused contract。R5.5 覆盖 disabled adapter 的精确 stop、同 key replacement、candidate failure rollback、Feishu webhook switch/removal 和不影响其它 channel；R5.8 已覆盖 interactive/headless/disabled/no-Gateway 的 provider selection 和 callback rollback，关联 Gateway/session regression 46/46 通过。R5.9 覆盖 policy filter 先于 availability、Always-On surface、extension conflict、unavailable diagnostics、frozen plugin snapshot 和 MCP generation 交错；最终 session registry 才是模型 schema source，且 scope dispose 继续拥有该 registry。R5.10 覆盖 frozen prompt contribution registration、partial registration rollback，并与 context/compaction/tool/MCP lifecycle focused suite 同时验证；R5.11 覆盖 durable projection hydration 和新 snapshot record；R5.12 覆盖 project storage 的 plan-file delegation 与 projection-backed todo mutation；R5.13 覆盖 parent `subagent_started`/`subagent_completed` references 和 child sidechain record；R5.14 覆盖 live/cold follow-up、exact-parent replacement fence 与 child-first drain；R5.15-R5.20 分别覆盖 model preference、history transaction、upload integrity projection、frozen command lease、真实 Gateway RPC reload/extension invalidation/config subscription release，以及 telemetry injected/native ownership 和 observer drain。不会产生第二份 channel/session/tool/context/file-history/plan-todo/subagent/config/router/telemetry durable state。后续仍需缺 provider 诊断、全应用 boot rollback，以及 native/headless/sidecar/Gateway 复用同一 Definition；业务状态不迁入 transport 或 profile |
| R5.21（已完成，native M2） | Project model runtime provider composition | DSH llm/provider route、generation lease 与 application-owned selection | `ProjectModelRuntimeBundle` 从 project resource bundle 提取 provider registry 创建、native/custom factory selection、registry-backed `ModelRuntime` facade 与 registry disposal；ProjectRuntimeResourcesBundle 只消费 staged model/modelProviders，并保留 generation 总体 release order。Router policy、canonical request、session model preference 和 injected complete runtime lifecycle 均不迁入 bundle | provider route generation、injected complete runtime caller ownership、duplicate provider stage failure 后已注册 provider cleanup，以及 project reload/lease/router invocation 回归通过；不产生第二个 router 或 model config 真源 |
| R5.22（已完成，native M2） | Project execution-world provider composition | DSH execution provider、sandbox profile 与 base tool aggregation | `ProjectExecutionWorldBundle` 从 project resource bundle 提取 sandbox-mode provider selection、execution world、base builtin ToolRegistry、extension skill read facade、web-search config 与 extra tool registration；session MCP/extension filtering/permission policy 保持现有 session consumer，bundle 只 dispose world | selected sandbox、single base registry、builtin/extra tool visibility、idempotent world disposal、project runtime failure cleanup 与 existing execution-port/sandbox contracts 通过；UI interactive terminal lifecycle 已由 R4-B.1 独立收敛，Agent terminal tool、cross-platform sandbox 与 task reconnect 仍是 R4-B 后续 |
| R5.23（已完成，native M2） | Project memory provider composition | DSH context/memory provider 与 project-scoped service lifecycle | `ProjectMemoryBundle` 从 project resource bundle 提取 EdgeClaw memory provider/service construction 和 exact close；ProjectRuntimeRegistry 继续拥有 maintenance single-flight、retry/logging 与 project generation selection | enabled/disabled profile、exact factory input、idempotent close、project resource cleanup 与 context compaction/prompt regression 通过；不建立 durable memory event、scheduler 或 second service owner |
| R5.24（已完成，native M2） | Project router runtime composition | DSH `llm/router` 的一次调用入口、token accounting 与 project-scoped shutdown | `ProjectRouterRuntimeBundle` 从 project resource bundle 提取 `TokenAccountingRuntime` 与 `RouterRuntime` 的构造/关闭；完整注入的 `ModelRuntime` 仍走既有分支，其他路径仅以 staged provider registry 构造 invocation port。Plugin runtime 继续拥有 custom-router/skill 的 source generation；custom-router instance 由 session snapshot 注册到 project-owned registry | complete-model 与 registry invocation 分支、provider-health generation、request materializer、usage observer 和 project resource lifecycle 都通过；不建立第二个 model/router config 真源，也不迁移 Router policy 或 session selection |
| R5.25（已完成，native M2） | Project session runtime composition | DSH profile/bundle 的 per-session provider assembly 与 reverse lease cleanup | `ProjectSessionRuntimeBundle` 从 `ProjectRuntimeRegistry` 提取 published project generation 的 frozen plugin generation、MCP/tool、interaction、context、projection 与 continuation composition；失败时由同一个 `GatewaySessionResourceLeaseBundle` 逆序释放 permission/plugin/MCP/project retain | plugin refresh failure 会精确释放 permission/project retain；真实 session creation、MCP generation drain、project retirement、context/tool/interaction/subagent composition 回归通过；不创建第二份 session、storage、ToolRegistry 或 Gateway pending state |
| R5.26（已完成，native M2） | Session agent config composition | DSH llm/context/interaction 的 immutable session data-plane view | `SessionAgentConfigBundle` 从 registry 提取 model/subagent capability、output cap、workspace、interaction prompt 与 permission rule snapshot 到一个 `AgentRuntimeConfig`；create/recreate 复用同一冻结 config | model capability fail-soft、env output cap、subagent selection、permission/workspace/profile mapping 与真实 session lifecycle 通过；不持有 ModelRuntime、PermissionRuntime、SessionConfigOverrides 或 AgentLoop state |
| R5.27（已完成，native M2） | Gateway subagent runtime composition | DSH subagent provider/host/consumer 的 application-owned native assembly | `GatewaySubagentRuntimeBundle` 统一创建 native provider registry、host、manager 与 child session configurator；bootstrap rollback 通过 bundle 先 drain manager 再释放 provider，正常 Gateway shutdown 仍消费同一 manager/provider | native provider identity、continuation references、幂等 drain、manager cold-resume/materialization、Gateway live/cold continuation、bootstrap/lifecycle ordering 均通过；不迁移 manager activation、host child-session construction 或 scope-owned tool registration |
| R5.28（已完成，native M2） | CLI server bootstrap rollback | DSH app boot 的 ordered startup/rollback ownership | `PilotDeckServerBootstrapBundle` 在 commit 前拥有 automation attach/start、local Gateway 与 telemetry 的 rollback；channel/server assembly 任一步失败都按 automation -> Gateway -> telemetry 清理，commit 后转交 `PilotDeckServerShutdownBundle` | automation-start/server-start failure、commit ownership transfer、channel/server shutdown 和 automation reload 回归通过；不接管运行中 server/channel handle、config watcher 或 process signal owner |
| R5.29（已完成，native M2） | Upload artifact lease | DSH scoped artifact consumer 的 exact lifetime 与 provider-owned retention | `UploadStore` 继续拥有 upload metadata、authorization、hash verification、source artifact 与 retention；`GatewayUploadedAttachmentBundle` 只为每个 accepted upload 获取 disk-backed hard-link lease，`InProcessGateway` 在 Agent turn terminal 后精确 release。UI cleanup 可删除过期 source；crash orphan lease 由 provider TTL 回收 | 两个独立 store instance 的 UI cleanup 不破坏 Gateway lease；partial acquire reverse release、turn terminal release、idempotent release 与 TTL cleanup 均通过；不建立进程内 shared UploadStore、第二份 attachment registry 或 Session event state |
| R5.5（已完成，native M2） | Channel lifecycle consumer | provider removal、exact handle ownership 与 reload rollback | `ChannelLifecyclePort` 由 `PilotDeckServer` 提供，server 继续拥有 running handle；`ChannelAdapterBundle` 只给出期望 config generation，不能直接持有或停止运行 handle。reconcile 对 disabled/removed channel 执行精确 stop；同 key replacement 串行进行，candidate 失败会恢复旧 adapter；Feishu webhook 保留旧 handler 直至新 adapter 成功启动 | disabled adapter 的旧 handle 恰好 stop 一次；其它 channel、Gateway session 和 turn 不受影响；replace/remove/start-failure/retry 及 webhook switch/removal 均有 real server contract，且不产生第二份 channel/session registry |
| R5.6（已完成，native M2） | Server close lifecycle | admission stop、exact handle teardown、late-start cleanup | `PilotDeckServer.close()` 是 running channel handle 的唯一 shutdown consumer：先拒绝新 adapter operation、停止当前 handle 并关闭 HTTP server；已有 startup 不可取消时不阻塞关闭，但一旦返回 handle 必须立即以 `server-shutdown` stop。`PilotDeckServerShutdownBundle` 先停止 automation，再关闭 server/channel，最后 flush mapper state、dispose Gateway 和 telemetry | active handle 恰好 stop 一次；`close()` 幂等；close 后新 reload fail-closed；late startup 不泄漏 handle；正常和失败 shutdown 都执行后续 cleanup，且不让 channel adapter 获得 Gateway session/turn owner |
| R5.8（已完成，native M2） | Session interaction bundle | session-scoped provider selection、hook callback ownership、composition rollback | `SessionInteractionBundle` 已从 `createLocalGateway` 提取 profile resolution、policy/deadline、profiled permission port、Hook/Lifecycle runtime、Gateway permission callback、deterministic/Gateway elicitation 与 reconnect injection。bundle 只接收窄 Gateway facade 和 rule-set reference；`attach(scope)` 只注册 callback 并由 `scope.own()` 释放。Gateway pending entry/reconnect state 仍由 Gateway bus owner 持有，durable permission/question audit 仍由 AgentSession adapter 持有 | interactive profile 有 Gateway 时完成 permission/question provider 组合；headless 选择 deterministic question + fail-closed permission；disabled 与无 Gateway 都 fail-closed 且不创建 pending entry；scope attach 失败会精确回滚 callback；scope dispose 会释放 callback 和 owned elicitation。`session-interaction-bundle.spec.ts` 与 Gateway/session regression 共 46/46 通过。未修改 `AgentLoop.ts`，未新建 interaction/pending 的第二真源 |
| G1 | 远端/sidecar 部署 gate（贯穿） | transport 是可选投影 | 对 subagent、prepared request retry、compaction、interaction 和 extension provider 按实际部署形态补 parity，而非先建立第二业务实现 | native trace 与 remote/sidecar trace 的模型输入、工具顺序、terminal state 等价；取消、超时和 unknown outcome 不被映射为 success |

执行关键路径为：`R0 -> R1 -> R2 -> R5`。R3 是产品 gate：只有获批的业务 consumer 明确 resume/cancel 合同后才进入实现，
不阻塞现有 profile/bundle 收敛。`R4-A` 已完成，`R4-B` 依赖其 task consumer contract，必须在 R5 选择 execution profile 前
完成其目标平台的 provider contract。`R4-C.1` 依赖 R1 的 exact session ownership 和现有 Session projection，不等待 R5；
`R4-C.2` 可与 R4-B 并行，但其 profile/reload 收敛依赖 R5；`R4-C.3` 受产品 caller gate，不占关键路径。`G1` 是每一
工作包的部署验收门，而不是独立 state owner。

两个边界需保持显式：

1. `AgentLoop` 目前仍直接消费宽 `AgentRuntimeDependencies`，因此只能标记为“调用 Port 已局部 M2”，不能称为完整 DSH
   `agent-loop` seam。若未来要将其收敛成 turn capability view，必须先单独批准 core-loop 设计，定义 request/admission、
   subagent 与异常行为的逐条 parity；本 roadmap 不以偷改 loop 达成该目标。
2. `SessionRuntime`/projection、`SessionMcpRuntimeRegistry`、`ToolRegistry` 与 Agent inbox 已各有状态或 owner。任何后续
   模块只可消费或注册到这些既有 owner；不得为了“模块化”再创建 command registry、pending queue、MCP runtime owner 或
   durable telemetry state。

本次复核的直接证据为：DSH `dsh-scope` 将 scope identity 同时用于 Cordis registration ownership 和 event routing，
`dsh-app-boot` 以 ordered bundle patch 组成 profile 并在 boot 失败时释放 fiber；PilotDeck 侧 `createLocalGateway.ts` 仍是
集中 composition root，`AgentRuntimeDependencies` 仍是宽 dependency bag，而 Session projection、plugin lease、MCP exact
registration 和 telemetry observer 已分别具备可复用的局部生命周期基础。

R5.2/R5.3 的 failure contract 继续按 DSH effect teardown 收敛：`LocalGatewayLifecycleBundle` 已对 Gateway、
subagent manager/provider、router、per-session MCP、project runtime dispose、telemetry observer/base 和两个 watcher 分别隔离
失败，前一 effect 失败不得跳过后续已取得 owner 的释放；`PilotDeckServerShutdownBundle` 保持 automation -> server/channel
-> mapper flush -> Gateway -> telemetry 的依赖顺序，并在所有步骤执行后原样抛出单一失败或聚合多个失败。两组 bundle 的
focused contract 覆盖顺序、幂等、downstream cleanup 和多失败诊断。

R5.7（已完成，native M2 bootstrap rollback）使 `LocalGatewayBootstrapBundle` 在 `createLocalGateway()` 成功返回前
拥有 boot-time cleanup：watcher 已启动而后续构造失败时，先停止 config/extension watcher，再逆序回收 session router、
per-session MCP、published project runtime、subagent manager/provider、telemetry observer/base；成功时 `commit()` 清空
bootstrap owner，正常关闭改由 `LocalGatewayLifecycleBundle` 接管。`ProjectRuntimeRegistry.disposeProjectRuntimes()` 同时
stop-new、等待已接纳 reload tail 与既退役 generation 的 in-flight disposal，并只在 session lease 已 drain 后释放 generation，
防止 shutdown 与 reload/invalidate 交错产生孤立 provider。此项不等同 DSH 的声明式 profile/patch boot tree，后者仍需
单独 provider selection 与跨部署 composition。

#### R5.8：SessionInteractionBundle（已完成 native M2）

这是已落地的 profile/bundle 收敛切片。此前 `createLocalGateway()` 的 session preparation 同时决定 interaction profile、
policy/deadline、permission provider、hook runtime、Gateway callback、question channel 和 reconnect port；这些对象已有真实
consumer，但没有一个 application-owned owner 能单独验证其组合失败和释放顺序。

`src/cli/SessionInteractionBundle.ts` 现只做 session interaction 的 composition，不新增 interaction state：

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| 输入 | `sessionKey`、已解析 profile/canPrompt、session permission rule-set、hook settings、`ShellPort`、timeout、事件 sink 与可选窄 Gateway facade | 完整 `Gateway`、`ProjectRuntime`、`SessionRuntime`、`AgentLoop` 或 Plugin runtime |
| 输出 | `PermissionDecisionPort`、`InteractionPolicy`、`InteractionDeadlinePolicy`、`LifecycleRuntime`、可选 elicitation、`ownedElicitation`、可选 reconnect port | durable permission/question audit、tool runtime、session/turn state |
| attach | 在 interactive Gateway profile 下注册 permission callback；用 `scope.own()` 保证 callback registration 的 stop-new/dispose；`own()` 失败立即释放刚取得的 registration | Gateway pending permission/question entry、reconnect binding 或 Gateway bus 的 shutdown |
| state owner | permission rule-set 继续由现有 session rule-set registry 提供；Gateway buses 保持 pending/reconnect owner；AgentSession durable adapter 保持审计 event owner | 第二个 pending map、第二个 interaction reconnect store、第二份 permission rule 或 audit log |

R5.8 已按以下顺序完成：先增加 bundle 的 focused contract test，再将 `createLocalGateway` 的 interaction 片段替换为 bundle
输出，最后只保留 `configureContinuableSubagents()` 中的一次 `bundle.attach(input.scope)`。focused test 覆盖 interactive Gateway、
headless、disabled、interactive 但 Gateway 缺失、scope attach rollback 和 handle dispose；关联 Gateway/session regression
46/46 通过。完成 R5.10 后，R5 的下一步是在存在真实 consumer 的前提下，用相同 Definition 选择 native/headless/sidecar/Gateway profile；
不把 profile 文件格式或 Cordis container 直接搬入 PilotDeck。

#### R5.9：SessionToolCompositionBundle（已完成 native M2，依赖 R2-A.2）

此前 `createLocalGateway()` 的 session preparation 同时负责四件不同层级的事：调用
`SessionMcpRuntimeBundle` 取得 MCP bridge、按 session override 移除工具、对 Always-On 之外的 session
隐藏 `always_on_*`、再执行 builtin availability 与 frozen extension tool contribution 的 preflight/registration。
这不是新的 capability provider；它是一个已经有真实 consumer 的 application composition 缺口。继续在
Gateway root 增加条件分支，会重新把已完成的 MCP generation/lease lifecycle 与 ToolRegistry 的 session owner 打散；
现已由该 bundle 收敛。

实现后的边界如下：

| 角色 | R5.9 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | `SessionToolCompositionBundle` 输入为 exact session key、frozen extension resolver、工具可用性 context、session policy（`excludeTools`、Always-On surface）及已有的 MCP composition；输出为最终 session `ToolRegistry` 与 unavailable diagnostics | 不新增通用 capability registry、ToolPort、MCP runtime port 或 plugin registry |
| Provider | native bundle 先在 session-local working registry 上组合 shared/per-session MCP，再依既有顺序执行 policy filter、builtin availability、extension preflight 与 registration | 不持有 project `runtime.tools`、plugin snapshot、shared MCP generation、per-session MCP registry 或 `runtime.unavailableTools` 的长期状态 |
| Consumer | 仅 `ProjectRuntimeRegistry.prepareSessionRuntime()` 消费输出，并将最终 registry 交给现有 `createAgentSession(..., { ownedToolRegistry: true })` scope | `AgentLoop`、builtin tools、`ToolRuntime` 和 model request assembly 不感知 bundle 或 provider 选择 |
| Lifecycle | 沿用 `GatewaySessionResourceLeaseBundle` 的 `per-session MCP -> shared MCP -> plugin -> project` 释放顺序；bundle 失败时只释放自己已创建的临时 registry，外层仍执行同一 lease rollback | 不替代 `SessionMcpRuntimeBundle` 的 MCP lease、不 dispose project registry、不创建第二份 session tool state |

实现必须保持当前语义顺序：`excludeTools` 与 Always-On surface 先于 availability 检查；extension contribution
先整体检查冲突，再只注册通过 availability 的 definition；同一个 frozen plugin generation 既决定 MCP specs，也决定
prompt/tool/hook contribution。`filterAvailableTools()` 可以内部产生短命 working registry，但只有最终返回并由
Agent scope 释放的 registry 才是模型 schema 与 `ToolRuntime` 的真源。

已验证的退出条件：

1. 新 bundle contract 覆盖普通 session、Always-On session、`excludeTools`、unavailable alias、extension conflict 和临时 registry cleanup；
2. MCP startup partial failure、plugin generation 交错与 session resource release 仍由 `SessionMcpRuntimeBundle`、project runtime lifecycle 和 MCP provider contracts 覆盖；
3. project base `runtime.tools` 不被 session filter、MCP replacement 或 extension registration 修改；
4. `createLocalGateway` 将最终 registry 以 `ownedToolRegistry: true` 交给 Agent scope；筛选前的 working registry 不会存活为第二 schema source；
5. `npx tsc -p tsconfig.json --noEmit` 与 session tool/MCP/project lifecycle focused suite 21/21 通过。

#### R5.10：SessionContextRuntimeBundle（已完成 native M2）

此前 `createLocalGateway()` 同时创建 token/tool-result budget、native compaction 组件、workspace instruction discovery、
frozen extension prompt contribution registry 和 `DefaultContextRuntime`。这些对象同属单个 session context 的 composition，
却与 file history、plan/todo、subagent transcript 和 tool registration 混在同一 factory 中；R5.10 将前者收敛为
`SessionContextRuntimeBundle`，并保持后者原有 owner 不变。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| 输入 | exact session identity、可选 project key、project root、session storage 的 tool-result 目录、project-owned model/instruction/spill/token provider、lifecycle dispatcher、frozen extension resolver | `ProjectRuntime`、`SessionRuntime`、file history、plan/todo、subagent transcript、MCP runtime 或 ToolRegistry |
| 输出 | `DefaultContextRuntime` 与 session-owned `PromptContributionRegistry` | 第二份 prompt/tool schema、Session durable event store 或 compaction durable state |
| 生命周期 | prompt registration 任一步失败时立即 dispose registry；成功后 registry 仍由 Agent scope 释放 | 不 dispose project-owned router、memory、instruction/spill I/O 或 extension snapshot lease |
| 兼容 | 保留原 compaction request identity、lifecycle dispatch 与 instruction discovery 参数；`projectKey` 允许缺失，维持 Router 的 optional `projectPath` 语义 | 不改变 `AgentLoop.ts`，不把 runtime context admission 改为新的 step loop |

focused contract 覆盖 frozen prompt contribution 的 materialization、scope-owned registry 交付和 partial registration rollback；
`npx tsc -p tsconfig.json --noEmit` 及 context/compaction/tool/MCP/project lifecycle focused suite 29/29 通过。

#### R5.11：SessionFileHistoryBundle（已完成 native M2）

file history 原本在 `createLocalGateway()` 内同 context、plan/todo、subagent transcript 一起构造，容易诱使后续
composition 再读一次 JSONL 或另建 replay cache。DSH 的 Session 要求 durable event 是唯一真源；因此本切片不把
`FileHistoryStore` 升格为 storage owner，而是只将它作为既有 storage/projection 的 consumer。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| 输入 | exact session key、既有 `AgentProjectSessionStorage` 的 file-history 目录、transcript writer 与 projection driver | 新建 Session persistence、直接读 JSONL、Session event vocabulary 或 checkpoint policy |
| 输出 | hydrated `FileHistoryStore`；新 snapshot 通过既有 transcript writer 记录 | 第二份 file-history state、projection registry 或 storage disposer |
| 恢复 | 仅读取 `file-history.snapshots` projection 并交给 store replay | replay 其它 session projection、修改 tool/context 的 durable 语义 |
| 生命周期 | file-history 文件继续由既有 storage/project artifact lifecycle 管理 | 关闭或 dispose project/session storage、改变 SessionRuntime owner |

focused contract 覆盖一次 snapshot record 后由 durable projection 恢复；`createLocalGateway()` 只消费 bundle 输出。
这保证 file history 的构造位置被收敛，而 durable truth、projection replay 和 storage lifetime 仍各归原有 owner。

#### R5.12：SessionPlanTodoBundle（已完成 native M2）

`PlanTodoPort` 的 durable provider 已存在，但 Gateway root 仍同时知道 plan-file 的 project storage 与 plan/todo 的
session transcript/projection。R5.12 将这两个已有 consumer 组合为一个 session dependency，不改变 plan mode、`todo_write`
或 `ToolRuntime` 的行为。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| 输入 | exact session key、project root、project-owned `PlanStoragePort`、抽象 transcript writer 与 session projection driver | Node filesystem、Session event store、projection registry、tool policy 或 AgentLoop |
| 输出 | `PlanFileManager` 与 projection-backed `PlanTodoPort` | 第二份 plan/todo snapshot、plan file storage provider 或 session disposer |
| durable mutation | `NativePlanTodoRuntime` 继续通过既有 writer 提交 `plan_todo_*` event，再从既有 `plan-todo.state` projection 读取 | 将 todo state 缓存到 Gateway 或 bundle 内存 |
| 生命周期 | bundle 不拥有可释放资源；project execution world 与 session storage 分别保持原有 dispose 顺序 | 提前关闭 plan storage、transcript 或 projection |

focused contract 覆盖 injected project plan storage、exact session fence、approved plan/todo mutation 与 projection snapshot 一致性；
Gateway 现在只消费 bundle 输出。

#### R5.13：SessionSubagentTranscriptBundle（已完成 native M2）

subagent transcript hooks 原本内联在 Gateway session factory 中，同时混合 parent durable reference、child sidechain writer
和 descriptor-before-input 规则。R5.13 将这段 mapping 移入 bundle，但不把 child session、AgentHandle、continuation manager
或 provider ownership 迁入 transcript 层。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| 输入 | parent transcript 的 start/completion record、sidechain factory、relative-path resolver、clock | child AgentHandle、provider registry、continuation inbox、parent/child drain |
| 输出 | 既有 `AgentSubagentTranscriptHooks`：parent start/completion hooks 与 child accepted-input/durable-message writer | 新的 transcript format、第二个 sidechain registry 或 child lifecycle state |
| descriptor | child 首个 accepted input 继续经既有 `recordSubagentAcceptedInputWithDescriptor()` 处理 | 解析后把 descriptor 放入 Gateway 内存或 model-visible content |
| 生命周期 | parent storage 继续拥有 parent log 与 sidechain path factory；child writer 保持独立 sequence/file | bundle 关闭 parent storage、sidechain writer 或续跑 child |

focused contract 以真实 JSONL storage 覆盖 parent `subagent_started`/`subagent_completed`、child accepted input/message 和相对路径；
SubagentDescriptor、continuation manager 与 Web replay regression 同时通过。

#### R5.14：SessionSubagentContinuationBundle（已完成 native M2）

R5.13 只处理 durable transcript mapping，不能替代 continuable subagent 的 live admission 与 teardown。
此前 Gateway session factory 仍同时知道 exact parent binding、child-first drain listener，以及每个 session 的
`subagent`/`send_message` tool consumer registration；这会让 application composition 直接依赖 manager/host 的内部协作。
R5.14 将该真实 consumer 组合收敛到 `SessionSubagentContinuationBundle`，但不移动任何 child 的状态或 lifecycle owner。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| 输入 | 当前 parent `AgentHandle`、已解析 agent config/dependencies、project storage、AgentLoop factory、file-artifact collector 与 continuations facade | 完整 Gateway、SessionRouter、parent/child transcript storage、provider registry internals |
| 注册 | 将 exact parent binding 交给 `SubagentContinuationManager`；为当前 session 注册 `subagent` 与 `send_message` 的既有 tool consumer；安装 child-first drain callback | 新建 turn queue、重写 `followup()`、复制 Agent inbox 或用工具名规则决定 child capability |
| activation owner | bundle 只调用 manager 的窄 attach/follow-up surface | `SubagentContinuationManager` 继续唯一拥有 child activation、parent authorization、settlement、recursive dispose 与 drain |
| child construction owner | 将已准备的 child-session construction 输入透传到 native host path | `NativeSubagentContinuationHost` 继续唯一构造/恢复 child `AgentSession`、其 scope、tool registry 与 dependencies |
| 状态与释放 | parent/child `AgentHandle`、descriptor、inbox、parent log、child sidechain 和 provider generation 都保持原 owner；scope dispose 沿既有 child-first graph 释放 | bundle 不保存 child map、不关闭 project/session storage、不绕过 parent close/recreate 的 exact binding fence |

验收由 Gateway 的 live follow-up、cold follow-up、exact-parent replacement fence 与 parent close 的 child-first drain
覆盖；manager、native host 和 builtin tool contract 继续验证 activation/settlement。这样 R5.14 只移出 composition 知识，
不把 DSH subagent 的 Definition/Provider/Consumer 分离退化为第二个 runtime。

#### R5.15：GatewaySessionModelBundle（已完成 native M2）

session model selection 属于 `llm/model` 的宿主 data-plane consumer，不属于 AgentLoop 或 Router 的状态机。
此前 local Gateway 同时直接读取 transcript replay、写入 `session_metadata`、校验 catalog、检查 active turn、关闭
router session，并在 turn admission 时重复选择 turn/session/default 的 effective model。R5.15 将这些职责按
Definition / Provider / Consumer 分开，而不改变已有 RPC 或 model-input 映射。

| 角色 | 负责内容 | 明确不负责 |
| --- | --- | --- |
| Definition | `SessionModelSelectionPort` 定义 exact project/session preference 的 `read`、`write`、`clear`；`SessionModelSelectionPolicy` 定义 catalog validation 和 default effective model | Transcript entry、Router state、provider execution 或 AgentLoop config |
| Native provider | `NativeSessionModelSelectionPort` 仅通过既有 `createAgentProjectSessionStorage()` 和 `replayTranscriptEntries()` 读取/写入 `model-selection` metadata；`NativeSessionModelSelectionPolicy` 复用既有 catalog/config rules | 第二份 session preference cache、projection runtime、model provider registry 或存储 disposer |
| Consumer | `GatewaySessionModelBundle` 解析 registered project、保留 active-turn fence，按 turn override -> saved explicit selection -> router/default 的既有顺序提供 Gateway callback；成功 mutation 后继续调用 Router close | 绕过 `InProcessGateway` replacement lock、改变配置热加载、直接实例化模型或改变 AgentLoop input |

contract 覆盖 transcript-backed write/read/clear、invalid session key、catalog policy delegation、busy session denial、
turn/session/default precedence、catalog project mapping 和实际 `createLocalGateway` RPC wiring。无协议/schema 变化；model selection 仍只在
Gateway host glue 中投影，durable truth 仍只有 Session transcript。

#### R5.16：GatewaySessionHistoryBundle（已完成 native M2）

Web history、subagent history、fork、replace-last-turn、replacement finalization 与 agent status record 都是
`session/storage` data-plane 的 Gateway consumer。原先 Gateway root 在每个 callback 内重复选择 fallback project、
传入 Pilot home/clock，并让 replace 流程直接看到 process transaction owner。R5.16 仅收敛这段 composition；它不把
transcript、projection、replacement journal 或 status state 搬到 Gateway。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Gateway mapping | 对 read/subagent history、fork、replace/finalize 和 status record 统一应用 optional `projectKey` 的 fallback、Pilot home、clock、history token budget 和 exact transaction owner | 修改 Web message projection、fork point/sidechain copy、replacement atomicity 或 Gateway replacement lock |
| Provider ownership | 调用既有 `readWebSessionMessages`、`readSubagentWebMessages`、`forkWebSession`、replace provider 与 `createAgentProjectSessionStorage` status writer | 新建 transcript cache、Session projection、replacement journal 或第二个 status log |
| Durable state | status 仍由既有 transcript writer 写入；history 仍从 committed transcript/replay 查询 | 关闭 session storage、修改 Router active handle，或把 storage path 暴露给 client |

contract 覆盖 fallback/explicit project mapping、history token budget、subagent/fork/replacement/finalize provider routing、
transaction-owner 透传与结构化 status write；fork/projection、history status、replace transaction 全部既有回归继续通过。
无 schema 或 native/direct 行为变化。

#### R5.17：GatewayUploadedAttachmentBundle（已完成 native M2）

浏览器 upload 已有 `UploadStore` provider：它拥有 project authorization、completion/expiry、disk artifact 和 integrity
verification。Gateway root 先前还内联了“逐 upload verify 后把 artifact 映射为 `ChannelAttachment`”的 consumer，因此 attachment
capability 的 provider/consumer 边界不够清楚。R5.17 将该 mapping 收敛为 `GatewayUploadedAttachmentBundle`；R5.29 进一步
让同一个 consumer 取得 source artifact 的 disk-backed hard-link lease，避免 UI server 和 Gateway process 各自的内存生命周期
影响已接纳的 agent turn。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| 输入 | exact `projectKey`、ordered upload refs 与窄 `acquireAttachmentLease` facade | upload creation/streaming、manifest validation、retention、project registry 或 filesystem ownership |
| 输出 | 在每个 upload 已验证并 leased 后生成原有 ordered `ChannelAttachment`：image/file type、lease path、MIME、bytes 和 upload/attachment/relative-path/hash metadata | 重新定义 hash/project policy、放宽 cross-project/expired/tampered 错误，或写入 Session/AgentLoop state |
| 生命周期 | 每个 accepted upload 只有一个临时 lease；后续 acquire 失败逆序 release，成功结果暴露幂等 aggregate `release()`，由 Gateway turn terminal consumer 调用 | new attachment registry、持久 cache、进程内 shared `UploadStore` 或第二个 attachment storage provider |

contract 覆盖 multi-upload 的 lease acquisition order、selected attachment ids、image/file MIME projection、metadata 保真、partial
acquire reverse release 和 aggregate idempotent release；`UploadStore` persistence/authorization/integrity、两个独立 store instance 的
source cleanup/lease readability、crash-orphan TTL cleanup，以及 Gateway turn terminal release 与 attachment guidance regression 同时通过。
无协议变更，模型可见 attachment 仍由既有 Gateway input builder 消费。

#### R5.18：GatewayCommandCatalogBundle（已完成 native M2）

command list 是非 Agent-scoped extension generation 的只读 consumer。它必须从一个 frozen plugin contribution lease
投影 command，而不能按磁盘和 plugin 分别建立 registry。此前 Gateway root 直接进行 project resolution、plugin refresh、
lease acquire、disk/plugin command projection 与 finally release；R5.18 将完整 consumer 收敛为 bundle。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| 输入 | registered project resolver、project runtime 的 `PluginRuntime` facade、Pilot home 与 `listCommands` projection | plugin discovery/load、generation publish/retire、command registry、disk command storage |
| 生命周期 | refresh 后获取一个 immutable contribution lease；无论 projection 成功或失败都精确 release；release failure 只保留 diagnostic，不覆盖已构造 response | dispose PluginRuntime、延长 lease 到 request 外、让 catalog consumer 控制 plugin reload |
| 输出 | 将同一 lease 的 extension commands 交给既有 disk command projection，维持 disk precedence 和 response schema | 第二份 command catalog、持久 cache 或 Agent scope contribution |

contract 覆盖 registered-project mapping、one frozen lease、success/failure 的 release；真实 Gateway plugin command catalog
和 project registry regression 同时通过。该 bundle 是 extension provider 的短生命周期 consumer，不改变 transport/API。

#### R5.19：GatewayRuntimeRefreshBundle（已完成 native M2）

config reload、extension invalidation、turn-complete maintenance 与 server `config_changed` notification 都是本地 Gateway
application composition 的协调行为，不应继续散落在 `createLocalGateway` 的 Gateway callback 和 watcher closure 中。
R5.19 将这些 callback 收敛到 `GatewayRuntimeRefreshBundle`，但不把任一底层 runtime 的 state 迁入 bundle。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| config refresh | 订阅既有 `PilotConfigStore`，对非 restart-required 变更触发既有 registry reload、router dirty mark、ConfigChange lifecycle dispatch 与 server notification；RPC reload 只暂时订阅本次结果 | 持有 config snapshot、解析 YAML、替换项目 runtime，或改变 restart-required 的告警语义 |
| extension refresh | 接收 Gateway RPC 的 optional project/path input，调用既有 `ProjectRuntimeRegistry.invalidate` 与 Router project/all dirty mark，再投影 notification | plugin generation load/dispose、watcher、command registry 或 extension storage |
| turn maintenance | 按既有开关记录 memory diagnostics，并把 maintenance 请求交给 project registry | 保存 session snapshot、执行 GC，或拥有 SessionRouter cache |
| 生命周期 | `attach()` 精确持有 config subscription；`dispose()` 释放 subscription 与 server binding；`LocalGatewayLifecycleBundle` 在 watcher 停止时调用该释放 | 关闭 ConfigStore、ProjectRuntimeRegistry、SessionRouter 或 server；它们仍由既有 application owner 释放 |

`InProcessGateway` 只保留对 bundle callback 的 consumer delegation。contract 同时覆盖 fake ConfigStore 的 reload/dirty/notification、真实
Gateway 的 RPC reload/extension invalidation，以及 local Gateway dispose 后不再保留 config subscription。该工作包没有新增 config
或 runtime 的第二真源，也不改变 Gateway protocol。

#### R5.20：GatewayTelemetryBundle（已完成 native M2）

live telemetry observer、observing facade 与 collector shutdown 原先分别散在 `createLocalGateway`、bootstrap rollback 和
normal lifecycle bundle 中；其中外部注入的 client 不应被 Gateway 关闭，observer 也不能成为 durable Session event 的替代品。
R5.20 以 `GatewayTelemetryBundle` 固化该 application-owned ownership。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | 暴露 wrapped `TelemetryClient`、live `TelemetryObserverRegistry` 与幂等 `dispose()`；factory input 明确 env、Pilot home 和 optional injected client | 定义新的 analytics event、Session event vocabulary、provider telemetry policy 或 observer business contract |
| Native provider | 未注入时创建既有 collector；为它包裹既有 observing client；先 stop/drain observer，再关闭自己创建的 collector；任一释放失败仍继续后续释放并聚合 | 关闭调用方注入的 client、持久化 observer、阻断 telemetry caller 或拥有 telemetry sender 的队列状态 |
| Consumer | `createLocalGateway` 只消费 wrapped client/observer registration；bootstrap rollback 与 `LocalGatewayLifecycleBundle` 都委托同一个 dispose owner | 把 telemetry state 复制给 Gateway、Router、AgentSession 或 PluginRuntime |

contract 覆盖 collector creation、live observation forwarding、idempotent owner disposal、injected client 保持 caller ownership，以及
observer dispose 失败时 native collector 仍会关闭。现有 observer replacement/drain、Gateway lifecycle、bootstrap rollback 与 project
runtime disposal回归继续通过；这只完成 live telemetry 的 application composition，不把 telemetry 标记为可 replay 的 durable state。

#### R5.21：ProjectModelRuntimeBundle（已完成 native M2）

每个 project runtime generation 需要根据 profile 选择完整 `ModelRuntime` 注入、provider factory，或由配置创建 native
provider registry；此前这个选择和 registry disposal 混在 `ProjectRuntimeResourcesBundle`。R5.21 将其收敛为 DSH `llm/provider`
的 application composition，而不是把 Router 或 session selection 复制进 model module。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | 输出 registry-backed `ModelRuntime` 和 `ModelInvocationProviderRegistry`，并提供幂等 `stage`/`dispose` | Router fallback/retry/health policy、canonical request materialization、session metadata 或 Gateway RPC |
| Native provider | provider factory 优先于完整 runtime factory；两者均缺失时从 parsed model config 注册 native provider；只 dispose 自己的 provider registry | dispose 注入的完整 `ModelRuntime`，或持有 provider 以外的 project runtime resource |
| Consumer | `ProjectRuntimeResourcesBundle` 接收 staged `model`/`modelProviders`，仍以既有 resource disposal order 释放 model bundle | 改变 `ProjectRuntimeRegistry` generation、provider lease、Router invocation contract 或 AgentLoop dependency |

contract 覆盖 registry-backed invocation、provider generation、injected complete runtime 的 caller ownership，以及 duplicate provider 导致 stage
失败后已注册 provider 的 cleanup；project reload、in-flight provider lease 和 Router registry invocation 回归保持通过。

#### R5.22：ProjectExecutionWorldBundle（已完成 native M2）

project runtime 先前同时选择 sandbox mode、创建 execution world、注册 base builtin tools、连接 extension skill loader 和读取
web-search 配置；这使 execution provider 的 lifecycle 与 session tool composition 混在同一个 application resource bundle。
R5.22 按 DSH execution provider boundary 将它们收敛，但不改变更细粒度 execution port 的 owner。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | 输出 project-scoped `ExecutionWorldBundle` 与唯一 base `ToolRegistry`，并提供 idempotent `stage`/`dispose` | 新的 ToolPort、permission policy、tool scheduler、session tool registry 或 MCP lifecycle |
| Native provider | 根据 `agent.sandboxMode` 选择 injected/native execution world；以该 world 的 fs/shell/subprocess/code/sandbox/task ports 创建既有 builtin registry，注入只读 skill loader、web-search profile 与 extra tools | 改写任何执行 port 的副作用/timeout/abort 语义，或把 Agent terminal tool、platform sandbox 和 detached task state 包装为新 runtime |
| Consumer | `ProjectRuntimeResourcesBundle` 只消费 staged world/tools，并在既有 project generation dispose 中委托 bundle | session-specific MCP、extension availability filter、Always-On surface 和 permission context；它们继续由已有 session bundle/consumer 决定 |

contract 覆盖 selected sandbox profile、single base registry 的 builtin/extra tool visibility、exact provider creation、idempotent world
dispose，并与现有 project generation cleanup、execution-world/sandbox、code runtime 和 task tool port 回归同时通过。R4-B 尚未完成的
Agent terminal tool、跨平台 sandbox 与 reconnect 不因本工作包而改变状态。

#### R5.23：ProjectMemoryBundle（已完成 native M2）

EdgeClaw memory 的 provider/service construction 和 close 原先与 model/router/plugin/execution resource 一同留在
`ProjectRuntimeResourcesBundle`，而 project registry 的 maintenance loop 又依赖 service。R5.23 只分离前者，保持
maintenance scheduling 的唯一 owner 不变。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | 输出 optional `EdgeClawMemoryProvider`/`EdgeClawMemoryService` 及 idempotent `stage`/`dispose` | memory retrieval/capture API、Session projection、maintenance event 或 telemetry schema |
| Native provider | 将 project root、parsed memory/model config、agent model、clock 和 telemetry 输入既有 EdgeClaw factory；enabled profile 才创建 service，dispose 时只 close 本 bundle 创建的 service | 创建并运行 maintenance scheduler、重试 index/dream、缓存 session memory 或将 memory state 写入 Agent transcript |
| Consumer | `ProjectRuntimeResourcesBundle` 消费 staged provider/service；`ProjectRuntimeRegistry` 保留 service 的 coalesced maintenance request、错误 telemetry 和 generation lease | 更改 ContextRuntime memory resolver、compaction policy 或 Gateway session lifecycle |

contract 覆盖 enabled/disabled profile、exact provider input、idempotent exact close，以及 project resource cleanup；context prompt、compaction
和 project runtime lifecycle 回归继续通过。该工作包不宣称已完成 memory 的 durable replay 或 background scheduler profile。

#### R5.24：ProjectRouterRuntimeBundle（已完成 native M2）

DSH `llm` 将 provider adapter 注册、一次模型调用、重试和其它 policy 分为独立责任：调用入口不拥有 provider wire
logic，也不把 retry 执行塞入 adapter。PilotDeck 的 `RouterRuntime` 已承担 route/fallback/health 等既有 policy，但此前它与
`TokenAccountingRuntime` 的 project composition、完整 `ModelRuntime` 注入分支和 registry-backed invocation 分支仍混在
`ProjectRuntimeResourcesBundle`。R5.24 只提取这些 application-owned 构造和 shutdown 责任。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | 输出 project-scoped `TokenAccountingRuntime` 与 `RouterRuntime`，并提供 single-stage、idempotent `dispose()` | 定义新的 model request、Router policy、session model preference 或 AgentLoop dependency |
| Native provider | 依据现有完整 `ModelRuntime` 注入条件保留 direct runtime branch；否则从 R5.21 staged `ModelInvocationProviderRegistry` 建立既有 registry invocation port；将 project-owned session custom-router registry、skill prompt facade、Router event bus、telemetry 和 clock 交给既有 router factory | 注册/关闭 model provider、加载/卸载 plugin generation、创建 second router、重写 request materialization、fallback/retry/cache/health/usage policy |
| Consumer | `ProjectRuntimeResourcesBundle` 只消费 staged router/token accounting，并在 project generation cleanup 中委托 router shutdown | `ProjectRuntimeRegistry` 的 generation publish/retire、lease、session composition，或 Gateway 的 session model selection/turn lifecycle |

contract 覆盖 complete injected `ModelRuntime` 与 registry-backed invocation 两条既有分支；后者继续验证 provider-health
generation。Router request materializer、usage observer、project runtime provider lifecycle 与 bundle dispose 一同回归，确保
Router 关闭不越权关闭 model registry 或 plugin runtime。此项完成的是 DSH 式 `llm/router` application composition，未宣称
Router policy 已可由 profile 替换，也未引入第二个 model、router 或 session state owner。

#### R5.25：ProjectSessionRuntimeBundle（已完成 native M2）

`ProjectRuntimeRegistry.prepareSessionRuntime()` 原先同时取得 generation/rule-set retain、刷新 plugin、冻结 contribution，
并把 MCP/tool、interaction、context、live projection、subagent continuation 和 storage extension closure 直接拼装在 registry 内。
R5.25 将这段 per-session application composition 收敛到 `ProjectSessionRuntimeBundle`。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | 输出 base dependencies、storage extension、session disposer 所需的 exact resource lease 与 scope configure callback | 定义第二份 session state、storage/projection、ToolRegistry、Gateway pending queue 或 AgentLoop execution |
| Native composition | 只消费已发布的 project generation；以一个 frozen plugin snapshot 装配 MCP/tool/interaction/context/subagent consumer；任何 stage failure 都逆序释放 permission/plugin/MCP/project retain | publish/retire project generation、替换 session、关闭 project runtime，或重新实现 child activation/host construction |
| Consumer | `ProjectRuntimeRegistry` 只解析 project/override 与窄 Gateway facade，消费结果创建或重建 session | 改变 `resumeAgentSession`、`createAgentSessionWithStorageAsync`、Gateway session router 或 storage owner |

contract 覆盖 plugin refresh failure 的 permission/project retain reverse release；同一轮还回归真实 session creation、shared/per-session
MCP generation drain、project retirement，以及 session tool/interaction/context/subagent composition。该 bundle 不持有任何跨 session
registry，dispose 时仍由已存在的 Agent scope/session disposer 释放 exact resource lease。

#### R5.26：SessionAgentConfigBundle（已完成 native M2）

agent config 是 session data-plane 的一个 immutable view，而不是 `ProjectRuntimeRegistry` 的状态。R5.26 将 model/subagent
capability lookup、env output cap、workspace override、interaction prompt flag 与 live permission rule snapshot 收敛为
`SessionAgentConfigBundle`；create/recreate 使用同一份在 session composition 时确定的 config。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | 输出一个 `AgentRuntimeConfig`，保持既有 model capability missing 时的 text-only/fail-soft fallback | 选择或关闭 ModelRuntime、写 SessionConfigOverrides、更新 permission rule-set 或持有 AgentLoop |
| Consumer | `ProjectSessionRuntimeBundle` 在取得 exact rule-set 与 interaction profile 后构造 config；registry 仅把该 config 交给 create/recreate | 新建 permission policy、改变 Router selection、改变 session storage 或 subagent manager state |

contract 覆盖 model/subagent capability、`PILOTDECK_MAX_OUTPUT_TOKENS`、workspace、permission rules、bypass/canPrompt
与 depth/timeout mapping；project/session lifecycle 回归保证抽取不改变 native create/recreate 行为。

#### R5.27：GatewaySubagentRuntimeBundle（已完成 native M2）

native subagent provider、provider registry、host、manager 和 child configurator 原先在 Gateway root 手工装配。R5.27 将这族
native provider 收敛为 `GatewaySubagentRuntimeBundle`，使 bootstrap 和 normal shutdown 都消费同一组 exact owner。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Native provider | 创建并注册 native provider；创建 host/manager，并将 child session configurator 绑定到既有 `SessionSubagentContinuationBundle` | 创建第二个 child registry、重写 manager activation/settlement，或让 host 拥有 parent session |
| Lifecycle | boot rollback 通过 `dispose()` 依序 drain manager、dispose provider 和未发布 agent registry；正常 `LocalGatewayLifecycleBundle`/`SessionRouter` 继续按 Gateway 全局顺序消费同一 manager/provider/registry | 改变 Gateway admission、session router、project generation 或 Agent scope tool cleanup 顺序 |
| Consumer | `createLocalGateway` 只消费 agent directory 与 continuation facade；session composition 继续以窄 continuation facade 绑定 exact parent | 将 provider generation、cold resume descriptor、child storage 或 tool registration 移入 Gateway root |

contract 覆盖唯一 native provider identity、continuation facade reference、幂等 dispose；既有 manager materialization/cold resume、
Gateway live/cold follow-up、bootstrap rollback 与 lifecycle drain 测试继续通过。此项不改变 `AgentLoop.ts`，不引入第二个
subagent state owner。

#### R5.28：PilotDeckServerBootstrapBundle（已完成 native M2）

DSH `dsh-app-boot` 的关键不是把启动步骤包进一个函数，而是把启动期间已经获得的 provider 交给一个临时 owner；任一后续
步骤失败时，owner 必须按依赖逆序清理，成功 publish 后才转交长期运行时。此前 `pilotdeck server` 在本地 Gateway 和
automation 已经建立后，automation attach/start、channel adapter 或 HTTP/WebSocket server assembly 任一步失败，可能遗留
Gateway 或 telemetry collector。R5.28 以 `PilotDeckServerBootstrapBundle` 固化这个 unpublished bootstrap transaction。

| 边界 | Bundle 负责 | 明确不负责 |
| --- | --- | --- |
| Definition | 在 `commit()` 前拥有 automation、local Gateway 与 telemetry 的 rollback capability；`run()` 将 attach、channel/server assembly 纳入同一失败边界 | 定义新的 server/channel lifecycle、config watcher、process signal 或 runtime business state |
| Native composition | `automation.attach()` 后启动 automation；任一步失败按 `automation.stop -> disposeGateway -> telemetry.shutdown` 继续清理，单个 cleanup 失败仅告警而不阻断后续 cleanup | 关闭已发布的 server/channel handle，或把 session/router/project runtime 的 owner 迁入 CLI bootstrap |
| Consumer | `pilotdeck.ts` 在构造 `ProjectAutomationBundle` 和 local Gateway 后创建 bootstrap；server 成功创建并构造既有 `PilotDeckServerShutdownBundle` 后调用 `commit()` 转移长期 shutdown ownership | 取代 `PilotDeckServerShutdownBundle` 的运行时停止顺序，或改变 automation reload 与 Gateway admission 语义 |

contract 覆盖 automation-start failure、server/channel assembly failure、`commit()` 后不再由 bootstrap 回滚，以及既有 server
shutdown/channel lifecycle/automation reload。该项只补 DSH 式 boot transaction 的临时 ownership；完整 profile/bundle patch
tree、interactive/headless/sidecar provider selection 仍是后续 R5 的 composition gate。

#### R5.29：UploadArtifactLease（已完成 native M2）

`UploadStore` 的 metadata 和 source artifact 原本已经落在 project `.tmp/chat-uploads`，但 UI server 与 local Gateway 各自的
`UploadStore` 实例没有共享 in-memory lifecycle。Gateway 只拿到 source path 时，UI retention cleanup 可以在模型 turn 仍在读取
attachment 或稍后调用 `read_file` 时删除该文件。R5.29 不把两个 process 强行合并为 singleton，而是在已有 provider 内新增
`acquireAttachmentLease()`：通过同 project disk-backed hard link 输出可释放的 turn-local artifact view。

| 边界 | 负责内容 | 明确不负责 |
| --- | --- | --- |
| Definition | `UploadArtifactLeaseProvider`/`UploadArtifactLease` 定义 source artifact 的 temporary consumer capability；`UploadedAttachmentResolverPort` 定义 Gateway turn 取得 mapped lease attachment 的唯一 callback contract | upload/session/Agent state、UI SSE state、通用 attachment registry 或新的 durable event vocabulary |
| Native provider | `UploadStore` 在 project/expiry/completion/hash 验证后建立 hard link，保留 source metadata/artifact/retention owner；cleanup 删除过期 source，按 bounded TTL 删除 crash-orphan lease | 让 UI server 持有 Gateway turn、让 Gateway 管理 upload retention，或将 lease 放进内存 Map 作为跨进程真源 |
| Consumer/composition | `GatewayUploadedAttachmentBundle` 聚合 exact upload lease，partial acquire 逆序释放；`InProcessGateway` 在 agent pump 的 terminal `finally` 调用 aggregate release | 改变 attachment input schema、AgentLoop、Session durable state、attachment MIME/model projection 或 tool authorization |

两个独立 `UploadStore` 实例的 contract 证明：UI cleanup 删除已过期 source 后，已接纳 Gateway turn 的 lease path 仍可读；terminal
release 会立即回收 lease，异常退出未 release 的 lease 由 TTL cleanup 回收（UI provider 可用 `PILOTDECK_UPLOAD_LEASE_RETENTION_MS`
显式配置）。此项完成 browser upload 的跨进程 artifact lifecycle，
不宣称所有 channel 或外部 attachment 都已具备同一 durable provider。

#### R5.0：ProjectAutomationBundle（已完成 native M2）

本轮已把当前 `src/cli/pilotdeck.ts` 中 Always-On/Cron 的真实组合收敛为 application-owned
`src/cli/ProjectAutomationBundle.ts`，不引入通用 DI 容器、profile registry 或新的业务 state owner。bundle 负责构造 native
provider、暴露其静态 tool contribution、在拿到 Gateway 后绑定窄 facade、发布 `SubsystemUpdate`，并负责启动、热重载和停止。
`AlwaysOnManager`、`CronManager` 继续分别拥有 scheduler、store、active run 与本身的 stop/drain；Gateway 仍只是
`AlwaysOnControlPort`、`CronControlPort` 和 agent-turn facade 的 consumer。

| 阶段 | bundle 允许做的事 | 不允许做的事 | 可验证结果 |
| --- | --- | --- | --- |
| stage | 从 config 构造未启动的 manager；输出初始 `extraTools`、`sessionOverrides`、cron controller | 启动 scheduler、写业务 store、改变 Gateway controller | 构造失败不影响当前 generation |
| attach/start | 以 `AlwaysOnAgentGatewayPort`/`CronAgentGatewayPort` 绑定 Gateway；依序启动 Always-On、Cron；成功后一次性 `updateSubsystems` | 让 manager 依赖完整 `Gateway`，或把 manager state 放入 `InProcessGateway` | 启动顺序稳定；任一启动失败按 `cron -> always-on` 逆序 stop，CLI 释放尚未就绪的 Gateway，且 bundle 不发布失败 generation |
| reload | 无副作用 stage 新 generation；停止旧 generation 后启动并发布新 generation；新 generation 启动失败时先清理半启动资源，再重建并恢复旧 generation，恢复也失败时显式报告 degraded 状态 | 让两个 scheduler 长时间并行争夺同一 project store，或仅替换 tool list 而遗留旧 controller | build/start failure、stop order、rollback 与 controller publication 均由 fake manager contract 覆盖 |
| stop | 停止接纳新 reload；先停 Cron，再停 Always-On；由 CLI 继续负责 Gateway、server、channel 与 telemetry 的外层停止 | 越权 dispose Gateway、SessionRuntime 或 telemetry provider | stop 幂等，in-flight run 由各 native manager 原有 drain 语义结算 |

Definition 限制为 bundle lifecycle 与 `SubsystemUpdate` 视图，Consumer 仅为 `pilotdeck.ts` server command；没有把
`ProjectRuntime`、`SessionMcpRuntimeRegistry` 或 `ExecutionWorldBundle` 一并迁入。`tests/cli/project-automation-bundle.spec.ts`
已覆盖空 bundle、正常启动/停止顺序、Always-On/Cron 启动失败的逆序清理、reload build failure 保留旧 generation、仅 Cron
替换不触碰 Always-On、reload start failure 后旧 generation 恢复，以及 `getTools()` 与 published `SubsystemUpdate` 的 generation
一致性。后续以相同 lifecycle contract 引入 interactive/headless/sidecar provider selection，而不是直接复制 DSH 的 Cordis
profile 文件格式。

### 14.7 R1 的实现检查点

R1 不是“先增加一个 event bus”的任务。DSH 的 `scopeTarget()` 是一个有真实 Cordis listener consumer 的路由 carrier。
R1-A 已补上两条真实 consumer。`HookRuntime.subscribeExecutionEvents()` 以 `sessionId` 标记每个 hook transition，
`createGatewayHookExecutionProjection()` 只向同 session 的 active Gateway stream 投影
`hook_execution_started`/`hook_execution_completed`，并刻意丢弃 stdout/stderr。`BackgroundTaskRuntime.subscribeCompletionEvents()`
则从 project-owned task provider 发出 typed completion event，`createGatewayBackgroundTaskCompletionProjection()` 只向创建 task
的同 session active Gateway stream 投影 `background_task_completed`。两类 subscription 均由 session scope 的 `own()` 持有；
scope teardown 只解除 exact subscription，task provider 不被 session dispose。两者都是 live-only，绝不写入 Session event log。

这证明了 producer、consumer、composition 与 exact owner，但并不把当前 session-local bus 宣称为 DSH 的完整
`scopeTarget()` 等价物。直接泛化成全局 scope infrastructure 仍会得到没有具体 consumer 的第二套 live state。

因此 R1 必须按以下顺序推进，任一步不满足时停在设计检查点，不写通用抽象：

| 子项 | 必须先冻结的事实 | 允许的实现范围 | 退出条件 |
| --- | --- | --- | --- |
| R1.0（已完成） | `HookRuntime` 是 producer，Gateway active-turn status 是 consumer；payload 仅含 sessionId、hook 名称、hook event、outcome/exit code | `HookExecutionEventBus` 给出 typed active/dispose registration；Gateway projection 过滤异 session 并丢弃 stdout/stderr；不得改变 Gateway protocol 或 `AgentLoop.ts` | real Gateway stream、session filtering、stdout/stderr 脱敏、subscriber failure isolation、scope-owned disposal 的 contract test 均通过 |
| R1.0b（已完成） | project-owned `BackgroundTaskRuntime` 是 producer，Gateway active-turn status 是 consumer；payload 仅含 task completion DTO 与 sessionId | completion bus 给出 failure-isolated typed registration；Gateway projection 过滤异 session，subscription 由 `AgentRuntimeScope.own()` 释放，scope dispose 后 task runtime 仍可完成 task；不得写 durable event 或创建 inbox/wakeup | projection DTO、real Gateway active-turn、subscriber failure isolation、session filter 与 scope teardown 后 provider 继续可用的 contract test 均通过 |
| R1.0c（已完成，native M2 composition） | 同一 session 已有两条真实 live projection；此前 `createLocalGateway` 手工创建、分别注册并在局部 catch 中回滚 subscription | `GatewaySessionLiveProjectionBundle` 只接收 exact session key、scope、hook/task event source 与 Gateway emit；先建立两条 subscription，再将一个逆序 disposal effect 注册给同一 scope。第二条建立或 scope registration 失败时，精确释放已建立 subscription；不持有 task/hook runtime、不写 Session event、不建立全局 carrier | `gateway-session-live-projection-bundle.spec.ts` 覆盖两条投影、跨 session 过滤、scope dispose 后停止投影、task subscribe 失败 rollback 与 `scope.own()` 失败时双 subscription rollback；既有 hook/task projection 与 Gateway integration 测试保持通过 |
| R1.1（局部完成） | contribution 是否确有跨 prompt/tool/hook registry 的共享需求。当前 session-owned prompt/tool/hook contribution 已有冻结 plugin lease，不能因目录相似而复制 registry | Gateway hook/task consumer 已使用同一 `AgentRuntimeScope.own()` exact registration；通用 contribution layer 仍只在真实跨 registry 需求出现时考虑 | 当前 exact scope 可以回收 hook/task projection；child shadow/blocked policy 仅适用于现有 service/registry，不得凭此宣称 generic contribution registry 已完成 |
| R1.2（已完成，native M2） | event 的异步 delivery、错误隔离和 release 顺序。live carrier 不承载 Session replay、pending hook 或 operation terminal truth | `AgentScopeLiveEventBus` 由每个 `AgentRuntimeScope` 创建并在 child scope 上绑定 parent identity；publish 仅将 event 交给 exact scope 与 ancestor subscription，按 subscriber 所在 scope 计 in-flight。scope `dispose()` 同步关闭 live event admission，随后等待既已准入的 handler drain 再撤销 subscription。`GatewaySessionLiveProjectionBundle` 将 hook/task source 转发为 volatile event，再在同 scope 注册 Gateway projection consumer；source subscription 仍由 exact scope effect 释放 | `agent-runtime-scope.spec.ts` 覆盖 ancestor-only routing、sibling/parent 隔离、stop-new、late event、subscriber failure isolation、child delivery 命中 ancestor subscriber 时的 drain；`gateway-session-live-projection-bundle.spec.ts` 覆盖真实 source -> scope bus -> Gateway projection、session filter 和 rollback。所有 focused tests 与类型检查通过 |

R1 的边界映射固定如下：`ScopedServiceRegistry` 继续提供 service lease/replacement/drain；
`SessionRuntime` 继续是 durable truth；`PluginRuntime` 的 frozen contribution lease 继续持有 plugin generation；
`SessionMcpRuntimeRegistry` 继续是 per-session MCP runtime owner。新 carrier 只能连接这些 owner，不能取代或平行复制它们。

R2-A 已完成 MCP runtime call seam：`McpRuntimePort` 和 `McpRuntimeFactory` 让 MCP-to-tool bridge、shared provider 与 per-session
composition 都只依赖 provider-neutral contract，native provider 继续复用既有 `ProjectRuntime` staging/retire 与
`SessionMcpRuntimeRegistry` exact registration。

R2-A.1（已完成，native M2 lifecycle composition）补齐 session resource lease 的失败路径：
`GatewaySessionResourceLeaseBundle` 是唯一的 session preparation cleanup owner，只记录 release effect，不接管 project runtime、
plugin runtime 或 MCP runtime 的状态。它按 acquisition 的逆序释放 `per-session MCP -> plugin contribution -> project runtime`，
同一个幂等 `release()` 同时供正常 session dispose 和 preparation 早期失败使用；即使某个释放失败，后续 effect 仍会执行并
聚合报告。`gateway-session-resource-lease-bundle.spec.ts` 覆盖逆序、幂等、release 开始后拒绝新增 lease，以及中间失败仍继续清理。

R2-A.2 已在 frozen `mcpServers` signature 上完成 shared runtime generation lease：session 获取精确 generation，
新 snapshot 发布新 generation，旧 runtime 等最后一个旧 session lease 释放才 stop；startup 失败的候选不会中断仍被
lease 的旧 runtime。`SessionMcpRuntimeBundle` 已接管 shared/per-session bridge 与 session-local ToolRegistry snapshot，
并交给既有 session resource lease 统一释放。真实 Gateway contract 已覆盖 plugin MCP server 改动后新旧 session
分别绑定新旧 runtime 的路径。

R5.9 已将这份 MCP composition 与 session tool policy/availability/extension registration 一起从 Gateway root 收敛。
R2 的下一步是为 plugin reload/removed provider 或 LSP 选择真正 lifecycle consumer；command catalog 保持只读 projection，
telemetry 保持 live-only observer。没有具体 consumer 时，不创建通用 provider registry。

### 14.8 DSH jobs 对照与 R4-A 设计门

DSH 的 jobs 不是把后台 shell 包成一个工具实现：`dsh-jobs` 定义 `start/list/get/read/kill/wait` 和 exact owner 的
可见性、teardown、listener contract；`dsh-jobs-local` 承担本进程 registry、owner disposal 和 settlement；`dsh-tool-jobs`
才把控制工具与 completion notice/wakeup 接入 agent。三层共同保证 provider、tool consumer 和 owner lifecycle 不相互偷取状态。

PilotDeck 的 task-control seam 已完成：`BackgroundTaskPort` 提供工具需要的最小 Definition；`BackgroundTaskRuntime`
消费 `DetachedShellPort` 并提供 native implementation；`ExecutionWorldBundle` 由 `ProjectRuntime` 拥有并在 reload/dispose
时释放；`task_create`、`task_list`、`task_output`、`task_wait` 和 `task_stop` 是确定的真实 consumer，`createBuiltinRegistry`
只接收 port。任务 completion 通过 failure-isolated typed subscription 仅投影到 exact session 的 Gateway live `agent_status`；
subscription 属于 session scope，task provider 仍属于 project execution world。它不能作为 Session durable truth 或 agent inbox。

R4-A 已按下列边界完成：

1. 在 `src/task/runtime/` 或等价 task protocol 目录定义最小的 provider-neutral request/result 与 `BackgroundTaskPort`；不能从
   Definition 导入 `BackgroundTaskRuntime`，也不能把 `DetachedShellPort`、Node child-process 或 Gateway 类型暴露给工具。
2. 令 `BackgroundTaskRuntime` 保留 native provider 和 project lifetime；`ExecutionWorldBundle` 不需要为了 consumer port 拆成
   per-agent registry。`taskTools.ts` 与 `createBuiltinRegistry.ts` 改为只接受该 port。
3. 用 fake port contract 覆盖全部五个工具的格式化与错误映射，并保留 native detached-shell 的 start/stop/drain 测试。
   这确保端口抽取不改变 timeout、abort、output offset、terminal status 或 `unsupported_tool` 行为。

R4-A.2 已补上当前 product surface 需要的 owner/settlement 条件：`task_create` 继续把 tool session 写为 task owner，
随后所有模型可见的 list/read/wait/stop 都传入同一 exact `BackgroundTaskAccess`；其它 session 的 id 被视为 unknown，
不可枚举、读取、等待或终止。provider `exit` rejection 不再使 `wait()` 悬挂，而是记录 `failed`、追加可诊断 output，并走
同一 completion path；`TaskOutputStore` 串行执行已接纳 spill write，runtime dispose 在 drain 后才返回。

R4-A 的明确非目标仍是 task restart/reconnect、PTY、completion inbox/wakeup、Session event/projection、durable job record、
插件热替换和 sidecar transport。若产品需要把 DSH 的 owner-scoped completion 通知引入 PilotDeck，必须先指定唯一的
`AgentHandle`/inbox consumer、idle wake budget、owner dispose/cold resume 行为和 durable event vocabulary；该项在 R1/R3/R5
基础完成后单独评审，不能借一次 type-only port 抽取隐式改变用户可见任务语义。

### 14.9 R4-C orchestration capability 的实施门

本组把此前合并为“workflow/goal/plan/todo/always-on”的条目拆开，因为它们的 owner 完全不同：`plan/todo` 是 session
capability，`always-on` 是 project orchestration，`workflow/goal` 目前没有经批准的 PilotDeck 业务语义。它们不能共用一个
registry，也不能把 `AlwaysOnRuntime` 当成通用 workflow provider。

1. **R4-C.1 plan/todo（已完成，native M2）**：DSH `tool-todo` 把 whole-list write 写入 agent session event，并由 projection
   决定 view。PilotDeck 已以 `PlanTodoPort`/`NativePlanTodoRuntime` 保持 `AgentLoop` 现有 handle 形状不变，但把 approved-plan、
   todo write、progress 和 diagnostics 写入 `plan_todo_*` SessionRuntime vocabulary，并由 `plan-todo.state` 从 committed log 或
   checkpoint+tail 重建。`todo_write`、plan mode 和 successful side-effect tool call 共享该 owner；local Gateway 在 storage 恢复后
   逐 session 装配 provider。旧 `createPlanTodoStateManager()` 不参与 production composition，仅为没有 projection 的兼容测试/嵌入式
   caller 保留。DSH 的 todo 在下一 `turn/start` 清空，而 PilotDeck 的 approved plan checklist 有意跨 turn 持续；这是产品语义差异，
   不等于缺少 durable projection，也不应被误称为 DSH 的完整 profile/bundle parity。
2. **R4-C.2 always-on（已完成 native M2）**：`AlwaysOnRuntime` 继续拥有 scheduler、run context、workspace registry、
   独立 event/store 和 `stop()`，但不再接受宽 `Gateway`。`AlwaysOnAgentGatewayPort` 只暴露 `submitTurn`/`abortTurn`/`closeSession`，
   `AlwaysOnControlPort` 暴露 apply/rerun/abort；`DiscoveryFire`、runtime、manager 与 standalone apply 都依赖前者，Gateway RPC
   只依赖后者，CLI 是唯一的 composition root。abort 的 session key 来自现有 `always-on:turn-event` 通知；runtime 只允许 active
   run context 或 in-flight control run 已拥有的 key，并将请求交给普通 Gateway abort，返回的 `aborted` 不等同于工作流 terminal
   成功。standalone 对 abort 与 rerun fail-closed。runtime stop 先 stop-new，再等待 scheduler tick 与已经接纳的 control run，令其沿用
   原有 session close、override removal 和 workspace terminal cleanup。durable discovery records 仍不写入交互 AgentSession，也不能
   被 transport reconnect 改写。worktree cleanup reload E2E、profile/bundle provider selection 与 remote/sidecar E2E parity
   仍是后续工作，不能把当前 native control seam 描述为完整 DSH workflow/schedule parity。
3. **R4-C.3 workflow/goal**：DSH `WorkflowEngine.start()` 返回 holder-owned live run，并明确 start/end event、取消、child
cleanup 与 listener containment。PilotDeck 还没有等价产品 caller；因此先要求设计文件冻结 owner、state source、cancel/
timeout、settlement、restart 和 child AgentHandle/inbox 的唯一所有权。没有这些事实，不建立空的 `WorkflowPort`、goal store
或泛化 event bus。

### 14.10 本轮收敛后的近期执行队列

下表是从当前实现反推的执行顺序，而不是对 DSH 包名逐项对齐。每项都以前一项的 owner、state source 和
composition 边界保持不变为前提；除非出现明确的产品 caller，禁止为 `workflow`、`goal`、通用 contribution registry
或通用 provider registry 预建空抽象。

| 优先级 | 工作包 | 当前事实与最小改动 | 验收条件 | 明确非目标 |
| --- | --- | --- | --- | --- |
| P0 | R0 基线收敛 | 逐项复跑本 worktree 已落地 seam 的 focused contract；将 UI React 18/19 type-resolution 基线问题与本轮改动分离 | `git diff --check`、受影响 TS/Node contract 均通过；失败有最小修复或明确的环境/既有基线记录 | 不以全量 UI typecheck 的既有失败否定 runtime seam |
| P1 | R5.30 Session catalog application consumer 收口（已完成 native M2） | `SessionInfo`/list input 已属于 catalog Definition，JSONL `SessionList` 仅为 Node provider/compat re-export；`ChatDigestBuilder`、`AlwaysOnChatHistoryTool`、Web history metadata 与 Web project activity view 已只依赖只读 `SessionCatalogPort`。`AlwaysOnRuntime`、`AlwaysOnManager`、standalone apply、`ProjectAutomationBundle`、`GatewaySessionHistoryBundle` 和 local Gateway composition 均透传 application-selected provider；server mode 以同一 Node provider 同时装配 Gateway 与 automation | fake catalog 已证明 digest/history/history metadata/project summary 均以精确 `projectRoot`/`pilotHome` 调用；application consumer 不再直连 `listProjectSessions`；Definition 不导入 JSONL provider；automation 正常/standalone、Gateway history bundle 与 local Gateway composition 均透传 exact provider，transcript 读取、别名/标题和 Web replay 保持 | catalog 不拥有 `SessionRuntime`、writer、projection、retention 或 transcript I/O；consumer 内不得悄悄 new Node provider |
| P2 | R5.31 Session query/search application seam（已完成 native M2） | `/search` 的 Definition 已从 Node/JSONL 扫描实现中分离；CLI 与 IM command 只消费 `SessionSearchPort`，CLI/server composition 选择 Node provider | 全项目扫描、单 session、regex、大小写、role、internal session、title recovery、limit/truncate 与 streaming JSONL 行为保持；fake provider 证明 CLI/IM consumer 的输入映射；生产 consumer 不再 import native search | 不实现 SQLite/FTS、分页、SessionRuntime query service 或 durable query index；不把 catalog 扩成过宽的 history port |
| P3 | R3 durable pending hook 设计门 | 仅当存在可恢复/取消的业务 hook caller 时，先定义唯一 session event、projection、resume/cancel consumer 和 owner-dispose 规则 | restart、timeout、late completion、cancel 与 owner dispose 均从同一 log 推导；live `AsyncHookRegistry` 只做 executor | 不把 live event bus 或 hook registry 当 durable state |
| P4 | R4-B execution 收尾 | 以独立 capability contract 处理 Agent terminal tool、task reconnect 和 Linux/Windows process sandbox；保留既有 Fs/Subprocess/Shell/DetachedShell 的 owner 与并发语义 | abort、EOF、kill、reconnect、policy denial、old-owner fence 和 cleanup 有 native/受限 profile 对拍；缺少平台实现时 fail-closed | 不把 UI PTY registry 直接暴露为 Agent tool，也不把 reconnect 与 durable job 语义混在同一工作包 |
| P5 | R2 非 Agent-scoped extension lifecycle | 只为已有真实 consumer（优先 LSP 或 plugin removed/reload 路径）补 generation lease、staging、retire 与 drain；继续让 command catalog 做只读 projection、telemetry 做 live observer | replacement 不影响已获 lease 的 session；失败 staging 保留旧 generation；removed provider 精确 dispose 一次 | 不建立没有 consumer 的全局 provider registry |
| P6 | R5 profile / boot 收尾与部署 parity | 在 R5.32 已完成的 native runtime profile 上，补 native/headless/sidecar 的 deployment provider selection、缺 provider 诊断、完整 boot rollback、remote/sidecar interaction、compaction 与 subagent parity | profile 只选择 provider，不保存业务状态；启动失败逆序回滚；同一 Definition 的 native/remote contract 对拍 | 不复制 Cordis API、DSH 文件格式或第二份 application dependency bag |

R5.30 已消除 Gateway、Web 与 Always-On application consumer 对 JSONL 会话列表实现的直接依赖。`readTranscript`/
`readSessionLite` 仍是各自的文件投影 consumer，只有在它们出现多 provider 或 retention/restart 需求时才另立 capability；这避免
把所有会话读路径误并为一个过宽的 Session port。R5.31 已完成。P3 仍是设计门而非可排期实现：只有出现明确的可恢复/取消业务
hook caller 才启动。当前下一可执行切片为 P4，但必须把 Agent terminal 与 task reconnect 分成两个 capability contract，不能由
UI 的 `TerminalSessionRegistry` 或现有 `BackgroundTaskRuntime` 隐式承担彼此的生命周期。

### 14.11 R5.31：Session query/search application seam（已完成 native M2）

本轮按 DSH `dsh-session-query` / `dsh-session-query-sqlite` 的分层重新检查后，PilotDeck 的 session catalog 已完成 native M2，
此前 chat search 是 M1：`src/session/search/searchChatHistory.ts` 同时定义请求/响应类型和 Node JSONL 实现，并直接使用
`readdir`、`createReadStream`、`readline`、path layout、`sanitizeSessionIdForPath()` 与 `readSessionInfo()`；IM 的
`ChannelCommandRegistry` 还从 channel protocol 反向导入 CLI command。R5.31 已将 Definition 收敛到
`SessionSearchPort.ts`，以 `NodeSessionSearchPort` 暴露 native provider；`searchChatHistory()` 仅保留兼容入口。`runChatSearch()`/
`runChatSearchCli()` 与 IM command 都只消费 port，ChannelStartDeps 由 server composition 传递 capability 与 `pilotHome`。

DSH 的可取性质是：`SessionQueryEngine` 将完整读取、filter 与 trace 留在 provider-neutral 服务中，而全文检索由独立 backend
实现；SQLite FTS index 是可丢弃派生索引，不能成为 session persistence 或 session event 的真源。PilotDeck 当前只需要较窄的
聊天文本搜索能力，不应为追求包名对称而一次性复制 DSH 的完整 query/tracing/SQLite 服务。

| 角色 | R5.31 的最小责任 | 不得承担 |
| --- | --- | --- |
| Definition | `src/session/search/SessionSearchPort.ts` 拥有 `SessionSearchInput`、`SessionSearchMatch`、`SessionSearchResult` 与 `SessionSearchPort.search()`；保留 project/all-project、session、role、regex、大小写、internal 与 limit 的原有语义 | JSONL path、Node stream、CLI argv、IM reply、Gateway、`SessionRuntime`、projection、retention |
| Native provider | `NodeSessionSearchPort` 暴露既有 JSONL line scan、title recovery、snippet 与截断逻辑；`searchChatHistory()` 是显式兼容入口，生产 consumer 不再依赖它 | 持有 live session、写入 event、建立持久索引或改变 query 排序/匹配语义 |
| CLI consumer | `parseChatSearchArgs()` 与 argv parsing 是纯 presentation；`runChatSearch`/`runChatSearchFormatted` 接收 injected port，CLI entry 选择 native provider | 从 command helper 偷偷创建 Node provider |
| Channel consumer | command registry 消费 command-scoped search capability；channel 在 `start(deps)` 时从 server composition 获得它。protocol -> CLI command 的反向依赖已移除 | 让静态 command table 保存 project state、provider singleton 或 Gateway-owned query state |
| Composition | `pilotdeck chat search`、`pilotdeck server` 分别选择 `NodeSessionSearchPort`；server 将同一 capability 透传给 channel start deps | 把 Node provider 埋入 `ChannelCommandRegistry`、channel adapter 或通用 `Gateway` |

实现与验证已完成：

1. 中立 Definition 与 shared `ChatSearchArgs` 已抽出；formatter 只导入 Definition type。`tests/session/session-list-large-input.spec.ts`
   改为直接验证 `NodeSessionSearchPort`，保留超大 inline media 后的 title recovery 回归。
2. CLI helper 已改为显式 port consumer；fake provider 覆盖 `/search` 参数到 input 的映射和 formatted output。
3. `ChannelStartDeps`/command execution context 已接收 search capability；server 将 application-selected provider 传给 channel startup。
   fake-provider contract 覆盖绑定 project、channel reply 和缺 capability 的 fail-clear path。
4. 已运行 native regression、CLI/channel/server focused tests（17/17）与 `npx tsc --noEmit -p tsconfig.json`。静态审计确认
   CLI/IM consumer 不再导入 native search，channel protocol 不再导入 CLI search command。

R5.31 已达到 native M2，而不是 M3/M4：本次搜索为一次性只读调用，没有 provider registration、session scope lease、
reload drain 或 durable state。只有产品明确提出 ranked search、跨 restart 查询性能或 provider replacement 后，才新增独立的
derived query-index provider；该索引必须从 committed session data 重建、与 persistence 数据库分离，并另立 lifecycle contract。

本轮复核后的成熟度摘要如下，供后续工作包排序使用：

| 结论 | 能力族 |
| --- | --- |
| M3 native 基础，优先保持稳定 | agent publication/lifecycle、native continuable subagent、session event/projection/recovery 的核心路径 |
| M2 native，适合按真实 consumer 扩展 | prompt/tool/context、interaction、compaction、MCP、router policy、task、cron、always-on、catalog、attachment/spill、细粒度 application bundles、runtime provider selection |
| M1，已有实现但 provider 或生命周期仍泄漏 | Agent terminal/task reconnect、非 Agent-scoped extension/LSP lifecycle、generic scope contribution、跨部署 profile/boot composition |
| M0 或必须等待产品合同 | durable pending hook、workflow/goal、durable/reconnectable jobs |

### 14.12 R5.32：Native Runtime Provider Selection（已完成 native M2）

DSH `dsh-app-boot` 的 `Profile` 将有序 bundle layer 与用户 patch layer 作为 application composition 输入；它的
关键性质是 profile 选择 provider/patch，而不持有 session、agent 或 Gateway 状态。PilotDeck 不复制 Cordis 或 patch
格式，但已将当前真实的 native provider selection 收敛到
`src/cli/PilotDeckRuntimeProfile.ts`：同一个 project config snapshot 产生不可变的 `sandboxMode`、
`runtimeContextSurface` 和 `interaction` 选择。

| 角色 | 当前实现 | 边界 |
| --- | --- | --- |
| Definition | `PilotDeckRuntimeProfile` 与 resolver 固化 default 及 precedence：显式 interaction override -> legacy `autoElicitation` -> project config -> native default | 不是 DI container，不保存 Gateway/session/plugin state，也不直接构造 provider |
| Project-generation consumer | `ProjectRuntimeResourcesBundle.stage()` 为 staged generation 只解析一次并随 resources 发布；application `interactionProfile`/legacy `autoElicitation` 作为 resolver override 一同冻结；generation retire/reload 继续由已有 lease owner 负责 | profile 不接管 model registry、router、execution-world 或 plugin lifecycle |
| Execution consumer | `ProjectExecutionWorldBundle` 只消费 `profile.sandboxMode` 选择现有 Node execution-world provider | 不改变 ToolRegistry、permission 或 scheduler ownership |
| Session consumer | `ProjectSessionRuntimeBundle` 用 generation profile 的 `runtimeContextSurface` 组装 context，并直接消费同一份 generation interaction；session override 只调整 `canPrompt` | 不在 session create 时重新选择 project provider，也不创建第二个 interaction owner |

退出证据：`pilotdeck-runtime-profile.spec.ts` 覆盖 configured/default/preference selection；
`project-execution-world-bundle.spec.ts` 覆盖 sandbox consumer；`project-session-runtime-bundle.spec.ts` 与
`interaction-profile-composition.spec.ts` 覆盖 generation/session interaction 与 context composition；本轮 focused suite 为
23/23 通过。该状态是 native M2，而不是完整 DSH boot/profile 完成：尚无 native/headless/sidecar deployment matrix、
缺 provider 的统一诊断、跨 profile boot transaction，也未把 transport 或业务状态塞进 profile。

### 14.13 R5.33：Gateway Dialog / Attachment Composition（已完成 native M2）

Gateway 的 dialog surface 同时消费三类已有边界：Web project catalog 决定可见 project，`UploadStore` 决定 upload
artifact 的授权、完整性与 retention，`AttachmentResolver` 决定本地附件如何投影为模型输入；`GatewayUploadedAttachmentBundle`
只把已验证 artifact lease 映射为 turn-local Gateway attachment。此前这些 native provider 在 `createLocalGateway()`
并列手工组装，容易让 catalog、upload 与 model attachment 的 ownership 看起来像 Gateway 本身的状态。

`GatewayDialogBundle` 现在成为该 application composition owner：它从同一 `pilotHome` 与 `SessionCatalogPort` 组合
dialog project registry、upload provider、Gateway lease consumer 和 attachment resolver，并向 Gateway 只暴露
project list/describe、attachment resolver 与 upload resolver。它不提供 `dispose()`，因为没有创建可停止的 runtime；
`UploadStore` 仍以磁盘/TTL 管理 artifact，turn lease 仍由 `GatewayUploadedAttachmentBundle` 的返回值精确释放。

`gateway-dialog-bundle.spec.ts` 覆盖 General workspace 授权、catalog projection、真实 upload->verify->hard-link lease->
Gateway attachment mapping、lease release 与 unknown project fail-closed；与既有 attachment/upload contract 的 focused suite
共 10/10 通过。该切片是 R5 的 native M2 composition，不是通用 attachment/session retention capability。

### 14.14 R5.34：Always-On Session Catalog Provider Ownership（已完成 native M2）

R5.30 的 target 不只是给 Always-On 增加可选参数，还要求 catalog consumer 不在运行时偷偷选择 JSONL provider。
本轮将这一点落实到 native factory boundary：`AlwaysOnManager` 的 runtime constructor 与 `createApplyHandler()`
都要求已选择的 `SessionCatalogPort`；只有 `createAlwaysOnManager()` 与
`createStandaloneAlwaysOnControl()` 这两个 native provider factory 保留 Node JSONL compatibility default。

`ProjectAutomationBundle` 已在 enabled manager 与 disabled standalone control 两条路径传入同一个 application-selected
catalog。因此 chat-history tool、discovery apply、manager runtime 和 Gateway session catalog 都可以共享同一只读 provider，
而不会让 scheduler、DiscoveryFire 或 handler 重新拥有 session storage。`project-automation-bundle.spec.ts`、
`always-on-control-port.spec.ts` 与 session catalog consumer suite 共 17/17 通过。

### 14.15 源码复核后的执行版路线图

本轮除既有发布产物锚点外，直接复核了本机 `deepseek-harness-dsh-v0.1.2-alpha.2` 的 `scope`、`session-query`、`jobs` 与
`app-boot` 实现。结论没有改变“不复制 Cordis/package 目录”的原则，但明确了接下来的依赖顺序：DSH 的可复用价值是 service
definition、effect owner、owner-scoped access、provider teardown 和 composition rollback；不是把每个 DSH 包变成 PilotDeck
目录。PilotDeck 现有 `ProjectExecutionWorldBundle` 已是 production composition 的唯一 execution-world provider 选择点，
静态审计未发现 `src/cli` 之外的 production consumer 绕过该 bundle 直接创建 builtin registry 或 Node execution world。

| 顺序 | 工作包 | 开工前事实 | 交付边界 | 退出条件 |
| --- | --- | --- | --- | --- |
| 1 | R4-B.2 Agent terminal Definition | 只有产品确认“Agent 自己需要持久终端”才开工；UI `TerminalSessionRegistry` 是 browser PTY/socket owner，不是 agent tool provider | 单独定义 agent terminal 的 open/I/O/EOF/abort/close 语义、session owner 与 native provider；UI 可以作为独立 consumer | old-owner fence、abort、EOF、close、scope dispose 都只结算一次；不得直接导出 UI registry |
| 2 | R4-B.3 task reconnect | 仅在 detached task 需要跨 Gateway/client reconnect 可见时开工；当前 `BackgroundTaskRuntime` 是 process-local、session-fenced native task owner | 先冻结 reconnect token、read cursor、owner dispose、unknown terminal result 与是否 durable 的产品语义，再实现 provider/consumer | foreign session 不可见；reconnect、kill、late exit、runtime dispose 不重复结算；未选择 durable job 前不得写 Session event |
| 3 | R2-B non-Agent extension consumer | 以 LSP 或 plugin removal/reload 的第一个真实 consumer 为触发；`PluginRegistry` 已有 session contribution generation lease | 对该 consumer 补 stage/publish/retire/drain，继续由 PluginRuntime 持有 plugin instance | failed stage 保留旧 generation；已获 lease 的 session 不受 reload 影响；removed provider dispose 恰好一次 |
| 4 | R5.32 native runtime provider selection（已完成） | `PilotDeckRuntimeProfile` 从一个 project config snapshot 加 application override 选择 sandbox、runtime-context surface 与 interaction；`ProjectRuntimeResourcesBundle` 在 stage 时发布该不可变视图，execution-world 与 session-context consumer 只复用它 | 选择 precedence、默认值、project generation、execution-world sandbox、session context surface 与 application override frozen-profile 都以 focused contract 覆盖；profile 不持有 Session、Gateway 或 plugin state | 不把它夸大为 DSH 完整 deployment profile，不纳入 model transport、Gateway pending state 或 plugin lifecycle |
| 5 | R5-B deployment profile / boot contract | 以 R5.32 为唯一 native runtime selection source，定义 native/headless/sidecar 的 transport/provider matrix、缺 provider 诊断与 boot ownership；bundle 只做有序装配与 rollback | native/remote 使用同一 Definition；启动失败严格逆序回滚；profile 不持有 Session、Gateway 或 plugin state | 不复制 Cordis API、DSH 文件格式或第二份 application dependency bag |
| 6 | 部署 parity gates | 只在相应部署启动前实施：remote/sidecar subagent、prepared-request retry、compaction provider | 为已有 Definition 增加 transport projection 和 native/remote 对拍 | canonical request、durable result、cancel/timeout/restart 语义一致；transport 不新增第二真源 |

以下事项明确不进入当前实施队列：通用 workflow/goal registry、通用 contribution registry、SQLite/FTS session index、durable
pending hook、durable/reconnectable job。它们都缺至少一个已批准的 PilotDeck consumer 或业务状态定义；提前抽象只会新增第二
owner，而不会提高 DSH 风格模块化程度。

### 14.16 本轮执行优先级（2026-09-10）

14.15 的表保留各能力的完整验收条件；本轮源码核对发现其中第 1-3 项都还缺产品 caller，不能被排成无条件的下一开发。
`PluginRuntime` 目前只投影 `lspServers` 配置而没有 LSP runtime owner，`TerminalSessionRegistry` 只拥有 browser PTY/socket，
`BackgroundTaskRuntime` 也只提供 process-local 的 session-fenced task。因此本节替代其执行优先级，而不改变已经冻结的边界。

| 优先级 | 工作包 | 最小产出 | 开工/退出门 |
| --- | --- | --- | --- |
| 0（已完成基线） | R5.32-R5.34 native composition | 保持 immutable runtime profile、Gateway dialog/attachment bundle 与 Always-On catalog injection 的 owner 边界 | 对应 focused contract 持续通过；不得新增 Session、Gateway 或 plugin 的第二真源 |
| 1（下一切片） | R5-B deployment profile / boot 审计门 | 列出 native/headless/sidecar 的真实启动入口、provider selection、owner、stop/rollback 顺序与缺 provider 的诊断责任 | 只有同一个 Definition 已被至少两个部署 consumer 使用时才新增 profile field 或 bundle；否则以“无有效 consumer，不建抽象”结束 |
| 2（产品触发） | R4-B.2 Agent terminal、R4-B.3 task reconnect | 先冻结 caller、session owner、cancel/EOF/kill、reconnect cursor、unknown terminal result 与 durable/non-durable 语义 | 不复用或暴露 UI terminal registry；foreign session 不可见；late exit 和 dispose 只结算一次 |
| 3（真实 consumer 触发） | R2-B non-Agent extension lifecycle | 以首个运行中的 LSP 或其它 non-Agent extension consumer 为范围，补 stage/publish/retire/drain | failed stage 保留旧 generation；已有 lease 不受 reload 影响；removed provider 恰好 dispose 一次 |
| 4（部署触发） | remote/sidecar parity | 仅为已存在 Definition 增加 transport projection 与 native/remote 对拍 | canonical request、durable result、cancel、timeout、restart 语义相同，transport 不拥有业务状态 |

仍明确排除通用 workflow/goal registry、通用 contribution registry、SQLite/FTS session index、durable pending hook 与
durable/reconnectable job：它们缺少已批准的业务 caller 或唯一的状态 owner，不能以“对齐 DSH 包名”为由预建。

### 14.17 R5.35：Runtime-Context Surface Definition（已完成 native/sidecar M2）

`runtimeContextSurface` 是模型可见动态上下文的投影选择，不是 Session、Gateway 或 ContextRuntime 的状态 owner。此前
native profile、Pilot config parser 与 sidecar default factory 各自维护允许值或 `user_message` 默认，且 session Agent config
直接读取 raw config；这使同一 project generation 的 context provider 和 AgentLoop config 存在再次选择的入口。

`src/context/RuntimeContextSurface.ts` 现在定义唯一的 surface vocabulary、profile default 和 legacy direct-context default。
Pilot config parser、`PilotDeckRuntimeProfile` 与 sidecar payload mapper 均消费同一 validator/resolver；
`SessionAgentConfigBundle` 只消费已发布 generation 的 `runtime.profile.runtimeContextSurface`，与
`SessionContextRuntimeBundle` 保持同一个 immutable selection。`DefaultContextRuntime` 的直接构造继续显式使用
`system_prompt` compatibility default，因而没有把非 application-owned embedding 的既有行为改变为 profile default。

focused contract 覆盖 shared vocabulary、config invalid fallback、native profile、sidecar invalid payload fallback、session config
freeze，以及真实 Gateway session creation，20/20 通过。该项只收敛已有 selection，不向 Module Protocol 增加字段，不让
sidecar 拥有 context/session state，也不宣称完整 headless/remote boot profile 已经完成。

### 14.18 R5.36：Sandbox Mode Definition 收敛（已完成 native M2）

本轮源码复核确认 `SandboxMode` 的**类型**原先虽由
`src/tool/execution-world/SandboxPort.ts` 定义，但 vocabulary、默认值和校验仍有三个 application-facing 副本：
`PilotAgentConfig` 重写 union、`loadPilotConfig.ts` 手写合法值和 `danger-full-access` fallback、
`PilotDeckRuntimeProfile.ts` 再次选择相同默认值。该缺口现已收敛为 `SandboxPort` 的
`SANDBOX_MODES`、`DEFAULT_SANDBOX_MODE`、`isSandboxMode()` 与 `resolveSandboxMode()`；
`ExecutionWorldBundle` 的 direct-embedding default 复用同一常量，保持既有行为。

这是一项小而真实的 DSH Definition/Consumer 收敛：同一个 immutable project generation 已把 sandbox 传给
`ProjectExecutionWorldBundle`，现在在进入该 generation 前，配置、profile 和 execution Definition 也消费同一份词表。
它没有新建状态 owner、profile field 或 transport protocol。

| 角色 | R5.36 的边界 | 明确不做 |
| --- | --- | --- |
| Definition | 在 `SandboxPort.ts` 集中 `SANDBOX_MODES`、默认 native/profile selection、type guard 与 resolver；`SandboxMode` 由该列表派生 | 改写 Seatbelt、`SandboxedFsPort`、Shell/DetachedShell enforcement 语义，或新增平台 provider |
| Config consumer | `PilotAgentConfig` 引用 `SandboxMode`；parser 使用同一 guard/resolver，继续在非法输入时产生现有 diagnostic | 把 config parser 变成 execution-world owner，或改变 YAML 兼容行为 |
| Profile consumer | `PilotDeckRuntimeProfile` 只消费 shared resolver 并发布 frozen selection | 让 Session、Gateway、sidecar 或 AgentLoop 再选一次 sandbox mode |
| Direct native consumer | `createNodeExecutionWorldBundle()` 保持显式的 direct construction compatibility default，可复用 shared default | 把 profile 反向注入所有直接 embedding/test call site |
| Composition | `ProjectExecutionWorldBundle` 继续只把已发布 profile 的 mode 交给 provider factory | 创建第二个 execution-world、tool registry 或 sandbox policy state |

实际实施和验收如下：

1. Definition contract 覆盖 vocabulary、type guard、configured resolver 和 invalid fallback；
2. config type、parser 与 runtime profile 三处选择均改为消费 shared Definition；
3. `ExecutionWorldBundle` 直接构造继续使用相同 native default；
4. `ProjectExecutionWorldBundle` 与真实 `createLocalGateway()` lifecycle regression 证明已发布 generation 的 selection 抵达 execution-world factory。

`npx tsc --noEmit -p tsconfig.json` 通过；sandbox/config/profile/project-runtime focused suite `36/36` 通过。
合法值、default 和 fallback 现只在 Definition 维护；非法 YAML 仍给出 `CONFIG_AGENT_SANDBOX_MODE_INVALID`；
profile 选出的值与 execution-world factory 接收到的值一致；direct native construction 未改变；本项未修改
`src/agent/loop/AgentLoop.ts`。该项不增加 Module Protocol 字段，也不把 macOS-only enforcement 误写成跨平台 sandbox parity。

### 14.19 R5.37：Host Module Capability Definition 收敛（已完成 native/sidecar M2）

`HostContextModuleMethod`、`HostCapabilityModuleMethod` 与 `HostPermissionModuleMethod` 原本只是在
`src/agent/modules/protocol.ts` 的 type union；default sidecar factory 为反序列化 `hostModules` payload 又维护三份
独立 allowlist。这使新增 method 时 TypeScript type、sidecar runtime 与 JSON Schema 三处可能各自漂移。

现在 protocol Definition 导出三个 vocabulary tuple 和对应的 reader：
`HOST_CONTEXT_MODULE_METHODS`、`HOST_CAPABILITY_MODULE_METHODS`、`HOST_PERMISSION_MODULE_METHODS`，以及
`readHost*ModuleMethods()`。sidecar factory 只消费这些 readers；未知 method 仍按原语义被过滤，已声明 method 的顺序
与重复项也保持不变。Module Protocol v2 JSON Schema 继续是 wire contract 的独立产物，但 contract test 会直接比较三个
schema enum 与 TypeScript Definition，防止将来只更新一侧。

该项没有改变 `hostModules` 字段、协议版本、permission/tool/context 的 owner，或任何 AgentLoop 语义。
`npx tsc --noEmit -p tsconfig.json` 通过；protocol、sidecar factory、context/capability/permission consumer 与 schema
contract suite `35/35` 通过。

### 14.20 R5.38：Agent Run-Mode Definition 收敛（已完成 native/sidecar M2）

`runMode` 先前由 sidecar factory、Gateway request normalization 与 Web fork-session 各自解释。它们的 fallback
策略本来不同：sidecar 和 fork 需要把非法值留为 `undefined`，让调用者沿用既有默认；Gateway 对非空非法值则为
兼容历史 API 回退为 `"agent"`。因此这一项不能用“统一 fallback”掩盖真实 consumer 语义，而只应收敛输入 vocabulary。

`src/agent/protocol/input.ts` 现在导出 `AGENT_RUN_MODES`、由 tuple 推导的 `AgentRunMode` 与
`parseAgentRunMode()`。`pilotdeck-agent-loop-default-factory.ts`、`InProcessGateway.ts` 与
`web/server/forkSession.ts` 都以该 parser 判断合法输入，随后各自保留原有 fallback policy。它不增加 wire field，
不改变 AgentLoop 的运行模式分支，也不把 Gateway 的 API compatibility decision 下沉到 protocol Definition。

`npx tsc --noEmit -p tsconfig.json` 通过；input vocabulary、Gateway normalization 和 sidecar/fork consumer
focused suite `11/11` 通过。验收重点是合法值只维护一处，并且非法值在三个 consumer 的既有语义没有漂移。

### 14.21 R5.39：Permission Mode Definition 收敛（已完成 native/sidecar M2）

permission mode 是 interaction/permission 能力族的共享输入，不是 AgentLoop 内部权限决策的替代物。此前
sidecar factory 和 Gateway normalize 路径各自维护合法值和 `"default"` fallback；现在
`src/permission/protocol/types.ts` 集中导出 `PERMISSION_MODES`、`DEFAULT_PERMISSION_MODE`、
`isPermissionMode()` 与由 tuple 推导的 `PermissionMode`，并从 `src/permission/index.ts` 提供稳定出口。

sidecar 继续把非法输入视为未显式配置，Gateway 继续以 `default` 为 API compatibility fallback。`AgentLoop.ts` 内既有
私有 defensive check 不迁移也不修改：它保护核心循环，且本路线图的范围明确禁止修改该文件。该项不改变
permission policy、ask/deny/allow owner、audit record 或 Module Protocol 字段。

`npx tsc --noEmit -p tsconfig.json` 通过；permission definition、default factory、Gateway normalization、
permission port 和 session interaction focused suite `20/20` 通过。验收重点是 vocabulary/default 只有一个
application-facing Definition，且不同 consumer 的 fallback policy 仍由其原 owner 决定。

### 14.22 R5.40：AgentSession Runtime Composition（已完成 native M2）

本轮按 `core/session + bundle` 能力族把 `createAgentSession` 的 native resource composition 从 session publication
中抽离为 `AgentSessionRuntimeBundle`。此前 factory 同时负责 Permission、ToolRuntime/Scheduler、in-memory event/
projection、storage、scope、durable port wrapper 和 AgentLoop/TurnRunner/AgentSession publication，导致四条真实 consumer
只能通过同一个大工厂间接共享资源 owner。现在 bundle 是 native provider，集中决定 injected 与 fallback resource；
`createAgentSession` 只消费 bundle 输出，负责构造 loop、metadata store、turn runner、manual compaction controller、
session 与 handle publication。

保留的 owner 规则如下：调用者传入的 scope 默认不被 bundle dispose，只有 `ownedScope` 显式转移时才随 handle 回收；
storage 无论直接提供还是由 project storage 创建，都继续由 session handle 回收；bundle 自己创建的 in-memory projection
和 root scope 只回收一次。Permission/interaction、tool、context、subagent provider、durable port wrapper 的 fallback
逻辑不改变，`AgentLoop.ts`、Gateway 状态机、sidecar payload 与 Module Protocol 均未修改。

真实 consumer 覆盖本地 Gateway、通用 Gateway、resume 和 continuable subagent。新增 bundle contract 覆盖 fallback
scope/projection disposal 与 injected-scope ownership；factory contract 额外覆盖 `__configure` 失败后的 async rollback。
`npx tsc --noEmit -p tsconfig.json` 通过；bundle/session factory suite `10/10`、subagent/project-session/
session-router consumer suite `36/36` 通过。该项不是完整 deployment profile，也没有创建第二个 session persistence
provider 或全局 DI registry。

### 14.23 R5.41：Session Persistence / Projection Provider Selection（已完成 native M2）

DSH `session-persistence` 的可取之处是 backend provider 不拥有 Session 领域状态；`app-boot` 只在组合层选择
provider。PilotDeck 现以 `ProjectSessionStorageProvider` 表达同一条窄边界：对每个 agent 或 subagent session，provider
只选择 `SessionPersistence` 与 `SessionProjectionCheckpointStore`。Node JSONL + JSON checkpoint 仍是未配置时的唯一 native
默认值；嵌入式或测试调用方可以选择另一对兼容 backend，但不能注入、替换或并行维护 `SessionRuntime`、projection registry、
driver、restore 顺序和 dispose 顺序。

`createAgentProjectSessionStorage()` 与 `createSubagentProjectSessionStorage()` 统一经过该 provider；通用 `createGateway()`
和 `createLocalGateway()` 将同一选择传给真实 session 创建、resume 和 native subagent 路径。`GatewaySessionHistoryBundle`
的一次性 status 写入也使用相同 provider，并在写入后无论成功或失败都 dispose 临时 storage；同时发生写入和 dispose
失败时保留两者错误。这样避免 status transcript 绕开 application-selected persistence backend，也不遗留临时
projection/persistence subscription。

该项的真实性在于已有 JSONL 和 in-memory backend 可被同一项目 session composition 选择，且 Local Gateway 的 status
history consumer 已覆盖该传播路径。它**不是**独立持久化 backend 的全数据面 parity：Web history read、fork、replace 和
catalog/search 仍消费现有 JSONL 读取与事务 owner，尚未通过 provider。只有真实的第二个 production backend 或 migration
caller 出现，才应同时设计 provider-neutral history/query/replacement contract；不能为此预建 SQLite/FTS query 服务或
无边界 registry。`SessionRuntime` 仍是 sequence、commit 和恢复领域校验的唯一 owner，checkpoint 仍是可丢弃 cache。

`npx tsc --noEmit -p tsconfig.json` 通过；session storage/provider、Gateway history、persistence、projection checkpoint、
AgentSession runtime/factory 和 native subagent continuation focused suite `24/24` 通过；`git diff --check` 通过。

### 14.24 R5.42：Provider-backed Standard Session History Read（已完成 native M2）

R5.41 之后，`readWebSessionMessages()` 仍直接读取 JSONL，导致显式选择 in-memory 或其他兼容
`SessionPersistence` 的应用能写入、resume 和记录 Gateway status，却不能读取自己的标准 Agent history。现在
`readAgentProjectSessionPersistence()` 只从同一 project/session identity 选择的 persistence backend `load()`；它不构造
第二个 `SessionRuntime`、不恢复或 flush checkpoint，也不取得 event/projection lifecycle 的 owner。Web history 只有在
调用方显式提供 provider、且输入不是 background relative transcript 时才使用该 read-only Definition；未提供 provider 的
native JSONL 路径仍调用既有 `readTranscript()`。

`GatewaySessionHistoryBundle` 将 application-selected provider 传给这一 consumer，因此 Local Gateway 的 history RPC 与
Agent session create/resume、continuable child storage/status write 使用同一 selection。in-memory provider integration 覆盖无 `.jsonl` artifact 的
accepted input 到 Web message 的完整读取链路；这证明 provider contract 不再只有写路径。

边界保持明确：background relative transcript、subagent sidechain、fork/replace transaction、catalog/search 仍有各自的
JSONL/path/transaction owner，未被伪装成通用 storage API。后续的独立 production backend 或 migration 必须先定义这些
consumer 的完整 contract，不能通过在 history reader 内重建 SessionRuntime 或空 flush projection 来绕过 lifecycle。

`npx tsc --noEmit -p tsconfig.json` 通过；storage provider、Gateway history、Web catalog/status/compact/subagent replay、
fork/replace transaction、session persistence/checkpoint 与 AgentSession runtime/factory focused suite `50/50` 通过。

### 14.25 R5.43：Continuable Child Read-only Inspection（已完成 native M2）

`SubagentContinuationManager` 在 child cold follow-up 前调用 `NativeSubagentContinuationHost.inspect()`，它只需要读取
child event log 来折叠 descriptor。此前该 consumer 先构造完整 `createSubagentProjectSessionStorage()`，随后为清理临时资源
调用 `dispose()`；由于 dispose 会 flush projection checkpoint，纯读取会写出一个空 projection cache，迫使下一次 restore
回退 full replay，且违背 DSH storage reader 不拥有 runtime/projection effect 的边界。

现在 `readSubagentProjectSessionPersistence()` 与 child storage factory 复用同一 parent/child path 和 provider selection，
但只调用 `SessionPersistence.load()`。`NativeSubagentContinuationHost.inspect()` 直接消费它，不创建 `SessionRuntime`、
subscription、projection driver 或 checkpoint binding；完整 storage 仍只由 child materialize/resume 路径创建和 dispose。
这保留 manager 的 exact-live-parent authorization、abort recheck、provider-independent cold resume、FIFO admission 与
child-first dispose owner。

新增 contract 故意统计 checkpoint save：pre-fix 的 inspect 会保存一次，修复后为零，同时保留 JSONL cold-resume integration。
`npx tsc --noEmit -p tsconfig.json` 通过；continuation host/manager、session storage provider 与 AgentSession factory focused
suite `38/38` 通过。

### 14.26 源码复核后的下一阶段队列（2026-09-10）

本轮直接复核 DSH `app-boot` 的 ordered bundle/profile patch composition 与 tree disposal，以及 PilotDeck 的
`createLocalGateway`、通用 `createGateway`、sidecar launcher、`createAgentSession` 和 subagent continuation 调用链。
结论是 PilotDeck 目前只有一个完整 application deployment composition（CLI/server 经 `createLocalGateway`）；
`createGateway` 是 embedding compatibility factory，sidecar 是 AgentLoop execution factory/server，而不是第二个
application profile。故不能仅因 DSH 同时提供 `headless`、`web`、`acp`、`sdk` profile 就预建 PilotDeck profile registry。

另一方面，`createAgentSessionWithStorageAsync()` 已有四个真实 production consumer：本地 Gateway、通用 Gateway、
resume 与 continuable subagent。它仍会在缺依赖时创建 Permission、ToolRuntime/Scheduler、in-memory event/projection、
scope、native interaction reconnect 与 native subagent provider。DSH 的启发在于把这些 provider 的 owner、发布点与
rollback 说清楚；并不意味着把它们塞进新的 application dependency bag。

| 优先级 | 工作包 | 范围与退出门 |
| --- | --- | --- |
| 1 | R5-B deployment profile / boot contract | 只有同一 Definition 被至少两个完整 deployment consumer 使用时，才增加 native/headless/sidecar matrix、缺 provider diagnostic 与逆序 boot rollback。sidecar execution factory 不单独满足该条件。 |
| 2 | remote/sidecar parity gates | 仅为已存在 Definition 补 subagent、prepared-request retry 或 compaction 的 transport projection；对拍 canonical request、durable result、cancel/timeout/restart。 |
| 3 | Agent terminal、task reconnect、non-Agent extension lifecycle | 必须先有产品 caller；分别冻结 owner、terminal/settlement/reconnect 或 generation lease contract 后再实现。 |
| 4 | storage migration / independent persistent backend | 仅在明确的第二个 production persistence backend 或 migration caller 落地后，扩展已完成的标准 history read 和 continuable child inspection，设计 provider-neutral one-shot subagent sidechain、fork/replace transaction 与 catalog/search contract；保持 `SessionRuntime` 为唯一 sequence/commit owner，不引入第二个 session state machine、SQLite/FTS query registry 或 provider global registry。 |

持续非目标：通用 workflow/goal registry、通用 contribution registry、SQLite/FTS session index、durable pending hook、
durable/reconnectable job。它们仍缺受批准的业务 consumer 或唯一状态 owner，不能以 DSH package 对称为由预建。

### 14.26.1 对拍基准完整性门（2026-09-10，P0 已完成）

在决定任何 native/sidecar 的语义差异归属前，先保证 deterministic harness 真正执行了 scenario 声明的
fault，并能构造合法的 durable session 事件链。这是 StaffDeck 的测试基础设施工作，不是 PilotDeck product
change，禁止通过放宽 normalizer、移除 session domain validation 或修改 `AgentLoop.ts` 绕过。

初始检查在 Node `v22.23.1`、pnpm `10.32.1` 下揭示了两个 harness 缺口：native adapter 把依赖 `uuid` 固定为
`parity-id`，使 `SessionRuntime` 正确以 `self_parent` 拒绝第二个 event；sidecar adapter 也忽略了
`scenario.faults.model`，因此不会真正触发模型失败。修复仅位于
`StaffDeck-pilotdeck-agent-loop/tools/agent-loop-parity/adapters/`：native 使用稳定但唯一的 event id，native/sidecar 共用
按 attempt 计数的 model fault script，并都记录 `model.request`、`fault.injected`、`model.error`（含 code/retryability）和 terminal。

重建当前 worktree 的 `dist/` 后，以下对拍均为 `PASS`：

```text
model_retryable_error      /tmp/pilotdeck-parity-retryable-fixed-daPElk
model_non_retryable_error  /tmp/pilotdeck-parity-nonretryable-fixed-ojlPIS
permission_allow           /tmp/pilotdeck-permission-allow-fixed-A9TJaB
permission_ask_approve     /tmp/pilotdeck-permission-ask-approve-fixed-nuknMU
permission_ask_deny        /tmp/pilotdeck-permission-ask-deny-fixed-yJLukQ
```

P0 因此只表示“模型 fault 对拍的基准可信”，并不表示全部 `core-resilience` 场景已经通过。后续 P0.2 必须继续保持
`FAIL`/`BLOCKED` 的真实性，禁止放宽 normalizer 或修改 `AgentLoop.ts`：

1. sidecar driver 需要并发响应同一 turn 的多个 `module_call`，保留 capability call/result 的 happens-before 关系；当前串行
   reader 造成 `multi_tool_ordered` 和 `multi_tool_mixed_*` 的 trace 交错差异，模型可见 request/result 已一致。
2. adapter 必须实现 `malformed_response`、`stream_interruption`、`cancelAfterToolStartMs` 与 `allowedReadFiles` scenario
   contract；当前两侧共同未触发这些 oracle 所声明的行为，不能归因为产品回归。
3. `write_snapshot_resume` 必须由 adapter 构造完整、合法的 session seed/event relationship；native 的 `BLOCKED` 与 sidecar
   的空失败 terminal 目前都不是可比较的 resume 证据。

### 14.27 架构复核后的收敛路线图（2026-09-10）

本节以本机 `deepseek-harness-dsh-v0.1.2-alpha.2` 的 `scope`、`agent`、`session`、`session-projection`、
`session-persistence` 和 `app-boot` 实现为准，并重新沿 PilotDeck 的 `createLocalGateway -> ProjectRuntimeRegistry ->
ProjectSessionRuntimeBundle -> createAgentSessionWithStorageAsync` 调用链核对。结论是：PilotDeck 已经具备 DSH 风格的
Definition/Provider/Consumer 基础，但还没有 DSH 式完整 profile composition；当前工作的正确单位是补齐已经存在 consumer
的 owner 边界，而不是按 DSH package 名称增加目录。

| 能力族 | 当前状态 | 可作为稳定基础的模块 | 尚未闭环的边界 |
| --- | --- | --- | --- |
| Agent 与生命周期 | M3 | `AgentFactoryProvider`、`AgentRegistry`、`AgentHandle`、`AgentRuntimeScope`、`SessionRouter` | scope identity 尚未同时统一 service、通用 contribution 与 event admission；不能因此预建全局 contribution registry |
| Session 与投影 | M2 | `SessionRuntime`、`SessionPersistence`、`SessionProjectionDriver`、checkpoint、Agent/Web projection | 只有已接入的 consumer 完成 provider 传播；fork/replace/catalog/search 仍是 JSONL/path transaction 的独立 owner |
| Model / context / tool / permission | M2 | `ModelInvokerPort`、`ToolPort`、`AgentContextRuntime`、`PermissionDecisionPort` 及 host consumers | prepared-request retry 与 compaction 已完成 Gateway `core-resilience` 21/21 对拍；通用第三方 host 仍需实现 `model.prepare`、host-owned budget 与 durable model/tool provider，transport 不能取得 session owner |
| Subagent 与 interaction | native M3 / M2 | named provider、durable inbox、continuation manager、interactive/headless/disabled profile | remote/queued provider、sidecar parity 和完整 deployment composition 尚缺 |
| 执行世界与应用组合 | native M2 | execution-world ports、runtime profile、project/session/gateway bundles、bootstrap/shutdown owner | `createLocalGateway` 仍是唯一完整 application composition；没有第二个完整 deployment consumer 时不建立通用 profile registry |

下列顺序替代“按目录继续拆分”的做法。每个工作包都是可独立评审、可回滚的边界；除明确标注的产品触发项外，前一项
没有通过不得启动后一项。

| 顺序 | 工作包 | DSH 对应性质 | 范围与实现约束 | 完成门 |
| ---: | --- | --- | --- | --- |
| 完成 | R5.44 Session model-selection / one-shot writer storage parity | persistence provider 只提供 backend；read path 不取得 Session/projection effect owner；临时 writer 必须恢复既有 sequence | `NativeSessionModelSelectionPort` read 复用 `readAgentProjectSessionPersistence()`；Gateway 将 application-selected provider 注入该 consumer。`ProjectSessionWriteCoordinator` 是 application-owned、per-session 的短 writer admission Definition；model selection write/clear 与 Gateway one-shot status write 都先 restore，再 append，最后由创建者 dispose。 | 自定义 in-memory provider 下 model get/set/clear 与 Gateway status 均无 JSONL artifact；read checkpoint save 为零；连续及并发 one-shot writes 的 sequence 连续；Gateway policy/busy 语义不变。 |
| 完成 | P0 deterministic parity-harness integrity | DSH 的 durable event 与 transport 对拍都以可验证的 state/effect 为前提 | StaffDeck adapter 已使用 unique deterministic event id、shared fault script 与 model error/retryability trace；所有失败仍按 `FAIL` 或 `BLOCKED` 报告。PilotDeck `SessionRuntime` validation 和 normalizer 均未放宽。 | `model_retryable_error` 和 `model_non_retryable_error` 两侧均在第一轮真正触发 fault，且由同一 oracle 比较 model request/error/terminal。 |
| 1 | P0.2 core-resilience adapter completeness | DSH 对拍需要保留并发 effect、取消、fault 与 durable seed 的可观察语义 | 只修 StaffDeck native/sidecar adapter：并发 module-call response、model fault、tool-start cancel、read-file seed 与合法 snapshot/resume event chain。当前 `multi_tool_*` 的 request/result 已等价；不得以重新排序 normalizer 掩盖真实副作用差异。 | 20 个 `core-resilience` scenario 全部为 `PASS`、明确声明的 `WARNING` 或真实环境 `BLOCKED`；任何未实现 scenario action 都不得产出伪 `completed`。 |
| 2 | R5-B deployment profile / boot audit gate | DSH ordered bundle、patch precedence、failed boot reverse teardown | 先只产出 native/headless/sidecar 启动入口、provider selection、owner 和逆序释放表。只有同一 Definition 被两个完整 application deployment consumer 使用，才新增 profile 字段或 bundle registry。sidecar AgentLoop execution factory 不是独立 application profile。 | 每个启动资源有唯一 owner；失败路径按反向顺序释放；不引入第二个 `AgentRuntimeDependencies` bag、Session 或 Gateway state owner。 |
| 3 | Existing-definition transport parity | DSH provider/consumer 可以有可选 transport projection | P0.2 通过后，按实际部署优先补 remote/sidecar subagent、prepared-request retry、compaction provider 的 protocol projection；只投影 canonical request、durable result、cancel/deadline/restart 所需字段。 | native/remote 对拍无未解释的 canonical request、tool result、terminal、cancel/timeout 差异；transport 不保存 turn/session/run 状态。 |
| 4 | Non-Agent extension lifecycle | DSH scoped effect owner、provider unload | 仅在 LSP、MCP、telemetry、command 等出现首个真实运行 consumer 时，复用 generation lease、stage/publish/retire/drain；PluginRuntime 继续拥有 plugin instance。 | failed stage 保留旧 generation；持有 lease 的 session 不受 reload 影响；removed provider 恰好 dispose 一次。 |
| 5 | Product-triggered capabilities | DSH jobs/workflow/terminal 需要明确 live owner 与 settlement contract | Agent terminal、task reconnect、workflow/goal、durable job 先定义 caller、状态真源、cancel/reconnect/unknown-result 语义，再选择 native provider 或 transport。UI `TerminalSessionRegistry` 和现有 process-local background task 不可直接升级为 agent provider。 | owner、visibility、late completion、abort、dispose 和 restart 的职责可由 focused contract 证明；没有 caller 则不建抽象。 |

R5.44 已完成，且没有修改 `src/agent/loop/AgentLoop.ts`、Module Protocol 或 session domain vocabulary。此前
`GatewaySessionHistoryBundle` 已传播 provider，continuable child 的只读 inspect 已避免空 checkpoint flush，但
`NativeSessionModelSelectionPort` 仍默认构造 JSONL storage，`createLocalGateway` 也未把 `storageProvider` 注入它；
此外 model selection 与 Gateway status 的短生命周期 writer 没有 restore 既有 log，连续写入会产生重复 sequence。

现在 model selection read 直接读取 provider-selected persistence，不构造 runtime、projection 或 checkpoint binding；write/clear
先 restore、记录 metadata，再由 port 在成功和失败路径 dispose。`ProjectSessionWriteCoordinator` 由 Local Gateway 创建一次，
按 `(projectRoot, pilotHome, sessionId)` 将 model selection 与 status 的短 writer 排队；它不拥有 persistence、runtime 或
projection，也不伪装为跨进程锁。一次性 Gateway status writer 同样先 restore，因此不会绕过 `SessionRuntime` 的
sequence/entry-chain owner。定向 contract 覆盖 in-memory provider 下无 JSONL artifact 的 get/set/clear、read 零 checkpoint
save、Local Gateway provider propagation、已有 entry 后 one-shot status 写入得到 `[1, 2]`，以及 metadata/status 并发写入得到
`[1, 2, 3, 4]` sequence。coordinator contract 还覆盖失败 writer 释放后续同 session writer、不同 session 不互相串行；
model/history/session factory focused suite `31/31` 与
`npx tsc --noEmit -p tsconfig.json` 通过。

以下仍是显式非目标：复制 Cordis API、为每个 DSH package 建对应目录、预建 SQLite/FTS query 服务、将 profile 变成全局
DI 容器、让 storage provider 管理 `SessionRuntime`/projection、以及把 StaffDeck 的 Harness/TaskFrame/lease 语义写入
PilotDeck 默认 factory。

### 14.28 P0.2 对拍复核与收敛（2026-09-10，native/sidecar/Gateway 已完成）

本节替代任何将当前 default-sidecar `core-resilience` 标为“20/20 通过”的表述。复核在 Node `v22.23.1` 下重建当前
PilotDeck worktree 后执行：

```text
npx tsc --noEmit -p tsconfig.json
npx tsx --test tests/agent/modules/capability-tool-port.spec.ts
pnpm build
python /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop/tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831 \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --pair pilotdeck --comparison same-version --suite core-resilience \
  --output /tmp/pilotdeck-core-resilience-audit-R03fFh

python /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop/tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831 \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --pair pilotdeck --comparison same-version --pilotdeck-surface gateway \
  --suite core-resilience --adapter-timeout-seconds 45 \
  --output /tmp/pilotdeck-gateway-core-resilience-fixed-58yysK
```

前三项全部通过，capability port focused suite 为 `6/6`。修复后以相同命令重跑的完整对拍输出为
`/tmp/pilotdeck-core-resilience-p02-fixed-odR8iZ`：20 个场景均 `PASS`，无 semantic diff、oracle failure 或
`BLOCKED`。Gateway surface 的完整输出为 `/tmp/pilotdeck-gateway-core-resilience-fixed-58yysK`，同样为 20 个场景全部
`PASS`，无 semantic diff、oracle failure、format warning 或 `BLOCKED`。保留的 loop-surface format warnings 只涉及既有
envelope serialization，不改变模型可见输入、tool result、terminal 或副作用语义。

| 优先级 | 已证实差异 | 归属与原因 | 修复约束 | 退出门 |
| ---: | --- | --- | --- | --- |
| 完成 P0.2-A | `allowed_read_files` | native adapter 的 `checkPermissions` 已接收真实 tool input，不再闭包捕获 turn input | native/sidecar 都经同一 permission seam | 两端均记录 allow、`tool.call(read_file)`、相同 tool result 和 completed terminal |
| 完成 P0.2-B | `cancel_during_tool` | sidecar driver 与 Gateway `StdioAgentLoopRunner` 都在 terminal 前 drain 已接纳的 module-call worker | terminal 不得先于 cancellation/result projection | tool cancellation result happens-before terminal；late success 不会映射为 cancelled/success |
| 完成 P0.2-C | `multi_tool_mixed_permission` | fixture 明确断言允许的 `lookup` 调用和拒绝 `restricted`；已移除不稳定的跨 surface `noToolSideEffects` 断言 | 不将普通 read-only tool call 伪装为 mutation | 两端的 `toolCalls=[lookup]` 与 permission decision 都与 oracle 一致，`restricted` 不产生 tool call |
| 完成 P0.2-D | `write_snapshot_resume` | native 直接复用 `parseAgentLoopSeedStateProjection()`；fixture 提供合法 write-snapshot JSON entry | 不绕过 parser 或放宽 checkpoint validation | 两端从同一 seed projection 启动，并产生可比较 completed trace |

P0.2 已满足 PilotDeck loop 与 Gateway transport parity gate，但不替代 StaffDeck workflow/SOP 的业务语义验收。后续顺序为：
`Existing-definition transport parity -> R5-B deployment profile / boot audit`；不因这些 adapter 修复重开 `AgentLoop`、Session
或 Gateway 的状态 ownership 设计。

### 14.29 P1-A：Prepared Model Request Retry Projection（2026-09-10，Gateway 已完成）

`ModelInvokerPort.prepare()` 的 native provider 会先固定 Router decision 与 materialized canonical request，后续 retry 只对该
prepared invocation 调用 `stream()`。此前 sidecar host consumer 虽然冻结了 canonical request，但每次 `stream()` 都让 Gateway
adapter 再次调用宿主 `prepare()`；Router 的 provider/route selection 因而可能在同一 retry 链中漂移。

现在 `hostModelInvokerPort` 为每次 `prepare()` 生成 transport-local `preparationId`。sidecar 在同一 prepared invocation 的每次
model module call 都携带该 ID；Gateway `StdioAgentLoopRunner` 仅在第一次见到 ID 时调用宿主 Model port 的 `prepare()`，之后复用
同一个 prepared object。缓存由一次 `run()` 所有，terminal 或异常 cleanup 时清空。ID 不进入 Session durable event，不携带
Router opaque state，且固定 UUID 下仍使用本地序号避免不同 model step 相撞。

| 角色 | 实现 | 约束 |
| --- | --- | --- |
| Definition / consumer | `src/agent/modules/llm/hostModelInvokerPort.ts` | stable `preparationId` 只关联一个 prepared invocation；每次 module attempt 仍有独立 `requestId` |
| Host composition | `tools/agent-loop-parity/adapters/pilotdeck_gateway_impl.mjs` | Gateway 持有 Router opaque decision；sidecar 只传 canonical request 与 ID |
| Teardown | runner `finally` | 不跨 execute 保留缓存，不创建 session 或 Router 的第二真源 |

Node 22 下 `llm-model-port.spec.ts` 为 `7/7`，`npx tsc --noEmit -p tsconfig.json` 与 `pnpm build` 通过；真实 Gateway
`model_retryable_error` 对拍输出为 `/tmp/pilotdeck-gateway-model-prepared-retry-final-7rhsea`，无 semantic diff、oracle failure
或 `BLOCKED`。完整 loop `core-resilience` 仍为 20/20；本轮 Gateway 全量运行仅 `write_snapshot_resume` 在 Node 临时目录清理时
出现 `rmdir` BLOCKED，单独顺序重跑为 PASS，未将该环境清理波动记为通过。

P1 的剩余范围是具备独立 deployment consumer 的 remote prepared-request retry；compaction 仍不能把
`budgetEvaluator` 函数跨进程传输，必须由宿主 Context provider 以可序列化的预算契约单独设计，不能用本项缓存绕过。

### 14.30 DSH 与 PilotDeck 源码复核后的执行 Roadmap（2026-09-10）

本节是对前述矩阵的第二次源码核对，用于决定下一轮工作，不以目录数量或既有 Port 数量推导完成度。核对材料为 DSH
`v0.1.2-alpha.2` 的 `core/scope`、`boot/app-boot`、`session/*`、`compaction/*` 与 `subagent/*`，以及本 worktree 的
`AgentRuntimeScope`、`SessionRuntime`、`createAgentSession`、`createLocalGateway`、default sidecar factory、host ports 和
Gateway parity adapter。结论没有改变已有 native 通过项；它收紧了“哪些差距可以现在做”的判断。

DSH 的可复用性质是：同一个 scope identity 同时约束注册可见性、祖先事件路由和 effect teardown；profile 用有序 bundle
patch 选择 provider，并在 boot 失败时释放部分 plugin tree；compaction 的 token meter、policy、summary 与 session bracket
在同一进程内有明确 owner。PilotDeck 已用 `AgentRuntimeScope`、`ScopedServiceRegistry`、`AgentScopeLiveEventBus` 和
`scope.own()` 覆盖其中大部分 native owner 语义，也已用 `LocalGatewayBootstrapBundle`/`LocalGatewayLifecycleBundle` 覆盖
本地启动和逆序释放。但这不等价于已经有 DSH 的多 deployment profile：`createLocalGateway()` 仍是唯一完整 application
composition，`createGateway()` 是嵌入式兼容 factory，AgentLoop sidecar 只是 execution provider。

#### 14.30.1 当前模块边界与未闭环项

| 能力族 | 现状 | 尚未闭环的事实 | 下一步判断 |
| --- | --- | --- | --- |
| Agent / scope / publication | native M3 | scope 已统一服务 lease、live-event drain 与 owned effect，但没有也不需要预建全局 contribution registry | 仅在一个新 contribution 同时需要跨 prompt/tool/hook 复用与可撤销生命周期时，设计窄 Definition；不得为了包对称重构 scope |
| Session / persistence / projection | native M2-M3 主路径 | provider 已覆盖 create/resume、history、model selection 与 child inspect；fork/replace/catalog/search 仍各有 JSONL/path transaction owner | 只有第二个 production backend 或 migration caller 出现时，才扩展完整 read/write/query/fork contract |
| Model / context / tool / permission | native/sidecar M2；P1-A/P1-B 已到 Gateway | host 保留 prepared Router decision、token meter、permission/audit 与 durable model/tool event 的 owner；P1-B 已在完整 Gateway resilience 矩阵证明 compaction projection 不弱化普通 tool/permission/cancel 路径 | 通用第三方 host 必须组合 `model.prepare`、host-owned compaction budget 与 durable model/tool ports；transport 不能取得 Session/Router owner |
| Subagent | native M3 | `agent` 工具已能作为 capability descriptor 交给 host；但尚无 native/sidecar 对 continuable child、cold follow-up、parent close 的完整 parity 证据 | 做 P1-C 场景与 adapter 接入；不新增 transport-owned subagent/session state |
| Application boot / profile | 本地 native M2，跨 deployment M1 | Bootstrap/lifecycle bundle 已有，仍不存在第二个完整 deployment consumer | 先做 R5-B.0 inventory；未满足触发条件前不建 profile registry 或第二个 dependency bag |
| Extension / MCP / LSP / telemetry | Agent-scoped contribution M2；非 Agent-scoped M1-M2 | plugin 实例和若干 generation lease 已有 owner，但没有统一的 reload consumer contract | 按真实 LSP/MCP/telemetry caller 分别复用 stage/publish/retire/drain，不建立空泛 provider registry |
| Terminal / task / workflow / goal | terminal/task 局部 M1-M2，workflow/goal M0 | UI terminal 不是 Agent terminal Definition；task 没有 durable/reconnect job record；workflow/goal 尚无唯一 run owner | 必须由产品 caller 先定义 run handle、visibility、cancel、late completion、restart 和 durable truth |
| Attachment / sandbox / spill | 当前 native M2 seam 为主 | browser upload lease 已闭环；通用外部 attachment retention/query、跨平台 sandbox、Agent terminal 仍无已批准 consumer | 按具体平台或产品需求立项，保持 UploadStore/Session artifact 的现有 owner |

因此，以下都不是当前应启动的“模块化补齐”：复制 DSH package 名称、建立 Cordis/全局 DI 容器、将 transport 变成
Session/Gateway/Router owner、为没有 caller 的 workflow/goal/job 建 registry，或为了 remote parity 修改
`src/agent/loop/AgentLoop.ts`。这些做法会增加第二真源，而不是缩小当前差距。

#### 14.30.2 工作包顺序与边界

每个工作包只推进一个能力族。开始实现前必须按
[`AgentLoop 模块化开发人类交互 SOP`](../agent-loop-human-operation-sop.zh.md) 记录 Definition、Provider、Consumer、
Composition、owner、payload mapping、允许/禁止文件与对拍场景；本表是审批前的基线，不是授权一次性完成全部项目。

| 顺序 | 工作包 | DSH 性质与 owner | 允许的实现边界 | 禁止事项 | 退出门 |
| ---: | --- | --- | --- | --- | --- |
| 完成 | **P1-B Compaction budget projection（Gateway）** | `context/compaction`。宿主 Context/Router/token-meter provider 是 token 估算、policy、summary 与结果的唯一 owner；Session durable adapter 仍是 compaction event 的唯一写入者 | `model.prepare` 与 `try_auto_compact` 通过 host capability 协商；sidecar 只发送 `budgetProjection`，Gateway runner 以 `(runId, operationId, preparationId)` 保存 run-local prepared cache 并在 `finally` 清理。Gateway adapter 必须复用 session bundle 的 durable model/tool ports，且 terminal 前等待已受理的 host module dispatch 收敛 | 不序列化函数、`AbortSignal`、Router opaque state 或 Session；不以固定 token 数、跳过 compaction 或 normalizer 放宽替代 native 语义；不修改 `AgentLoop.ts` | Node 22 的 Gateway `core-resilience` 21/21 native/sidecar 无 semantic diff、oracle failure、blocked 或 format warning；包括 `auto_compact` 的相同 overflow 终止、permission、read-file seed、multi-tool、deadline 和 cancel |
| 1 | **P1-C Existing capability sidecar subagent parity** | `subagent` + `capability/tool`。host ToolRuntime/continuation manager 继续拥有 child `AgentHandle`、inbox、descriptor、settlement 和 child-first drain；sidecar 只是 `agent` capability consumer | 只在 capability descriptor/mapping、host adapter、Gateway parity fixture、subagent contract test 和文档补证据；复用已有 `SubagentProviderRegistry` 与 manager | 不新增 `subagent` Module Protocol endpoint，不把 child Session/queue/continuation state 搬到 transport，不在 sidecar 重实现 permission 或 scheduler | one-shot fork、continuable follow-up、cold inspect/resume、parent close/cancel 和 late child terminal 均与 native 语义一致；每一项给出最早分叉证据或 `PASS`，不能只比最终文本 |
| 3 | **R5-B.0 deployment/profile audit gate** | `boot/app-boot`。现阶段 owner 仍是 local Gateway/CLI bundles；profile 只能在真实 deployment consumer 之间选择 provider | 先维护启动入口、resource owner、config precedence、failure rollback 和 shutdown order 表；可补 Local Gateway boot 的 focused contract | 在只有 `createLocalGateway()` 一个完整 application 的前提下建立 profile registry、复制 `AgentRuntimeDependencies`、第二个 Gateway 或 Session state machine | 每个启动资源有唯一 owner，现有 boot failure 路径按反向顺序释放；只有出现第二个完整 deployment consumer 后，才批准 profile Definition 与 native/headless/sidecar matrix |
| 4 | **E1 Non-Agent extension lifecycle**（产品触发） | `extensions`/`mcp`/`lsp`/telemetry。PluginRuntime 保持 plugin instance owner；应用组合选择 provider | 针对首个实际 caller，复用 generation lease、stage/publish/retire/drain 和 exact consumer registration | 建立横跨所有 extension 类型的全局 registry，或让 reload 路径获得 Session/Agent owner | failed stage 保留旧 generation；lease 持有 session 不受 reload 影响；removed provider 恰好 dispose 一次 |
| 5 | **D1 storage full-data-plane parity**（迁移触发） | `session-persistence`。`SessionRuntime` 永远拥有 sequence、domain validation 和 committed stream；backend 只负责 I/O | 只有第二个真实 backend/migration 出现时，按 consumer 逐个设计 fork/replace/catalog/search/sidechain 读写 contract | 为假想 backend 提前创建 SQLite/FTS registry，或让 provider 构造 SessionRuntime/projection | 同一 provider 下 create/resume/history/fork/replace/catalog/search 的可观察语义一致；checkpoint 可丢弃且不改变 durable truth |
| 6 | **P2 product capabilities**（需求触发） | terminal、durable task/job、workflow/goal、跨平台 sandbox 各自是独立能力族 | 每次只实现一个已经批准的产品 caller 与其 run/settlement contract | 由 UI terminal、process-local task 或 DSH 包名反推一个通用 Agent provider | 明确 owner、visibility、cancel、timeout、late completion、dispose、restart/unknown-result；有 durable state 时可从日志恢复 |

#### 14.30.3 P1-B 的协议设计门（已由 Gateway slice 实现）

P1-B 先做设计和失败测试，不应直接把 `try_auto_compact` 加入 host advertisement。当前
`createHostContextRuntime()` 会从输入去掉 `budgetEvaluator`；而 `AgentLoop` 的 native evaluator 会重建 canonical request，
在 prepared route 存在时复用 materialized request，并携带该 route 的 calibration。因此“host 收到 messages 后按本地默认
token budget 估算”不是同一语义。

允许的目标是一个**可序列化的预算投影**，而非跨进程 callback：sidecar 只发送 canonical messages、显式 context/output
limits、trigger/recovery 分类和必要的公开 route identity；host 使用自己持有的 model/context/tool snapshot、Router decision
和 token meter 得到 `TokenBudgetSnapshot`，并返回既有 `AutoCompactResult`。若某阶段需要前一次 prepare 的 opaque decision，
该关联只能存放在 host-run 的短生命周期 cache 中，以 `runId`/prepared invocation 关联，terminal/error 时清除；不能进入
Session event、Protocol payload 或新的全局 Router cache。

在冻结 payload 前，必须用三个 native trace 证明每个阶段的 request 物化输入和 budget snapshot 都可由 host 重建：

```text
turn admission before route        -> configured/default route projection
prepared route changed limits      -> same prepared route/materialized request projection
prompt-too-long recovery/fallback  -> recovery target and calibration projection
```

如果任一输入不能在不改 `AgentLoop.ts` 的前提下从 host-run context 获取，P1-B 应停在设计结论，并单独提出 core
admission/budget API 评审；不得让远端 provider 以较弱估算冒充 native parity。

#### 14.30.4 每轮共同验收

P1-B/P1-C 的实现回合均使用 Node 22，先跑对应 contract test、`npx tsc --noEmit -p tsconfig.json`、`pnpm build` 和受影响的
loop/Gateway deterministic parity。Gateway 全量对拍中的环境型 `BLOCKED` 必须与 semantic `FAIL` 分开报告；不因临时目录
清理波动声称全量通过。最后仅对本轮触及文件执行 `git diff --check`，保留 dirty worktree 的无关改动。

### 14.31 R5.45：Router Provider Health Definition / Provider / Consumer / Composition（已完成 native M2）

`RouterRuntime` 原先直接拥有 `Map<sessionId, ProviderHealthTracker>`，同时在 retry/fallback 热路径拼接 provider
generation key。这使 provider circuit 的状态 owner、替换隔离与 router lifecycle 被锁在一个 runtime 实现内，不能由
project composition 替换或单独验证。

现在 `RouterProviderHealthPort` 是 `llm/router` 能力族的窄 Definition：输入只含 `sessionId`、`providerId` 和可选
`providerGeneration`，提供 `shouldSkip`、`recordFailure`、`recordSuccess` 与可选 `dispose`。native provider 按
session + provider-generation 建立 volatile `ProviderHealthTracker`；它不写 Session event、不保存到 checkpoint，也不进入
Module Protocol。`RouterRuntime` 只消费 port，并从 model invocation provider 读取 generation；无注入时保留 native
compatibility fallback。`ProjectRouterRuntimeBundle` 现在是 composition owner，能通过 `createProviderHealth` 选择 provider，
并由 Router shutdown 在既有 project runtime 释放顺序中精确 dispose。

该项保留了 retiring provider 的迟到失败不能污染新 generation circuit 的语义，且没有增加第二个 Router、Session 或
transport state owner。定向 contract 覆盖 session/generation isolation、Router failure/success delegation、shutdown dispose
与 project-bundle provider selection；Router focused suite 通过后，本切片达到 native M2，跨 deployment provider selection
仍由 R5-B deployment gate 决定。

### 14.32 DSH 与 PilotDeck 当前架构复核及执行顺序（2026-09-10）

本节复核 DSH `v0.1.2-alpha.2` 的 `core/scope`、`core/session`、`core/agent-loop` 与 `boot/app-boot`，并沿
PilotDeck 的 `createLocalGateway -> ProjectRuntimeRegistry -> ProjectRuntimeResourcesBundle -> ProjectRouterRuntimeBundle -> RouterRuntime`
调用链核对。DSH 不是“多建几个 package”：一个 scope identity 同时限制注册可见性、祖先 live-event 路由与 effect teardown；
session 的可观察事实来自 append-only log；boot/profile 只在 composition 层选择 provider 并在失败时逆序回收。PilotDeck 的
`AgentRuntimeScope`、Session event/projection、AgentFactory/Handle、project generation lease 和 local boot bundle 已分别覆盖
这些性质的 native 主路径，故下一阶段应补真实的 owner/composition 断点，而非复制 Cordis 或 DSH 包目录。

本轮确认一个优先于新协议设计的确定性缺口：`ProjectRuntimeRegistry` 已创建唯一的
`sharedSessionStore: SessionRouterStore`，而 `RouterRuntimeDeps` 已允许注入外部 `sessionStore` 且明确承诺 Router shutdown
不清空它；但该实例没有进入 `ProjectRuntimeResourcesBundle` 或 `ProjectRouterRuntimeBundle`。所以每次 config/extension reload
仍随 retired Router 失去 token tier/provider/model sticky state。`InProcessGateway.newSession()` 已把 `projectKey` 编入新建的
global `sessionKey`，并且 `SessionRouter` 本身也以该 key 全局索引 live handle；因此此次不应另建 project-key namespace 或
第二套 Session state。现有 TTL/capacity 语义保持不变，应用停止时才由唯一 registry owner 清空该 volatile store。

`auto_compact` 的 Gateway native/sidecar 语义缺口已在 P1-B Gateway slice 收敛。sidecar 仅发送预算投影，
宿主用 run-local prepared invocation 与本地 Context/Router/token-meter provider 重建评估；两侧均在 emergency
compaction 后以 `context_overflow_after_emergency_compaction` 失败，不再继续请求模型。`budgetEvaluator`、prepared
Router decision 和 calibration 仍不可序列化，不能把该 adapter 实现误称为所有第三方 host 已支持。

| 顺序 | 工作包与唯一 owner | 允许范围与退出门 |
| ---: | --- | --- |
| 0 | **R5.46 Router session-state lifecycle（已完成 native M2）**。`ProjectRuntimeRegistry` 拥有 application-lifetime、volatile `RouterSessionStatePort`（native provider 复用既有 `SessionRouterStore`）；`RouterRuntime` 只消费它；Router generation 不拥有或清空它。 | state Definition 经 `ProjectRuntimeResourcesBundle -> ProjectRouterRuntimeBundle -> createRouterRuntime` 注入；registry shutdown 在 SessionRouter drain 后无论 project dispose 成败都 clear。未写 Session event、未迁入 Gateway/transport，也未改变 key/TTL/capacity 语义。contract 覆盖 Router 不清空外部 state、reload 后 replacement Router 写入同一 provider、应用 shutdown 与失败 cleanup 均清空。 |
| 完成 | **P1-B Compaction budget projection（Gateway）**。Context/Router/token-meter host provider 继续拥有估算、route calibration、summary 与结果；Session adapter 仍是 durable bracket/replacement 的唯一 writer。 | `model.prepare`/`try_auto_compact` 经 capability 协商；sidecar 只传 `budgetProjection`，宿主以 `(runId, operationId, preparationId)` 关联 run-local prepared cache 并在 `finally` 清除。Gateway adapter 使用 session bundle 的 durable model/tool ports，并在 terminal 前等待 host module dispatch；`core-resilience` 21/21 无 semantic diff。第三方 host 仍需实现此 provider 组合。 |
| 1 | **P1-C Existing capability sidecar subagent parity（continuable Gateway slice 已通过）**。host ToolRuntime/continuation manager 继续拥有 child handle、inbox、descriptor、settlement 与 child-first drain；sidecar 仅为既有 `agent` capability consumer。 | 已通过 live/cold continuable follow-up 与 child admission 后 parent close。继续验证 one-shot 的完成/失败/取消、admission 后 parent abort 的 first-wins settlement、parent teardown 后 late child terminal，以及 remote/queued provider；不得新建 transport-owned child Session/queue，或把 subagent 重做为新 Module Protocol endpoint。 |
| 2 | **R5-B.0 deployment/profile audit gate**。本地 Gateway/CLI bundle 仍是唯一完整 deployment owner。 | 先维护启动入口、config precedence、资源 owner、boot rollback 与 shutdown order 的 inventory；只有第二个完整 application deployment consumer 出现，才设计 profile Definition/native-headless-sidecar provider matrix。不得为 `createGateway` embedding factory 或 AgentLoop sidecar 预建第二个 Gateway、Session state machine 或 giant dependency bag。 |
| 3 | **产品触发项**：non-Agent extension lifecycle、full storage data-plane parity、Agent terminal/durable job/workflow、cross-platform sandbox、attachment retention/query。 | 每项必须先有真实 caller 和 run/visibility/cancel/late-result/restart/durable-truth 合同；复用 stage/publish/retire/drain 与 SessionRuntime ownership，不按 DSH 包名预建 registry。 |

共同约束：每轮先按 human-operation SOP 写清 Definition、Provider、Consumer、Composition、scope、teardown 与 failure
mapping；只跑受影响 contract、TypeScript、build 和对应 deterministic parity；将环境型 `BLOCKED` 与 semantic `FAIL` 分开。
所有上述工作包继续禁止修改 `src/agent/loop/AgentLoop.ts`，除非另行完成 core API 设计评审。

### 14.33 R5.46：Router Session-State Definition / Provider / Consumer / Composition（已完成 native M2）

此前 `RouterRuntimeDeps` 已提供 concrete `SessionRouterStore` 注入口，`ProjectRuntimeRegistry` 也提前构造了
`sharedSessionStore`，但 project resource/router bundle 没有传递它。每一次 runtime retirement 因而把 token tier、sticky
provider/model 与 orchestration observation 一起丢弃，和“外部 store 跨 config reload”的既有接口约定矛盾。

现在 `RouterSessionStatePort` 是 `llm/router` 的窄 Definition，只包含 `get(sessionId, isSubagent)` 与 `set(state)`；
native `RouterSessionStateProvider` 继续使用有界、TTL 的 `SessionRouterStore`，但其 `clear()` 只交给 application composition。
`RouterRuntime` 支持新的 `sessionState` 注入（保留 `sessionStore` 兼容别名），自身创建 native provider 时才清理它；外部
state 在 retired Router shutdown 后完整保留。`ProjectRuntimeResourcesBundle` 和 `ProjectRouterRuntimeBundle` 只传递该 port，
`ProjectRuntimeRegistry` 是唯一选择 native provider、跨 project generation 共享并在 application shutdown `finally` 清理的 owner。

新状态仍以现有 global `sessionKey` 为索引，其合法新建值已包含 project key；没有新增 project namespace、Session durable
event、checkpoint、Gateway field 或 Module Protocol payload。故此项只是 DSH 式 lifecycle/composition 收敛，不改变 routing
policy、session identity 或 transport 语义。

Node 22 下 `npx tsc --noEmit -p tsconfig.json` 通过；Router/provider-health、project router bundle 和 project runtime lifecycle
focused suite 为 `21/21`。测试覆盖外部 port 的读写与 Router shutdown 不清空、跨 reload 的 replacement Router 精确写入 registry
provider、正常 application shutdown 清空，以及 execution-world cleanup 失败时 registry 的 `finally` 仍清空。`git diff --check`
与新增文件 whitespace 检查均无输出。

### 14.34 最终核对结论与交付顺序（2026-09-10）

本次逐项核对 DSH 的 `docs/architecture.zh.md`、`core/agent-loop`、session/projection、scope 与 boot/profile 实现，以及
PilotDeck 的 `AgentSessionRuntimeBundle`、`AgentRuntimeScope`、Session event/projection、Module Protocol v2、sidecar default
factory、Gateway parity adapter 和 local Gateway bundles。DSH 的可迁移原则是每项能力同时具备 Definition、Provider、Consumer
和 composition owner，并由 scope/effect teardown 与 append-only session truth 约束生命周期；它不是要求 PilotDeck 复制 Cordis
或将每个目录升格为独立进程模块。

| DSH 能力性质 | PilotDeck 已有对应物 | 当前判定 |
| --- | --- | --- |
| agent scope、注册可见性与可逆 effect | `AgentRuntimeScope`、`ScopedServiceRegistry`、`AgentScopeLiveEventBus`、`scope.own()` | native 主路径已具备，不应为目录对称另建全局 DI/registry |
| append-only session truth 与派生 projection | `SessionRuntime`、event store、projection driver、`AgentSessionEventRecorder` | native 主路径已具备；仅在第二个生产 backend/迁移 caller 出现时扩展全数据面 provider |
| Definition / Provider / Consumer capability seam | `llm`、`capability/tool`、`permission`、`context` 的 native port 与 host adapter | model/tool/permission 与 context auto compaction 已完成 Gateway `core-resilience` parity；通用第三方 host 仍待实现同一 provider 组合 |
| profile/bundle 选择与失败逆序释放 | `LocalGatewayBootstrapBundle`、`LocalGatewayLifecycleBundle`、project/session bundles 与 generation lease | local application 已收敛；尚无第二个完整 deployment consumer，不能预建 profile registry |
| 可替换执行提供方 | Module Protocol v2 与 `AgentLoopSidecarServer` | transport 只承载执行/调用，不能取得 Session、Gateway、Router 或 host business state 所有权 |

已用 Node `v22.23.1` 在真实 Gateway surface 复跑以下基线：

```text
source "$HOME/.nvm/nvm.sh"
nvm use 22
python tools/agent-loop-parity/run.py --suite core-resilience --comparison same-version \
  --surface gateway --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831 \
  --output /tmp/pilotdeck-p1b-core-resilience-final-20260910
```

该运行通过 21/21：无 `BLOCKED`、failure、oracle failure、known gap 或 format warning。`auto_compact` 两侧都在 emergency
compaction 后以 `context_overflow_after_emergency_compaction` 终止；普通 permission/tool、read-file seed、并发 batch、deadline
与 cancel 同样无语义差异。此前出现的两个 transport 级回归也已固定：Gateway adapter 必须使用 session bundle 的 durable
model/tool ports，且在 sidecar terminal 前等待已受理的 host module dispatch 完成。报告位于
`/tmp/pilotdeck-p1b-core-resilience-final-20260910`。这证明 P1-B 的 Gateway parity 已闭合，而不是只更新了文档预期。

后续严格按以下顺序交付：

1. **P1-C 剩余 subagent fixture。** continuable Gateway slice 已验证 live/cold follow-up 与 admission 后 parent close；继续只复用 `SubagentProviderRegistry`、continuation manager 与既有 `agent` capability mapping，补 one-shot 的完成/失败/取消、parent abort 的 first-wins settlement，以及 parent teardown 后 late terminal 的对拍。
2. **R5-B.0 deployment/profile audit gate。** 为实际启动入口补 resource owner、config precedence、rollback 与 shutdown order inventory。仅在出现第二个完整 deployment consumer 后，设计 profile Definition 与 provider matrix。
3. **compaction/admission 的远端收尾。** profile provider selection、cold-resume/retry contract 与 remote/sidecar host parity 必须以现有 durable bracket/replacement 和 native Gateway 行为为 oracle，不能将 adapter 修复泛化为所有 host 已支持。
4. **产品触发的能力。** extension/MCP/LSP reload、完整 session data plane、Agent terminal/durable job/workflow、sandbox 与 attachment retention 各自等待真实 caller；先定义 run owner、visibility、cancel、late completion 与 durable truth，再增加 seam。

每一个工作包都必须先写明 Definition、Provider、Consumer、Composition、owner、payload、teardown、失败映射和 parity fixture；退出门必须包含受影响 contract、TypeScript、build 与对应 Gateway/loop deterministic parity。继续禁止修改
`src/agent/loop/AgentLoop.ts`，除非单独通过 core admission/budget API 设计评审。

### 14.35 P1-C Subagent Sidecar Parity 执行状态与下一步（2026-09-10）

P1-C 不是新增 `subagent` Module Protocol endpoint。`subagent` 与 `send_message` 仍是 host-owned `capability`
调用：宿主保留 `ToolRuntime`、permission preflight、scheduler、child `AgentHandle`、child inbox、descriptor persistence、
continuation manager、terminal settlement 和 child-first drain；sidecar 只消费 descriptor 并调用既有 capability。不得把
child Session、inbox 或 continuation state 搬入 transport，也不得在 sidecar 重做权限或调度。

已完成的最小闭环是 continuable child 的真实 Gateway slice：

| 覆盖项 | 证据 | 结论 |
| --- | --- | --- |
| live follow-up | `sidecar_continuable_followup_live` | child 仍运行时，`subagent` 后的 `send_message` 进入同一 child inbox；native/sidecar canonical trace 等价 |
| cold follow-up | `sidecar_continuable_followup_cold` | child 已落盘/失活后，host 按 descriptor inspect/resume；不在 sidecar 持有 child 状态 |
| parent close after admission | `sidecar_parent_close_after_admission` | mock 已收到 child model request 后才关闭 parent；native/sidecar 均记录 `parentClosed` 和 child-first drain，canonical trace 等价 |
| generated identity | `tools/agent-loop-parity/test_trace.py` | 只按同一 trace 内 UUID 引用关系归一化；错误 child target 和用户提供 id 仍是语义差异 |

复核使用 Node `v22.13.1`：

```text
PATH=/Users/a1/.nvm/versions/node/v22.13.1/bin:$PATH \
python tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831 \
  --pilotdeck-baseline working-tree --suite subagent-parity --surface gateway \
  --comparison same-version --output /tmp/pilotdeck-subagent-parity.FvTo9m
```

结果为 `3/3 PASS`，没有 `BLOCKED`、semantic diff、oracle failure 或 format warning。关联证据为 `pnpm build`、
default factory focused test `6/6 PASS`、session-router/active-turn/session-storage focused suite `21/21 PASS`，以及在
`tools/agent-loop-parity` 目录执行的 `python3 -m unittest test_trace.py` `4/4 PASS`。

parent-close 原先正确被标记为 `BLOCKED`，但根因已在 Gateway parity adapter 修复，而不是 child metadata 或 lifecycle
owner 缺失。native child 从 catalog 获得 `8192` context window，且刻意不继承 output reservation；sidecar adapter 却把
catalog 的 `maxOutputTokens: 32768` 注入 child payload，错误触发 `context_overflow_after_emergency_compaction`。修复后，
`StdioAgentLoopRunner` 只投影 `AgentRuntimeConfig` 显式携带的 token cap；budget evaluator 仍可用 catalog 回填缺失的
context window，但绝不以 catalog 回填 reserved output。native/sidecar 也使用独立 session key，避免异步 transcript flush
污染后一个 adapter 的恢复路径，同时保持同一 runtime root/project cwd，消除模型可见 cwd 差异。

P1-C 尚未成为完整 subagent deployment parity。下一批 fixture 仍须在真实 Gateway native/sidecar surface 严格比较 request、
tool lifecycle、terminal、cancel/close 和 child reference：

1. **one-shot provider**：验证非 continuable `subagent` 的完成、失败和取消 canonical tool result，不得以 descriptor 或
   `send_message` 路径冒充覆盖。
2. **parent abort after admission**：验证 abort 只取消该 turn，child/parent terminal 遵循 first-wins settlement，且无重复 result。
3. **late child terminal after parent teardown**：迟到 terminal 不能重开 parent、覆盖已提交 outcome 或产生重复 transcript/result。
4. **remote/queued provider**：只有真实 provider 接入后才进行 deployment parity；不得用本地 sidecar PASS 推断其已对等。

P1-C 的这一 continuable slice 已可进入 R5-B.0 deployment/profile audit；R5-B 仍只盘点启动入口、resource owner、config
precedence、rollback 和 shutdown order，不预建全局 profile registry。

### 14.36 P1-0：Live Session Durable Writer Exclusivity（已完成）

DSH 的 session persistence coordinator 要求每个 session 的追加操作在唯一序列化路径中形成连续 `seq`；live event 和
durable append 不能由两个互不知情的 runtime 并发恢复后写入。PilotDeck 现已采用同一 ownership：live `AgentSession`
是当前 durable truth 的 writer，history bundle 仅服务于没有 live owner 的冷读写。

此前 `InProcessGateway` 对 context-budget event 的 history-bundle 写入会与 live `TurnRunner` 并发，导致同一 sequence
同时出现 `model_request` 和 `agent_status_message(context_budget)`。现在调用链为：`SessionRouter` 以 exact live handle
查找 session，`AgentSession` 委托既有 `TurnRunner` transcript writer 追加 status；只有 router 返回 `not_live`，
`InProcessGateway` 才调用 `GatewaySessionHistoryBundle` 的 cold-history fallback。因此没有引入第二个 `SessionRuntime`、
writer 或 durable state owner。

| 项目 | 已落地的边界与证据 |
| --- | --- |
| live owner | `SessionRouter.recordAgentStatusMessage()` 使用 exact live session；`AgentSession.recordAgentStatusMessage()` 交给 `TurnRunner` 既有 transcript writer。 |
| cold fallback | `InProcessGateway.recordAgentStatusMessage()` 只在 `not_live` 时委托已注入的 history bundle；该路径继续由 `ProjectSessionWriteCoordinator` 串行。 |
| failure discipline | 不吞掉 sequence 冲突，也不在 replay/parity normalizer 中归一化重复 durable event。 |
| 验证 | `session-router-lifecycle`、`active-turn-snapshot` 与 `project-session-storage-provider` focused suite 为 `21/21 PASS`；P1-C Gateway parity `3/3 PASS`，无 duplicate sequence。 |

该项未修改 `AgentLoop`、Module Protocol 或业务 status payload。P1-C 的已通过结果可以采信；其余 one-shot、abort、late
terminal 与 remote/queued provider fixture 仍按 14.35 的 deployment parity 范围继续推进。

### 14.37 P1-C one-shot Subagent：架构复核、拆分与执行门（2026-09-10）

本节以 DSH `dsh-subagent` 的实际服务定义和 PilotDeck 当前 Gateway 对拍为依据，替换“one-shot 已被
continuable 覆盖”的错误假设。DSH 将具名 provider registry、one-shot `start()`、continuable
`startContinuable()`、模型工具 consumer 与 child run owner 分开：provider 在 child 已发布后才转移 run
ownership；continuation manager 只持有 continuable child 的 `AgentHandle` 和 inbox。PilotDeck 已具备
`SubagentProviderRegistry`、`SubAgentSession`、`GatewaySubagentRuntimeBundle` 与
`SessionSubagentContinuationBundle`，但后两者当前只把 *continuable* consumer 组合进 Gateway session。

真实 Gateway 同版本对拍已运行：

```text
PATH=/Users/a1/.nvm/versions/node/v22.13.1/bin:$PATH \
python tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831 \
  --pilotdeck-baseline working-tree \
  --scenario sidecar_one_shot_subagent_success \
  --surface gateway --comparison same-version \
  --output /tmp/pilotdeck-one-shot-success-roadmap-20260910
```

结果为 `FAIL: 14 semantic difference(s)`，无 oracle failure。native 和 sidecar 都没有完成 child：

| 路径 | 直接证据 | 架构判定 |
| --- | --- | --- |
| native one-shot | `SubAgentSession.runNative()` 手写 sidechain `recordAcceptedInput()` 后，durable model/context port 调用 `AgentSessionEventRecorder.requireTurn()`，报 `Durable turn <child>-t0 has not started` | child durable turn 的 Definition/Provider 没有在 one-shot run owner 处完整组合；不能用 transcript 写入替代 turn admission |
| sidecar one-shot | default factory 将 `agent` descriptor 映射为 generic host-capability proxy；host capability 最终缺少不可序列化的 `context.subagent`，报 `agent tool requires a model client ... or wire context.subagent` | transport 已有 capability consumer，但 Gateway 没有把 one-shot provider consumer 组合到该 host-owned capability |

`SessionSubagentTranscriptBundle` 已通过 `recordSubagentAcceptedInputWithDescriptor()` 保证 descriptor 紧邻首个
visible input；one-shot 修复必须保留这个顺序。它也不能改为把 `AgentHandle`、child inbox、session storage、manager
或 `context.subagent` 序列化进 Module Protocol。DSH 对照结论是：这些始终属于 native host/provider composition；sidecar
只发既有 capability call 并取得 canonical tool result。

后续以如下顺序执行，且不修改 `src/agent/loop/AgentLoop.ts`：

| 工作包 | 定义 / owner | 交付内容 | 退出门 |
| --- | --- | --- | --- |
| **P1-C.1 one-shot durable admission** | one-shot provider/run owner；child transcript 与 event recorder | 先启动 child recorder/`turn_started`，再保留 descriptor 紧邻 accepted-input 的既有持久化顺序；任何 model/context/tool durable record 都只能发生在 child turn admission 后 | 新增 JSONL sidechain 回归：child 有 `turn_started`，无 `Durable turn ... has not started`；success/failure/abort 均只有一个 terminal |
| **P1-C.2 host one-shot capability consumer** | Gateway session composition；`SubagentProviderRegistry` 是 provider source of truth | 把 `agent` capability 映射到 host-owned one-shot provider consumer，复用 `SubAgentSession`/native provider 的 start-dispose 语义与现有 scheduler/permission；不增加 protocol endpoint | sidecar `agent` 不再进入 model-client fallback；capability result 保留 native 的 tool error code、tool call id 和 cancel 语义 |
| **P1-C.3 terminal settlement** | parent turn/child run 的 first-wins owner | parent abort、parent teardown 与 late child terminal 只能完成一次；拒绝已终态 parent 上的迟到 child result | `sidecar_one_shot_parent_abort_after_admission` 满足 `parentAborted=true`、`terminalCount=1`；late-terminal fixture 无重复 transcript/result |
| **P1-C.4 deployment parity gate** | Gateway adapter，不是 trace normalizer | 运行 one-shot success、failure、abort 后再运行完整 `subagent-parity`；failure fixture 以 native canonical trace 定义真实错误码 | 三条 one-shot fixture 与已有 continuable `3/3` 全部通过；无 semantic diff、oracle failure 或 known gap |

P1-C.1 与 P1-C.2 可先分别写 focused regression，但必须在真实 Gateway surface 汇合验收；P1-C.3 依赖两者完成。
P1-C.4 通过后才进入 R5-B.0 的 deployment/profile audit。remote/queued provider 仍需真实 provider 落地后单列
deployment parity，不以 local sidecar 通过作替代证据。

### 14.38 DSH/PilotDeck 架构复核后的执行 Roadmap（2026-09-10）

本节是当前执行基线，覆盖 14.37 中 one-shot 尚未修复的历史状态。复核以 DSH
`docs/architecture.zh.md`、`core/scope`、`core/session`、`subagent/subagent` 与 `boot/app-boot` 为架构证据，
并以 PilotDeck 当前 worktree 的 scope、Session event/projection、Gateway composition 和确定性 Gateway parity 为
实现证据。判断单位是一个完整 seam：**Definition、Provider、Consumer、Composition，以及唯一 owner 和 teardown**；
目录、Port 或 Module Protocol endpoint 单独存在都不计为能力族完成。

#### 14.38.1 当前成熟度

| 能力族 | DSH 要求的关键性质 | PilotDeck 已验证状态 | 当前等级 / 未闭环项 |
| --- | --- | --- | --- |
| Agent / scope / publication | scoped visibility、owned effect、发布失败回滚、creator-only handle | `ScopedServiceRegistry`、`AgentRuntimeScope`、`AgentScopeLiveEventBus`、factory transaction 与 `AgentHandle` 已覆盖 native 主路径 | M3；不因目录对称预建全局 DI 或 contribution registry |
| Session / persistence / projection | append-only truth、领域校验、可丢弃 projection/checkpoint、单一 writer | `SessionRuntime`、persistence、projection driver、`AgentSessionEventRecorder` 和 live-writer/cold-read 分工已经闭合 | M3；第二个生产 backend 或 migration caller 出现前不扩 full data-plane contract |
| Model / context / tool / permission | provider 替换不转移 Session/Router owner；durable model-visible facts | native Port 与 host consumer 已形成，Gateway `core-resilience` 已覆盖 prepared request 与 compaction budget projection | M2-M3；第三方 host 仍需自己组合 host-owned Router/context/token provider |
| Subagent | named provider、one-shot/continuable 分离、child run owner、inbox/settlement 不在 transport | continuable Gateway slice 已通过；one-shot child 现以 `AgentSessionRuntimeBundle` 建立 durable turn，Gateway 注入 `createNativeOneShotSubagentPort()`，不序列化 child state | M2-M3；仍需 failure/abort/late-terminal 和完整 suite 证据 |
| Application boot / profile | ordered provider selection、patch precedence、boot rollback、reverse teardown | local Gateway/CLI bundles、project generation lease 和 shutdown bundle 已完成一套 native composition | M2；没有第二个完整 deployment consumer，不能创建 profile registry |
| Extension / storage / terminal / jobs / workflow | 每项有真实 caller、run owner、visibility、cancel、late result、restart/durable truth | extension/MCP generation lease、UI terminal lifecycle、Upload lease 和 execution-world ports 有局部实现 | M0-M2，均由真实产品需求触发，不按 DSH package 数量补齐 |

#### 14.38.2 已核验的 one-shot 状态

14.37 的两个架构缺口已按 DSH owner 分层修复，而没有改变 `AgentLoop.ts`：

- `SubAgentSession.runNative()` 用 child sidechain 的 `AgentSessionRuntimeBundle` 先记录 `turn_started`，再记录 descriptor
  与 accepted input；所以 model/context/tool 的 durable event 都属于 child turn，而不是 parent transcript 的旁路写入。
- `createNativeOneShotSubagentPort()` 是 Gateway host composition 的 consumer。它从现有 named provider 路径创建
  `SubAgentSession`，保留 parent transcript、deadline/cancel、permission 和 scheduler ownership；sidecar 只做既有
  `capability` 调用，未新增 `subagent` protocol endpoint。

已运行的 focused contract 为 `26/26 PASS`：`OneShotSubagentPort`、`SubAgentSession` 和
`SessionSubagentTranscriptBundle`。Gateway same-version success fixture 的原有 14 项差异已收敛为 5 项：唯一差异是
同一 canonical one-shot result 中的 wall-clock `durationMs`（本次 native `2034`，sidecar `2046`）。请求、child report、
tool lifecycle、terminal 和 oracle 均一致；这说明 durable admission 与 host consumer 已真实汇合，但该场景尚不能标记为
parity PASS。

`durationMs` 是诊断计时而非模型/工具决策输入，却被嵌入 tool-result JSON、后续 model-visible message 与 raw metadata。
因此它只能由一个严格限定的 trace canonicalization 规则处理：删除对象中的 `durationMs`，并且只对可解析为 JSON 的
嵌入字符串递归处理同名 key。规则不得删除其他数值、文本、tool result 字段、错误码或顺序；必须有回归证明相同 report
的不同 duration 等价，而相同位置的 report text、usage、turns 或 error 不同仍然失败。

#### 14.38.3 交付顺序

| 优先级 | 工作包 | Definition / owner 边界 | 退出门 |
| ---: | --- | --- | --- |
| 0 | **P1-C.2a timing trace policy** | parity trace canonicalizer；不改变 product event、Session log 或 tool result | 新增 `test_trace.py` 回归；one-shot success 只因 `durationMs` 不再 FAIL，任一非计时字段改变仍 FAIL |
| 1 | **P1-C.3 one-shot terminal settlement** | parent turn/child run 的 first-wins settlement；Gateway/host 继续拥有 abort 与 teardown | success、failure、parent abort after admission、late terminal 四个 fixture 都有精确 terminal count、error/cancel 和 transcript oracle |
| 2 | **P1-C.4 subagent deployment gate** | Gateway adapter；transport 不持有 child session/inbox/descriptor | one-shot fixtures 与 continuable 3 项组成完整 `subagent-parity` suite，零 semantic diff、oracle failure、known gap 或 BLOCKED |
| 3 | **R5-B.0 boot/profile audit** | local Gateway/CLI composition owner | 维护启动入口、provider selection、config precedence、rollback 与 shutdown order inventory；出现第二个完整 deployment consumer 前不实现 profile registry |
| 4 | **真实 deployment 触发的 remote parity** | remote/queued provider、remote prepared retry、compaction cold-resume 各自的 host provider | 每个真实 provider 单独证明 canonical request、durable result、cancel/deadline/restart；不把 local sidecar 通过外推到 remote |
| 5 | **产品能力** | terminal、durable job/workflow、extension reload、storage backend、attachment retention、cross-platform sandbox 各有独立 owner | 先获得真实 caller 和 run/visibility/cancel/late-result/restart/durable-truth contract，再新增 seam |

全程不做四件事：复制 Cordis/DSH package 名称；把 transport 提升为 Session、Gateway、Router 或 child state owner；在没有
第二个 deployment 或产品 caller 时预建 profile/job/workflow registry；为完成 parity 修改 `src/agent/loop/AgentLoop.ts`。
每个工作包只运行受影响的 contract、TypeScript/build 和对应 deterministic Gateway parity，并将环境 `BLOCKED` 与真实
semantic `FAIL` 分开报告。

### 14.39 P1-C one-shot Gateway parity 完成（2026-09-10）

14.38 的 P1-C.2a、P1-C.3 和 P1-C.4 已在真实 Gateway native/sidecar surface 完成，且没有修改
`src/agent/loop/AgentLoop.ts`、Module Protocol 或 child Session/inbox 的 owner。

| 完成项 | 实现与 owner | 验证 |
| --- | --- | --- |
| timing trace policy | `trace.py` 只把对象或完整/末行 JSON 中的 framework `durationMs` 当作 volatile；report 文本、usage、turns、error 和顺序仍逐项比较 | `test_trace.py` 覆盖 duration 相等化与 report 内容差异保留 |
| one-shot failure | Gateway adapter 的 `MockModelRuntime` 是 model fault script 的唯一注入 owner；不再把已 locally injected model fault 交给独立计数的 mock backend 二次触发 | child model 的 non-retryable failure 变成 canonical `agent` tool error，parent 继续到 `MOCK_AFTER_ONE_SHOT_FAILURE` |
| parent abort / close | host 保持 child deadline、abort、close、settlement 与 transcript owner；新增 one-shot parent-close-after-admission fixture | abort 有 `parentAborted=true`、`terminalCount=1`；close 在 child model request 已入场后完成 parent child-first drain，不出现重复 result |
| adapter teardown | Gateway parity adapter 在删除临时 runtime 前 `await local.dispose()`；`createLocalGateway` lifecycle 是异步 owner | 默认 cleanup 模式的完整 suite 无 cleanup `BLOCKED` |

Node `v22.13.1` 下完成了：`python3 -m unittest test_trace.py`（7/7）、`pnpm exec tsc --noEmit`、`pnpm build`，以及：

```text
PATH=/Users/a1/.nvm/versions/node/v22.13.1/bin:$PATH \
python3 tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831 \
  --pilotdeck-baseline working-tree --suite subagent-parity \
  --surface gateway --comparison same-version \
  --output /tmp/pilotdeck-subagent-parity-cleanup-await-20260910
```

该 suite 现在是 `7/7 PASS`，无 `BLOCKED`、semantic diff、oracle failure、known gap 或 format warning。P1-C 的本地
Gateway gate 可以关闭；remote/queued provider 仍是独立的真实 deployment 工作包，不能由这项结果外推。下一优先级为
R5-B.0 deployment/profile audit：先证明现有 local Gateway/CLI 资源的 provider selection、rollback 与 shutdown order，
在出现第二个完整 application deployment consumer 前不新增 profile registry。

### 14.40 Extension reload failed-stage preservation（2026-09-10）

`PluginRuntime.refreshWithReport()` 是已有的 non-Agent extension consumer：Gateway command catalog 与 session composition
都会在使用 contribution snapshot 前调用它。此前 disk plugin/standalone skill 的 load error 被吞掉，随后的
`replaceAll()` 会把仍在磁盘上的旧 plugin 当作删除，从 active generation 撤销其 tool/MCP/hook contribution。

现在 refresh 先完整 staging discovery 的 plugin/skill attempts。若某个**已激活**的 source/path 仍被发现但未能加载，
runtime 保留当前 generation、instance 与 lease，不调用 `replaceAll()` 或 disposer，并从 `PluginRefreshResult.stagedFailures`
公开失败 path/source/kind；真正从 discovery 消失的 path 仍按既有 generation retire/dispose。这个边界保留
`PluginRegistry` 作为实例/lease/dispose owner，不让 Session、Gateway 或 transport 接管 plugin state。

验证包括实际 filesystem plugin 的损坏 JSON reload 和目录真删除两条回归，`plugin-registry-lifecycle` 为 `12/12 PASS`；
`pnpm exec tsc --noEmit` 与 Node `v22.13.1` 的 `pnpm build` 均通过。该切片满足“failed stage 保留旧 generation”，但
不宣称 MCP/LSP/command 的所有跨部署 reload consumer 已完成；它们仍须分别复用同一 lease/stage/publish/retire/drain 合同。

### 14.41 DSH 与 PilotDeck 架构复核后的执行队列（2026-09-10）

本节以 DSH `v0.1.2-alpha.2` 的 scope、session persistence/projection、subagent、boot/bundle 与 extensions
发布契约为参照，并重新沿 PilotDeck 的实际调用链核对：
`createLocalGateway -> ProjectRuntimeResourcesBundle -> ProjectSessionRuntimeBundle -> AgentSessionRuntimeBundle -> AgentRuntimeScope`
以及 `ToolRuntime -> LifecycleRuntime -> HookRuntime`。结论的判断单位仍是完整 seam：Definition、native Provider、
真实 Consumer、Composition owner、唯一状态 owner 与 teardown。目录、Port 或 sidecar endpoint 任一单独存在都不提高成熟度。

| 能力族 | DSH 要求的关键性质 | PilotDeck 已核验的真实闭环 | 成熟度与剩余边界 |
| --- | --- | --- | --- |
| Agent / scope / publication | 作用域同时约束可见性、effect owner 与释放；create/resume 发布失败可回滚 | `ScopedServiceRegistry`、`AgentRuntimeScope`、`AgentScopeLiveEventBus`、factory transaction、`AgentHandle` | **M3 native**。不为包名对称建立全局 DI 或通用 contribution registry。 |
| Session / persistence / projection | append-only 真源、单 writer、可丢弃 projection/checkpoint、独立 persistence backend | `SessionRuntime`、`SessionPersistence`、projection driver、`AgentSessionEventRecorder`、live writer/cold reader 分工 | **M3 native**。只在第二个真实 backend 或数据迁移 consumer 出现时扩展 fork/replace/catalog/search 的全数据面契约。 |
| Model / Context / Tool / Permission | provider 可替换但不夺取 Router、Session、token meter 或 durable event owner | native Port、host consumer、Gateway `core-resilience`、prepared-request/compaction budget projection | **M2-M3**。第三方 host 必须自行组合 Router/context/token provider；transport 不能保存其 opaque state。 |
| Subagent | named provider、one-shot/continuable 分离、child inbox/settlement/run owner 不在 transport | `SubagentProviderRegistry`、continuation manager、native one-shot port、Gateway native/sidecar `7/7` parity | **M3 local Gateway**。remote/queued provider 仅在真实部署接入后单列 parity，不能由 sidecar 结果外推。 |
| Local boot / composition | bundle 选择 provider、启动失败逆序释放、停止顺序可审计 | bootstrap/lifecycle、project/session/Gateway bundles、generation lease | **M2 local application**。当前只有一个完整 deployment consumer，尚不批准 profile registry。 |
| Extension / hooks / telemetry | generation stage/publish/retire/drain，动态 contribution 不泄漏 scope | frozen Agent-scoped prompt/tool/hook/custom-router snapshot、PluginRegistry lease、failed-stage 保留旧 generation、Gateway telemetry observer、`FileChanged` post-commit observation，以及 command body 的 session admission | **M1-M2**。command 与 custom router 已按 session 持有 frozen generation；非 Agent-scoped MCP/LSP 的每个 consumer 仍需独立 owner/refresh contract。 |
| Execution world / product capability | 每项有 run owner、可见性、取消、迟到结果、restart 与 durable truth | Fs/Subprocess/Shell/Sandbox ports、UI terminal lifecycle、task control、cron、plan/todo、upload lease | **M1-M2**。Agent terminal、durable job/workflow、跨平台 sandbox、通用 attachment retention/query 未形成完整能力族。 |

#### 14.41.1 当前优先级

| 顺序 | 工作包 | Definition / Provider / Consumer / Composition 边界 | 退出门 |
| ---: | --- | --- | --- |
| 1 | **E1.1 `FileChanged` post-commit hook（已完成）** | Definition：canonical `{ absolutePath, relativePath, changeKind }` hook payload。Provider：`write_file`、`edit_file`、`edit_notebook` 成功写入后已有的 `fileUpdateNotifier` notification。Consumer：session-owned `LifecycleRuntime`/`HookRuntime`。Composition：既有 `AgentSessionRuntimeBundle` 注入的 `ToolRuntime`。 | 仅成功 mutation 触发一次；matcher 使用 `absolutePath`；只读/失败工具不触发；hook timeout、blocking 或 executor error 只记录为 live warning，不把已成功写入改为 tool error 或回滚文件。 |
| 2 | **E1.2 extension command body admission（已完成）** | Definition：agent-owned `AgentInputAdmission`。Provider：`LoadedPluginCommand.content` 经 `PluginRuntime` frozen contribution snapshot 和 `PluginRuntimeExtensionResolver` 投影，Context `InputProcessor` 实现 admission。Consumer：`TurnInputProcessor`。Composition：`ProjectSessionRuntimeBundle` 创建冻结 resolver/provider，并经 create/resume/recreate 注入 `TurnRunner`。 | 同一 session 永远使用其 lease 对应 generation；正文和 argument 以有界、明确分隔的 model-visible user message 进入 accepted input；无正文保持当前兼容 fallback；reload 不影响旧 session；minimal `createAgentSession()` 仍使用默认 processor。 |
| 3 | **E1.3 session-scoped custom-router provider（已完成）** | Definition：`RouterSessionCustomRouterPort` 以 `(extensionId, sessionId)` 查询已冻结 provider。Provider：project-owned registry。Consumer：`RouterRuntime`。Composition：`ProjectRuntimeResourcesBundle` 创建 registry；`ProjectSessionRuntimeBundle` 用同一个 plugin lease 生成 router 并注册/release。 | 旧 session 永远命中其 lease generation；同 session dirty recreate 的 stale release 不得删掉 replacement；Router 不再读取 live `PluginRuntime`；project dispose 清空 registry。 |
| 4 | **R5.47 ProjectSessionFactory（已完成）** | Definition：`ProjectSessionFactory`。Provider：local application registry 提供已发布 generation、runtime lease 与 permission rule-set lease。Consumer：`SessionRouter` 的 create/recreate callbacks。Composition：`createLocalGateway` 构造 factory，并在 application shutdown dispose per-session MCP registry。 | create/recreate failure 逆序释放 resource lease；成功时 release callback 转交 exact AgentHandle；factory 不拥有 project generation publish/retire、Gateway pending state、Session durable truth 或 AgentLoop。 |
| 5 | **R5.48 ProjectMemoryMaintenanceController（已完成）** | Definition：generation-scoped `ProjectMemoryMaintenancePort`；Provider：application-owned controller，消费该 generation 的 `memoryService`、telemetry 和诊断 sink；Consumer：`GatewayRuntimeRefreshBundle.afterTurnCompleted()`；Composition：`ProjectRuntimeRegistry`。 | 同一 generation 的重复请求 coalesce；success/failure telemetry 与当前一致；无 service no-op；异常不影响 turn；replacement generation 不复用旧 state。它不拥有 memory provider、Session durable truth、Gateway pending state 或 project generation publish/retire。 |
| 6 | **R5.49 ProjectRuntimeRegistry（已完成）** | Definition：project-generation lifecycle registry。Provider：`ProjectRuntimeRegistry`。Consumer：`SessionRouter`、Gateway refresh、permission-grant port 和 shutdown lifecycle。Composition：`createLocalGateway` 只提供 config/extension watcher、browser-use args builder 和 bootstrap owner。 | published generation、lease、staging reload、retire/dispose、session factory 和 volatile Router state 仍有唯一 owner；failed staging、retired drain 和 shutdown 不变；root 不再包含第二份 registry implementation。它不拥有 Gateway pending state、Session durable truth 或 AgentLoop。 |
| 7 | **R5-B.0 deployment/profile 审计门** | Definition 不是 profile registry，而是启动资源清单。Provider/Consumer 仍是 local Gateway/CLI bundle；composition 继续在当前 application root。 | 为每个启动资源明确创建点、config precedence、owner、rollback 和 shutdown order；补 boot-failure focused contract。只有第二个完整 application deployment consumer 出现后，才设计 profile Definition 和 provider matrix。 |
| 8 | **E1.4 非 Agent-scoped extension consumer**（需求触发） | 按第一个真实 MCP 或 LSP caller 定义 provider registration；Gateway command catalog 仍仅为 disk catalog projection，不能成为 Agent command owner。`PluginRuntime` 继续拥有 instance generation，consumer 只持 snapshot lease。 | stage failure 保留旧 generation；removed source 恰好 retire/dispose 一次；旧 lease drain 后才 dispose；不会跨 session 泄漏 contribution。不得先造跨所有 extension 类型的 registry。 |
| 9 | **远端 deployment parity**（接入触发） | remote/queued subagent、remote prepared retry、compaction cold-resume 分别由其 host provider 拥有 Router/Session/child state。 | 每个已接入 provider 单独证明 canonical request、durable result、cancel/deadline、restart 与 late terminal；不增加 transport-owned Session/Gateway/Router/child queue。 |
| 10 | **产品能力 seam**（需求触发） | Agent terminal、durable job/workflow、跨平台 sandbox、attachment retention/query、第二个 storage backend 分别建 Definition。 | 先获得真实 caller 及 run owner、visibility、cancel、timeout、late completion、dispose、restart/unknown-result 与 durable truth 合同；没有这些输入时不预建 registry。 |

`E1.1` 已按上述边界完成。`ToolRuntime` 装饰既有 `fileUpdateNotifier`，先保留 upstream `didChange`/`didSave` 顺序，
随后只在成功 save 后把 canonical update 以 `absolutePath` 作为 matcher 投影为 `FileChanged`。嵌套工具调用复用同一
decorated notifier；block、executor error、disposed lifecycle 和 timeout 均降级为 live warning。focused contract 覆盖
canonical matcher/upstream order、真实 `write_file` filesystem 路径、block/error isolation 及 read-only/no-save non-emission。
这是 post-commit observation，不是 durable Session event、pending-hook state，也不改变 `PostToolUse` 的阻塞语义。

#### 14.41.2 E1.2 command admission（已完成）

这项工作属于 DSH `extensions` + `system-prompt`/input-admission 能力族，不是 Gateway command catalog 的扩展。当前
以下调用链已经形成完整 seam：

```text
PluginCommandLoader.content
  -> PluginRuntime.acquireContributionSnapshot()      (generation + lease 已有)
  -> PluginRuntimeExtensionResolver.listCommands()    (冻结投影 content)
  -> InputProcessor.accept()                           (Context provider)
  -> TurnInputProcessor.accept()                       (AgentInputAdmission consumer)
  -> TurnRunner.recordAcceptedInput() / AgentLoop.run()
```

`ProjectSessionRuntimeBundle` 在每次 session composition 取得 frozen contribution lease，并以该 snapshot 创建
`PluginRuntimeExtensionResolver` 与 `InputProcessor`。`createLocalGateway` 的 create/resume/recreate 三条路径均将
同一 `AgentInputAdmission` 注入 `TurnRunner`；`TurnInputProcessor` 只依赖 agent-owned Definition，不依赖 Context 的具体类。

| 角色 | E1.2 责任 | 明确不拥有 |
| --- | --- | --- |
| Definition | `AgentInputAdmission`、`ContributedCommand.content?: string`，以及 bounded/delimited command-body message contract | plugin reload、turn durable truth、Gateway catalog |
| Provider | loader 读取的 `LoadedPluginCommand.content`；PluginRuntime snapshot 冻结 generation；Context `InputProcessor` 以此渲染 | session lifecycle、model dispatch |
| Consumer | `TurnInputProcessor` 消费 admission；`TurnRunner` 记录 accepted input 并提交 loop | command filesystem discovery、plugin dispose |
| Composition | `ProjectSessionRuntimeBundle` 在 lease 存活期创建 provider；`createAgentSession`/resume/recreate 透传它 | 第二个 command registry、transport pending state |

实现已按该顺序完成：snapshot/resolver 投影正文，`TurnInputProcessor` 消费 session-owned `AgentInputAdmission`，project bundle
注入 create/resume/recreate。`PluginRuntime` 同时对同名 command 使用 project > global > builtin precedence，避免 discovery
顺序改变 model-visible body。focused tests 覆盖正文与 argument 的 accepted/model-visible message、长度上限、无正文 fallback、
实际 disk plugin precedence、reload 后旧 session 保持旧 generation、以及 minimal direct session 默认行为。前端 command list、
MCP/LSP provider、Session event schema、Gateway state machine 与 `AgentLoop.ts` 均未改变。

#### 14.41.3 E1.3 session-scoped custom-router provider（已完成）

这项属于 DSH `extensions` 的 scope/effect teardown 性质，而不是 Router policy 或 transport。此前 `RouterRuntime` 每次
`decide()` 都向 live `PluginRuntime` 查询 custom router；新的 session 创建触发 plugin refresh 后，旧 session 因而可能执行
新 generation 的函数，违反 frozen contribution lease。现在调用链为：

```text
PluginRuntime.acquireContributionSnapshot()
  -> frozen contributions.routers
  -> ProjectSessionRuntimeBundle register(sessionKey, created routers)
  -> RouterSessionCustomRouterRegistry.lookupRouter(extensionId, sessionId)
  -> RouterRuntime.resolveCustom()
```

| 角色 | E1.3 责任 | 明确不拥有 |
| --- | --- | --- |
| Definition | `RouterSessionCustomRouterPort`：按 exact session identity 查询 custom router，并返回可释放 registration | plugin discovery、generation publish、Router policy、Session durable state |
| Provider | project-owned `RouterSessionCustomRouterRegistry` | plugin disposer；plugin lease 仍由 session resource lease owner 释放 |
| Consumer | `RouterRuntime` 将其已有 `input.sessionId` 传给 lookup | session creation、plugin refresh、router replacement |
| Composition | project resources 创建/关闭 registry；session bundle 从同一 frozen snapshot 创建 provider 并在 `GatewaySessionResourceLeaseBundle` 中释放 | live plugin lookup、Gateway/transport pending state |

定向契约覆盖 exact session isolation、同 session replacement 后 stale release 不删除新 registration、dispose gate、Router 决策按各自
session generation 选择 provider，以及 plugin snapshot 暴露 router contribution。`RouterRuntime` 不再直接依赖
`PluginRuntime.lookupRouter()`；Session/Gateway/Router state 没有迁入 extension 或 transport。该切片是 native M2，不意味着
MCP/LSP 已有相同 consumer，后者仍需以首个真实 caller 单独设计。

#### 14.41.4 R5.48：ProjectMemoryMaintenanceController（已完成 native M2）

`ProjectMemoryBundle` 已把 provider/service 的 construction 与 close 收敛为 project-generation resources；但
`createLocalGateway.ts` 中的 `ProjectRuntimeRegistry.scheduleMemoryMaintenance()` 仍同时持有 per-generation
coalescing state、调用 `memoryService` 和发 telemetry。它有明确的 consumer（`GatewayRuntimeRefreshBundle` 在
turn completed 后调用），因此适合先提取一个窄的 native controller；这不是为 memory 预建通用 scheduler。

| 角色 | R5.48 责任 | 明确不拥有 |
| --- | --- | --- |
| Definition | `ProjectMemoryMaintenancePort.schedule(runtime)`，或等价的 controller public method；语义是 best-effort、同 generation 合并和 non-blocking | memory persistence、task durable state、Gateway refresh state |
| Provider | `ProjectMemoryMaintenanceController`；以 `WeakMap<ProjectRuntime, State>` 或 runtime-owned private state 保存 in-flight/requested，调用该 runtime 的 `memoryService` | project runtime publish/retire、`memoryService.close()`、Session/AgentLoop lifecycle |
| Consumer | `GatewayRuntimeRefreshBundle.afterTurnCompleted()` 继续只发 schedule request | memory service selection、retry policy、telemetry ownership |
| Composition | `ProjectRuntimeRegistry` 创建 controller，并将 schedule delegation 注入现有 refresh bundle | 新 profile、跨进程 protocol、第二份 application dependency bag |

`ProjectMemoryMaintenanceController` 现在以 exact runtime identity 的 `WeakMap` 保存 in-flight/requested state；
`GatewayRuntimeRefreshBundle` 只消费 `ProjectMemoryMaintenancePort`，`ProjectRuntimeRegistry` 只提供 resolve/publish/retire。
focused contract 覆盖无 memory service 的 no-op、in-flight coalescing、success telemetry、failure telemetry/error isolation
和 replacement runtime state isolation。实现没有改变 `ProjectMemoryBundle` 的 provider close 顺序、Session durable event、
Gateway pending map 或 `AgentLoop.ts`。

#### 14.41.5 R5.49：ProjectRuntimeRegistry（已完成 native M2）

`ProjectRuntimeRegistry` 现从 `createLocalGateway.ts` 提取为独立 application provider。它继续是唯一的 project-generation
state owner：resources stage/publish/retire、session lease、serialized reload、failure cleanup、permission rule-set 和
session factory 都在该模块内；`createLocalGateway` 只提供 bootstrap、watcher callback 和 browser-use argument composition。

focused suite 覆盖 retired generation 在 session/stream drain 前保持 provider、failed staging 保持旧 generation、partial build
cleanup、concurrent reload serialization、MCP/plugin release order、shutdown cleanup、Gateway refresh 与 browser-use composition。
该提取没有引入 deployment profile、全局 DI、第二个 runtime table，且未改变 Session durable state、Gateway pending state
或 `AgentLoop.ts`。

#### 14.41.6 仍然禁止的伪模块化

1. 不复制 DSH 的 package 名、Cordis 或全局容器来替代 PilotDeck 的 scoped owner。
2. 不把 sidecar/transport 提升为 Session、Gateway、Router、permission、child inbox 或 descriptor 的 owner。
3. 不在仅有 `createLocalGateway()` 这一个完整 application composition 时预建 profile registry 或第二份 dependency bag。
4. 不为没有产品 caller 的 terminal/job/workflow/goal/attachment/backend 增加注册表或远程协议。
5. 不为上述 parity 或 extension 工作修改 `src/agent/loop/AgentLoop.ts`；若需要 core API，必须先单独评审 API 与 native 语义。

每个工作包开始前仍按 human-operation SOP 写明 Definition、Provider、Consumer、Composition、scope、failure mapping 和
teardown；结束时运行受影响的 contract、Node 22 TypeScript/build 和相应 deterministic parity。环境 `BLOCKED` 与 semantic
`FAIL` 必须分开报告。

### 14.42 DSH/PilotDeck 再核对结论与后续 Roadmap（2026-09-10）

本节重新直接核对 DSH `core/scope`、`core/session`、`session-persistence` 与 `app-boot`，以及 PilotDeck 的
`AgentRuntimeScope`、`SessionRuntime`、`ProjectRuntimeRegistry`、`GatewayDialogBundle` 和
`InProcessGateway` 调用链。判断标准不是 Port 或目录数量，而是一个能力是否同时具备：不可替代的 Definition、native
Provider、真实 Consumer、唯一 Composition/状态 owner，以及可验证的失败与 teardown 路径。

DSH 的 `ScopeKey` 同时约束注册可见性、祖先事件路由和 effect disposal；PilotDeck 已以
`ScopedServiceRegistry`、`AgentRuntimeScope`、generation lease 和 session-local live event 覆盖这些 native 主路径。
DSH 的 session coordinator 以单一 append 序列和独立 backend/projection 管理持久化；PilotDeck 的
`SessionRuntime` 已以 serialized `commitTail`、durable writer 和 projection reader 形成对应的本地闭环。
DSH 的 profile boot 则是多个真实 deployment profile 的有序 patch stack 与整树 disposal；PilotDeck 当前仍只有
`createLocalGateway()` 这一完整 application composition，因此不能把“尚未有 profile matrix”误判为要先建一个 registry。

| 能力族 | 当前结论 | 下一步判断 |
| --- | --- | --- |
| Agent scope、Session durable truth、Model/Context/Tool/Permission、native subagent | M3 native 主路径已闭环；state/lease/teardown owner 可定位 | 保持 contract，除非出现新的实际 provider 或跨部署 consumer；不以 DSH 包名再拆目录。 |
| Project generation、memory maintenance、session factory、local Gateway bundles | R5.47-R5.49 已把 project lifecycle 从 root composition 中提取；R5.51 Router event observation 与 R5.52 browser-use session spec preparation 也已从 registry owner 分出 | `createLocalGateway` 只负责装配；继续避免第二份 runtime table、Session/Gateway 状态或 giant dependency bag。 |
| Gateway input / live projection | `GatewayAttachmentTurnComposer` 负责输入；`GatewayAgentEventProjector` 与 `GatewayAgentEventTelemetryObserver` 分别负责 host frame 与 telemetry projection | **M2 native**。Gateway 仍独占 upload lease、pending turn、replay、Session/Router 语义；projection provider 不建立 state registry。 |
| Local boot/profile | bundle 与 shutdown owner 已有；尚没有第二个完整 deployment | 做 R5-B.0 inventory/boot-failure contract，不预建 profile registry。 |
| MCP/LSP 等非 Agent-scoped extension、remote/queued deployment | 仅有局部 provider 或 adapter，没有统一的真实 consumer lifecycle | 由首个产品 caller 触发；分别复用 generation lease/stage/publish/retire/drain。 |
| Agent terminal、durable job/workflow、跨平台 sandbox、attachment retention/query、第二 storage backend | 尚无完整 run owner 与重启/迟到结果合同 | 需求触发后逐项定义，不以 DSH 对称性预建。 |

#### 14.42.1 R5.50：GatewayAttachmentTurnComposer（已完成 native M2）

| 角色 | 责任 | 明确不拥有 |
| --- | --- | --- |
| Definition | `GatewayAttachmentTurnComposerPort.prepare(...) -> { agentInput, allowedReadFiles }`；输入为用户消息、已接受的 `ChannelAttachment`、project root 和 ASR install hint | upload metadata/retention、Gateway pending turn、Session event、transport state、AgentLoop。 |
| Native Provider | `GatewayAttachmentTurnComposer`：按已注册文件生成 exact read allow-list，调用 `AttachmentResolver`，保持 text/image/PDF projection、diagnostic blocks、path note 与 FunASR guidance 的现有语义 | acquire/release upload artifact lease；不得读取未注册路径或持有 durable attachment catalog。 |
| Consumers | `InProcessGateway.submitTurn()` 与 `steerTurn()` 只消费 prepared result；前者仍先解析 browser upload ref，后者只处理其请求携带的附件 | attachment provider selection、model request dispatch、session/router ownership。 |
| Composition | `GatewayDialogBundle` 组合 `AttachmentResolver` 与 composer；为直接构造 `InProcessGateway` 的既有调用方保留明确 fallback/option 兼容 | 新的 global attachment registry、第二份 UploadStore、profile selection。 |

实现与验收：

1. `GatewayAttachmentTurnComposerPort.prepare()` 已返回 `agentInput` 和 `allowedReadFiles`；原有 helpers 已迁入 native provider。
   `resolveUploadedAttachments()` 及其 turn `finally` 的 exact lease release 仍由 Gateway 持有。
2. submit 与 steer 都只消费统一 composer result；输入 block 顺序、path-note marker、resolver diagnostics 和 audio/FunASR
   文案保持既有行为。direct `InProcessGateway({ attachmentResolver })` 仍会构造 compatibility fallback。
3. focused contract 覆盖 registered path/realpath allow-list、resolver provider 注入、text/Office/audio projection、submit/steer
   consumer、dialog composition 和 upload lease terminal release；Node 22 `tsc --noEmit`、build 与 11 个相关 contract 均通过。
4. `src/agent/loop/AgentLoop.ts` 未修改；本切片没有引入 attachment registry、第二份 UploadStore 或持久 Session state。

#### 14.42.2 依赖顺序

| 顺序 | 工作包 | 开始条件 | 退出门 |
| ---: | --- | --- | --- |
| 完成 | **R5.50 GatewayAttachmentTurnComposer** | submit/steer 两个真实 consumer 已收敛 | Definition/Provider/Consumer/Composition 边界和 focused contract 已成立；lease 生命周期仍由 Gateway。 |
| 完成 | **R5.51 ProjectRouterEventBusProvider** | Router event JSONL 与 retry-progress projection 已从 registry generation owner 分出 | legacy migration、best-effort append、live observer error isolation 与 runtime lifecycle contract 都已通过；不把 Gateway turn state 迁入 provider。 |
| 完成 | **R5.52 BrowserUseSessionMcpSpecPreparer** | browser-use per-session stdio spec 已从 registry constructor 分出 | 仅重写 browser-use 的 screenshot cwd/args；其它 MCP spec、runtime start/stop、plugin lease 与 generation ownership 不变。 |
| 完成 | **R5.53 GatewayToolResultArtifactStore** | Gateway `tool_result` projection 已消费 application-selected best-effort artifact provider | `toolResultsDir` 现实际决定 root；返回 path 不代表写入成功；canonical Session transcript 与 tool execution 仍是原 owner。 |
| 完成 | **R5.54 GatewayAgentEventProjector** | `AgentEvent -> GatewayEvent[]` 从 Gateway state owner 提取为 native provider | mapper 兼容导出、artifact delegation、runId、preview、subagent/compaction projection 与 injected Gateway consumer 均有 contract；不迁移 turn/replay/Session/telemetry owner。 |
| 完成 | **R5.55 GatewayAgentEventTelemetryObserver** | Agent event telemetry mapping 从 Gateway submit loop 提取为 native observer | `GatewayTelemetryBundle` 继续拥有 collector lifecycle；native mapping 和 injected Gateway consumer 均有 contract；不写 durable state。 |
| 1 | **R5-B.0 boot/profile audit** | R5.50-R5.55 已完成 | 创建点、config precedence、rollback、shutdown order 都有唯一 owner 与 boot-failure test；仍不建 profile registry。 |
| 2 | **非 Agent-scoped extension lifecycle** | 首个 MCP 或 LSP 的真实 session/deployment consumer 获批准 | candidate stage 失败保留旧 generation，旧 lease drain 后才 dispose，且不会跨 session 泄漏。 |
| 3 | **remote/queued deployment parity** | 某个 remote provider 实际接入 | canonical request/result、cancel/deadline、restart/late terminal 对拍；transport 不取得 Session/Gateway/Router/child owner。 |
| 4 | **产品能力族** | terminal/job/workflow/sandbox/retention/backend 的 caller 与状态真源获批准 | 每项单独具备 run owner、visibility、cancel、timeout、late completion、dispose、restart/unknown-result 与 durable truth 合同。 |

#### 14.42.3 R5.51-R5.55：进一步收敛的 native provider

`R5.51 ProjectRouterEventBusProvider` 保留 Router 的 canonical `RouterEventBus` Definition；RouterRuntime 是唯一 producer，
provider 只按既有路径完成 `router-events.jsonl` migration/append，并把 retry progress 投影给可选 live observer。`
ProjectRuntimeRegistry` 仍拥有 generation publish/retire；Gateway 仍拥有 active-turn state。focused contract 覆盖 legacy log
migration、retry event forwarding、observer failure isolation 和 project runtime lifecycle。

`R5.52 BrowserUseSessionMcpSpecPreparer` 将 browser-use 的 session-local screenshot directory 和 proxy-aware argument
projection 从 `ProjectRuntimeRegistry` 移到专用 provider。Definition 输入是已冻结的 per-session MCP specs、project root、session
identity 与 proxy snapshot；Consumer 是 `ProjectSessionFactory -> SessionMcpRuntimeBundle`。它既不创建 MCP runtime，也不持有
plugin contribution/session resource lease。focused contract 覆盖 browser-use exact rewrite、其它 stdio/HTTP spec identity 保持、
session path sanitization 和 proxy 透传。

`R5.53 GatewayToolResultArtifactStore` 定义了 large `tool_result` 的 host-preview artifact port。`mapAgentEvent()` 是唯一
consumer；`createLocalGateway` 显式选择 native provider 并传入 `InProcessGateway`，direct Gateway 的 `toolResultsDir` 仍作为
compatibility fallback，因此 local application 的配置现在真正控制落盘 root。provider 以 best-effort 异步写入，path 是 advisory，
写入失败不影响 agent turn；它不替代 transcript、tool output storage 或 attachment retention。focused contract 覆盖 selected-root
write、mapper delegation、完整 Gateway streamed result、preview/runId compatibility。

`R5.54 GatewayAgentEventProjector` 把完整的 `AgentEvent -> GatewayEvent[]` switch 留在独立 native provider：Definition 只接收
canonical event 与 runId，Provider 只使用已有 artifact store，Consumer 是 `InProcessGateway`，`createLocalGateway` 显式组合两者。
兼容 `mapAgentEvent()` facade 仍保留给 direct callers；Gateway 继续拥有 active-turn replay、status persistence、turn dispatch 和
telemetry observer 调用。`R5.55 GatewayAgentEventTelemetryObserver` 使用相同的 canonical Agent event 加 immutable telemetry
context 生成 live metrics；它既不拥有 `TelemetryClient`/collector 的 shutdown，也不取得 Session 或 turn state。

R5.50-R5.55 与 project/MCP/attachment 既有契约共 43 个定向 tests 均通过，Node 22 `tsc --noEmit` 和 `pnpm build` 也通过；
`src/agent/loop/AgentLoop.ts` 未修改。

这份队列刻意不把 DSH 的 Cordis、package 目录或 profile 文件格式搬入 PilotDeck。可复用的是 DSH 的 owner discipline：同一
identity 管 visibility、effect 和 teardown；同一 composition 控制 provider 选择与失败回滚；每个 durable state 只有一个 writer。
PilotDeck 的实现应继续以现有真实调用链验证这些性质。

### 14.43 可执行架构基线与 Roadmap（2026-09-10）

本节以 DSH `core/scope`、`core/session`、`boot/app-boot` 的源码行为，以及 PilotDeck
`AgentRuntimeScope`、`ScopedServiceRegistry`、`SessionRuntime`、`ProjectRuntimeRegistry`、
`createLocalGateway` 和 `InProcessGateway` 的当前调用链为准。DSH 的价值在于三条可验证性质：scope identity
同时定义可见性、事件接收范围和 effect teardown；session 只有一个连续 append/seq owner，persistence 与
projection 只是其 consumer；boot/profile 只为已经存在的 deployment 组合排序、回滚和释放。它不要求 PilotDeck
复制 Cordis、DSH package 或一个尚无第二 consumer 的 profile registry。

| 能力族 | DSH 对照性质 | PilotDeck 当前 owner / 证据 | 成熟度与动作 |
| --- | --- | --- | --- |
| Agent scope 与动态 provider | scoped registration、祖先可见事件、effect drain/dispose | `AgentRuntimeScope`、`ScopedServiceRegistry`、`AgentScopeLiveEventBus` 和 generation lease | **M3**；维持现有 contract，不再按 DSH package 再拆。 |
| Session durable truth 与 read model | 单一连续 `seq`、backend/projection 不取得 append owner | `SessionRuntime.commitTail`、persistence binding、`SessionProjectionDriver` | **M3**；新增 durable 能力必须写入同一 session event owner。 |
| AgentLoop 的 model/context/tool/permission/subagent | Definition / native Provider / Consumer / Composition 分离 | `src/agent/modules/*`、session bundles、native subagent provider/continuation composition | **M3** native 主路径；只有跨进程或第二 provider 才扩展 transport projection。 |
| Local application composition | 有序组装、失败 rollback、逆序 teardown | `LocalGatewayBootstrapBundle`、`LocalGatewayLifecycleBundle`、`ProjectRuntimeRegistry` 与 project resource bundles | **M2**；已有一个完整 local deployment，尚不能声称具备 DSH 的多 profile matrix。 |
| Gateway dialog 与 host preview | 输入/输出/telemetry projection 不取得 session、turn 或 retention 真源 | `GatewayAttachmentTurnComposer`、`GatewayAgentEventProjector`、`GatewayAgentEventTelemetryObserver`、`GatewayToolResultArtifactStore`、`ProjectRouterEventBusProvider`、`BrowserUseSessionMcpSpecPreparer` | **M2**；保留 Gateway 对 upload lease、pending turn、replay、Session/Router 的独占 ownership。 |
| Non-Agent-scoped extension lifecycle | staged generation、publish、lease drain、dispose | `ProjectMcpRuntimeProvider` 已拥有 shared generation，`SessionMcpRuntimeRegistry` 按 exact session registration 释放，`SessionMcpRuntimeBundle` 只消费 lease 并交由 session resource bundle 逆序回收 | **M2（MCP）**；后续只在第二个独立 deployment consumer 出现时扩展，禁止重造全局 extension registry。 |
| Remote/queued deployment | canonical request/result、cancel/deadline、restart、late terminal parity | `RemoteGateway` 与 sidecar 已有协议片段，但没有接入的 remote provider | **M1**；等待实际 provider，transport 不可拥有 Session/Gateway/Router state。 |
| Terminal、durable job/workflow、sandbox、retention/query、第二 storage backend | 每项有 run owner、visibility、settlement 与 durable truth | 局部 UI/runtime 实现，不具备统一 restart/unknown-result 合同 | **M0**；完全由产品 caller 触发。 |

后续工作按下面的激活条件执行，而不是按目录或 Port 数量排期：

| 顺序 | 工作包 | Definition / Provider / Consumer / Composition | 开始条件 | 退出门与非目标 |
| ---: | --- | --- | --- | --- |
| 1 | **R5-B.0 boot/profile audit** | Definition 是 local application config/rollback/shutdown contract；Provider 是现有 local bootstrap/lifecycle bundles；Consumer 是 `createLocalGateway` 与 CLI server；Composition 仍是 local root。 | 当前立即可做。 | 明确 config precedence、创建点、rollback 和 shutdown order，并补 boot-failure contract。**不**创建 profile registry 或改写 application root。 |
| 完成 | **R5.54 Gateway agent-event projection** | Definition 是 `AgentEvent -> GatewayEvent[]`；Provider 复用 artifact store；Consumer 是 `InProcessGateway`；Composition 在 local Gateway root。 | complete。 | mapper regression 覆盖 model/tool/result/attachment/compaction/subagent/runId；**不**迁移 active turn、telemetry、transcript 或 tool execution ownership。 |
| 完成 | **R5.55 Gateway agent-event telemetry observation** | Definition 是 canonical event + telemetry context；Provider 只写 existing telemetry client；Consumer 是 `InProcessGateway`；Composition 在 local Gateway root。 | complete。 | 覆盖 native model/tool mapping 与 injected consumer；**不**接管 collector lifecycle 或 Session/Gateway state。 |
| 2 | **Non-Agent extension lifecycle** | Definition 是 scoped generation lease；Provider 负责 candidate stage/publish/retire/drain；Consumer 必须是已批准 MCP、LSP、telemetry 或 command deployment。 | 获得 MCP 之外的第二个独立跨 session/deployment consumer。 | candidate 失败保留旧 generation，lease drain 后恰好 dispose 一次，不能跨 session 泄漏；**不**将 PluginRuntime instance 或 session state 放进 registry。 |
| 3 | **remote/queued deployment parity** | Definition 为 canonical operation/result/cancel/deadline/restart contract；Provider 是实际 remote runtime；Consumer 是现有 module/gateway adapter。 | 某个 remote provider 接入产品路径。 | native/remote 对拍无未解释 terminal、cancel、deadline 或 late-result 差异；**不**让 transport 维护 durable session/turn/router state。 |
| 4 | **产品能力族** | 每个 terminal/job/workflow/sandbox/retention/backend 单独定义 run owner、durable truth 和 settlement。 | 对应产品 caller、可见性和恢复需求均已批准。 | 覆盖 cancel、timeout、late completion、dispose、restart/unknown result；没有 caller 不建立 abstraction。 |

每个启动的工作包都必须按 human-operation SOP 先记录 Definition、Provider、Consumer、Composition、scope、failure mapping
和 teardown，再运行该 seam 的 focused contract、Node 22 TypeScript/build 与适用 deterministic parity。`AgentLoop.ts`、
Session/Gateway/Router 的状态 owner 以及 transport 的无状态边界仍是默认禁止修改范围。

### 14.44 DSH 对照复核后的收敛 Roadmap（2026-09-10）

本节是后续实现的唯一执行入口，用来取代前文按历史切片累积的优先级描述。复核直接比对 DSH
`core/scope` 的 scope identity、`session-persistence` 的 coordinator、`session-projection` 的派生读模型和
`app-boot` 的 profile/patch 生命周期；PilotDeck 则沿以下真实路径核验，而不是按目录或 Port 计数：

```text
createLocalGateway
  -> ProjectRuntimeRegistry / ProjectRuntimeResourcesBundle
  -> ProjectSessionRuntimeBundle / AgentSessionRuntimeBundle
  -> AgentRuntimeScope / ScopedServiceRegistry
  -> SessionRuntime -> SessionPersistence + SessionProjectionDriver
  -> InProcessGateway (turn/replay) -> projector / telemetry observer
```

| 能力族 | DSH 架构性质 | PilotDeck 已核验的 owner 与结论 | 成熟度 |
| --- | --- | --- | --- |
| scope / agent publication | 同一 scope identity 决定可见性、effect owner 和释放；发布失败可回滚 | `ScopedServiceRegistry` 的 lease/replace/drain/dispose、`AgentRuntimeScope` 的 child/effect owner、`AgentScopeLiveEventBus` 的 exact-to-ancestor 路由，以及 `AgentHandle`/factory transaction 已在 native 主路径组合 | M3 native |
| session durable truth | 单一连续 append owner；persistence、projection 只能消费提交流 | `SessionRuntime.commitTail` 串行提交并校验序列；`SessionPersistence` 是 required subscriber；`SessionProjectionDriver` 只派生可重建 snapshot | M3 native |
| agent capability | Definition、native Provider、host Consumer 与 composition 分离；transport 不取得 Router/Session owner | model/context/tool/permission/subagent 的 native/sidecar Port 均通过 session bundles 组合；local Gateway subagent parity 已收敛 | M2-M3 native |
| context cache plan | request assembly 的缓存 generation 是 session-local volatile state；它不能成为 durable session event，也不能由 transport 重建 | `PromptCacheCoordinator` 只持有 fingerprint/generation/reset marker；`DefaultContextRuntime` 只消费 `createPlan/reset/release`，`AgentRuntimeScope` 在明确接收 ownership 的 session Context dispose 时回收状态 | M2 native（session-owned Context seam） |
| local boot / profile | provider 选择、启动失败 rollback、逆序 teardown 由实际 deployment composition 负责 | `LocalGatewayBootConfig` 固定 option/env/default precedence；`LocalGatewayBootResources` 将 bootstrap inventory 转交 lifecycle；`PilotDeckRuntimeProfile` 与 `ProjectRuntimeRegistry` 保持各自 provider/generation owner | M2 local |
| Gateway projection 与 interaction | host frame、preview、pending question/approval、telemetry 和 manual-compaction command projection 均为 live coordination，不是 turn 或 session durable truth；prepared rewrite 的 volatile reservation 不能取得 durable transcript owner | attachment composer、artifact store、agent-event projector/observer、turn event/replay coordinator、telemetry resolver、replacement coordinator、interaction coordinator、completion fence 与 manual-compaction coordinator 均通过 `InProcessGateway` 组合；Gateway 保留 admission、事件语义、Router/Session 调度与 abort host call，子 coordinator 分别拥有 replay sink、interaction pending/grant cleanup、replacement transaction、abort-to-drain fence 和 `/compact` deadline/projection | M2 native |
| non-Agent extension / remote deployment | generation stage/publish/lease-drain/dispose；remote provider 必须有取消、重启和迟到终态合同 | Plugin/MCP/LSP 和 remote/queued path 尚无第二个获批准的完整 consumer/deployment | M1，需求触发 |
| terminal / durable job-workflow / cross-platform sandbox / retention-query / second backend | 每项均需 run owner、可见性、cancel、settlement、restart/unknown-result 与 durable truth | 当前只有局部 UI 或 native helper；没有完整产品合同 | M0，需求触发 |

`GatewayTurnReplayStore` 已成为一个有效的 native seam：它有 `submitTurn` 的写 consumer 和
`getActiveTurnSnapshot` 的读 consumer，且只拥有 bounded frame buffer、terminal TTL 与 defensive snapshot；Gateway
仍决定 admission、retain 时机和 process disposal。此前私有 `activeTurnReplays` 的测试窥探已替换为 provider contract，
因此这不是把字段移到另一文件，而是明确了 volatile replay 的 owner/consumer 边界。

#### 14.44.1 本轮完成的 native 收敛

| 工作包 | Definition / Provider / Consumer / Composition | 结果 |
| --- | --- | --- | --- |
| **R5-B.0 local boot/profile config + lifecycle** | Definition：`LocalGatewayBootConfig` 的 option/env/default selection 和 `LocalGatewayBootResources` 的 resource inventory/ownership transfer。Provider：native local bundle。Consumer：`createLocalGateway`。Composition：现有 local root。 | 已完成。启动期 telemetry、subagent、project/MCP runtime、watcher、refresh、router 逐项登记；失败走 watcher-first/reverse-resource rollback，成功转交既有 lifecycle bundle。未改变同步 `createLocalGateway()` API。 |
| **R5.56 GatewayTurnReplayStore** | Definition：bounded volatile replay Port。Provider：in-memory store。Consumers：`submitTurn`/`emitForSession` 写入与 `getActiveTurnSnapshot` 读取。Composition：local Gateway root 显式选择 native provider。 | 已完成。保持 event/byte cap、runId 补全、terminal retention、defensive snapshot 与 Gateway dispose；不拥有 Session history、Router 或 turn admission。 |
| **R5.57 GatewayTurnTelemetryContextResolver** | Definition：channel + optional metadata 到 immutable telemetry attribution。Provider：native resolver。Consumer：`InProcessGateway.submitTurn`。Composition：local Gateway root。 | 已完成。显式 metadata、Always-On phase 和 default fallback 行为保持；resolver 不写 telemetry、不拥有 collector、turn 或 Session state。 |
| **R5.58 GatewayTurnReplacementCoordinator** | Definition：prepared last-turn replacement 的 volatile transcript reservation、submit claim、accepted-input commit 与 timeout rollback。Provider：native coordinator。Consumer：`InProcessGateway` 的 replace/finalize RPC、`submitTurn` 与 session-model mutation。Composition：Gateway 将既有 history storage callbacks 与 Router/abort callbacks 注入 coordinator。 | 已完成。durable rewrite/finalize 仍由 `GatewaySessionHistoryBundle` 负责；Router abort/close 与 Gateway run-drain fence 仍在 host。保留 replace 配置缺失、缺 finalizer、stale active turn、commit-before-`input_accepted`、timeout rollback 和 model-write lock 语义；不创建第二份 Session/Router/transcript state。 |
| **R5.59 GatewayInteractionCoordinator** | Definition：Gateway reconnect binding、pending elicitation/permission、session permission grant cleanup 的 live interaction Port。Provider：native coordinator。Consumers：Gateway RPC/submit/close、session interaction bridge。Composition：Gateway 注入现有 grant provider 与 elicitation-delivered hook。 | 已完成。question 与 approval 的 pending/replay、stale binding、turn timeout/ended、session close 和 process dispose 由同一 owner 清理；permission rule 的 durable/Agent owner 未迁移，Router 仍先完成 close。 |
| **R5.60 GatewayTurnCompletionFence** | Definition：一个 admitted Gateway turn 从 abort 到 submit-finally 的 exact drain promise。Provider：native in-memory fence。Consumers：`submitTurn` 和 `abortTurn`。Composition：Gateway local root。 | 已完成。保留 stop 后 await `Router.endTurn` 再返回的语义，old handle 不会删除 newer handle；fence 不拥有 Router admission、abort、Session 或 terminal result。 |
| **R5.61 GatewayTurnEventCoordinator** | Definition：active-turn stream sink 与 bounded replay retention。Provider：native coordinator，底层复用 `GatewayTurnReplayStore`。Consumers：`submitTurn`、`emitForSession`、active snapshot。Composition：Gateway local root。 | 已完成。runId 补全、frame replay、terminal TTL、defensive snapshot 与 provider injection 保持；Gateway 继续产生事件、决定 admission/terminal 和 Session/Router 生命周期。 |
| **R5.62 PromptCacheCoordinator** | Definition：session-local prompt-cache fingerprint、generation、reset 与 release Port。Provider：native in-memory coordinator。Consumer：`DefaultContextRuntime.prepareForModel()` 与 compaction 结果处理。Composition：`SessionContextRuntimeBundle` 显式选择或注入 provider，`ProjectSessionRuntimeBundle` 将 Context ownership 交给 `AgentRuntimeScope`，durable Context wrapper 只透传 dispose。 | 已完成。保持同 fingerprint generation 稳定、fingerprint 变化递增、compaction reset、disabled materialization 消费 pending reset 与 session dispose/recreate 清空状态的既有行为；直接注入且未声明 ownership 的 provider 不会被释放。它不写 Session event、不拥有 prompt/context/compaction 策略，也不把 cache plan 变成 transport state。 |
| **R5.63 GatewayManualCompactionCoordinator** | Definition：validated `/compact` command 到 Gateway event stream 的短生命周期 Port。Provider：native coordinator。Consumer：`InProcessGateway.submitTurn`。Composition：local Gateway root 显式选择 native provider。 | 已完成。仅拥有 command deadline 和 result/error projection；Router 仍拥有 idle maintenance reservation，Session/ManualCompactionController 仍拥有 durable bracket/replacement。保留 invalid command 不创建 session、busy error、timeout abort、`runId` 和唯一 terminal；不让 `/compact` 进入 normal turn 或新建 Session。 |
| **R5.64 Host Prepared Model Invocation Identity** | Definition：host-model consumer 的每次 `prepare()` 产生只限本 execute 的 `preparationId`。Provider：`createHostModelInvokerPort()` 的 private symbol metadata + weak identity index。Consumer：`AgentLoop` 经过 token-cap normalisation 后的 `stream()`，以及 NDJSON sidecar host module。Composition：`createSidecarPorts()`/default sidecar factory。 | 已完成。`AgentLoop` 的 object-spread prepared copy 会保留同一个 ID，使 host 在 `prepare` 返回已路由 provider/model 后，仍能在 `stream` 查回首次 Router preparation。metadata 不是 JSON 字段，不进入 durable Session state，也不跨 operation 保存；default factory 与真实 `AgentLoopSidecarServer` contract 均覆盖该路径。 |

验证覆盖 option/env/default config precedence、resource inventory 的 rollback/commit transfer、实际 watchers-started
boot failure、Gateway replay provider injection/截断/terminal replacement、telemetry attribution provider injection，以及 replacement
coordinator 的配置语义、host/storage 委托、submit claim、accepted-input commit、timeout rollback 和 transcript write lock，以及
interaction reconnect/pending/grant cleanup、abort-to-drain fence 与 live event/replay ownership，以及 prompt-cache
generation/reset、injected Context consumer 与 session-scope release。Node 22 `tsc --noEmit`、`pnpm build`、R5.63 compaction/Gateway focused tests 32/32、
R5.62 Context/session focused tests 42/42 均通过；UI bridge 源码回归为 45/45。由于当前只有一个完整 deployment consumer，DSH 的多
profile/patch matrix 仍不能直接照搬，也不应预建 profile registry。

#### 14.44.2 后续按触发条件排期

| 顺序 | 工作包 | 开始条件 | 必须证明 | 明确非目标 |
| ---: | --- | --- | --- | --- |
| 1 | Context cache second consumer / host parity | host/remote context provider 需要复用 cache generation 或 session-local cache contract | provider selection、prepare/retry/compaction/reset/release 的 native-host parity；不存在跨 session generation 泄漏 | 将 cache plan 写入 Session event、把 `DefaultContextRuntime` 的 prompt/compaction 策略迁入 coordinator，或仅为抽象再造 registry。 |
| 2 | Non-Agent-scoped extension lifecycle | MCP 之外的第二个 LSP、telemetry 或 command deployment consumer 获批准 | candidate stage 失败保留旧 generation；exact lease drain 后恰好 dispose 一次；session 间不泄漏 | 预建全局 extension registry，或让 PluginRuntime 失去实例 owner。 |
| 3 | remote/queued deployment parity | 真实 remote provider 进入产品路径 | canonical request/result、cancel/deadline、restart、late terminal 的 native/remote 对拍 | transport 持有 Session、Gateway、Router、child inbox 或 durable queue。 |
| 4 | 产品能力 seam | terminal、durable job/workflow、跨平台 sandbox、attachment retention/query、第二 storage backend 具有真实 caller | 各能力独立具备 run owner、visibility、timeout/cancel、settlement、dispose、restart/unknown-result 和 durable truth | 为 DSH 包名对称而建立 job/workflow/attachment registry。 |

所有后续切片都遵守：先写 Definition、Provider、Consumer、Composition、scope、failure mapping 和 teardown；只运行受影响
contract、Node 22 TypeScript/build 与适用 parity；默认不改 `src/agent/loop/AgentLoop.ts`，不迁移 Session/Gateway/Router
状态 owner，也不让 sidecar 成为业务状态真源。

### 14.45 源码核对后的当前执行 Roadmap（2026-09-10）

本节取代 14.44.2 作为新的排期入口。结论来自 DSH `core/scope`、`core/session`、`session-persistence`、
`session-projection` 和 `app-boot` 的发布契约，以及 PilotDeck 的实际组合链：

```text
createLocalGateway
  -> ProjectRuntimeRegistry -> ProjectSessionRuntimeBundle
  -> AgentRuntimeScope -> AgentSessionRuntimeBundle
  -> SessionRuntime -> persistence / projection
  -> InProcessGateway -> live projection / telemetry
```

DSH 要求的是同一 identity 管 visibility、effect 和 teardown，同一 append owner 管 durable truth，
同一 composition 管 provider selection 和 rollback；它不要求把 PilotDeck 改成 Cordis，也不要求每个目录
都有 registry。按该标准，当前模块状态如下：

| 能力族 | 已闭环部分 | 尚未闭环的事实 | 成熟度 |
| --- | --- | --- | --- |
| Scope / agent publication | `ScopedServiceRegistry` 的 generation lease、drain/dispose；`AgentRuntimeScope` child/effect owner；`AgentHandle` create/resume/recreate transaction；`AgentSessionScopeBundle` 的 native service/provider selection | 尚无覆盖所有跨域 contribution 的统一 scope layer；现有 prompt/tool/hook owner 不应被伪装成一个 registry | M3 native |
| Session durable truth | `SessionRuntime` 单一串行 append、required persistence subscriber、projection driver 和 checkpoint/replay | 只保留 legacy fallback；新的 durable capability 必须进入同一 event owner | M3 native |
| Model / tool / context / permission / subagent | Definition、native provider、host consumer 和 session composition 已存在；host prepared-model identity 已验证 | `AgentLoop` 仍直接接收宽 `AgentRuntimeDependencies`，且 native subagent fallback 仍在 loop 内；因此 core loop 不是完整 DSH seam | M2 capability，M1-M2 core loop |
| MCP extension lifecycle | `ProjectMcpRuntimeProvider` 的 shared generation、`SessionMcpRuntimeRegistry` 的 exact registration、`SessionMcpRuntimeBundle` 的 resource-lease composition | 只有 MCP 是完整 deployment consumer；没有理由预建 generic extension lifecycle registry | M2 MCP |
| Local boot / profile | boot config precedence、bootstrap rollback、local lifecycle reverse teardown、project runtime stage/publish/retire | 只有 local deployment；尚无第二个 deployment 证明需要 DSH profile/patch matrix | M2 local |
| Gateway live coordination | replay、interaction、replacement、completion fence、manual compaction、event/telemetry projection 都有窄 owner | 这些仍是 live state，不能提升为 Session durable truth | M2 native |

**R5.65 AgentSessionScopeBundle（已完成 native M2）**：将 `AgentSessionRuntimeBundle` 中的 native
permission、interaction policy/reconnect、tool runtime/scheduler 与 named subagent provider/registry 选择提取为
独立 scope composition。Session persistence、durable recorder 和 AgentLoop construction 仍在原 owner。native fallback
`InteractionReconnectPort` 现在由同一 session scope 精确释放；外部注入的 reconnect/provider 只有显式 transfer
ownership 时才会被释放。定向 contract 覆盖 pending reconnect cleanup、injected ownership、provider exact dispose，
以及既有 session factory/subagent generation lifecycle。

#### 14.45.1 现在可执行的唯一核心设计包

| 工作包 | Definition / Provider / Consumer / Composition | 验收与边界 |
| --- | --- | --- |
| **C1 AgentLoop turn capability view（设计门）** | Definition：仅含一个 turn 需要的 model、tool、context、interaction、subagent delegation、event/output hooks 的窄不可变 view。Provider：session/agent runtime bundle 从现有 `AgentRuntimeDependencies` 适配。Consumer：`AgentLoop`。Composition：`AgentSessionRuntimeBundle` 与 sidecar factory。 | 先产出字段到 owner 的映射和 native/sidecar parity matrix；实现前必须逐项证明 Router、Session、Gateway、child inbox 和 durable state 不会迁入 loop 或 sidecar。保留 native subagent provider fallback 的兼容策略，不能用删 fallback 假装解耦。 |

C1 是当前唯一可在没有新产品需求时推进的核心工作，但本分支默认仍不修改 `AgentLoop.ts`。它必须先通过
设计评审，再以一次独立、可回滚的实现切片进入代码。

#### 14.45.2 需求触发工作包

| 顺序 | 工作包 | 开始条件 | 必须证明 | 非目标 |
| ---: | --- | --- | --- | --- |
| 1 | Host context-cache parity | 真实 host/remote context provider 需要 session-local cache generation | prepare/retry/compaction/reset/release 与 native 等价，且 generation 不跨 session | 将 cache plan 写进 Session event，或把 prompt/compaction policy 塞入 coordinator |
| 2 | Extension deployment consumer | MCP 之外出现 LSP、telemetry 或 command 的独立 deployment consumer | stage 失败保留旧 generation，lease drain 后 exact dispose，session 不泄漏 | generic global registry 或迁移 PluginRuntime owner |
| 3 | Remote / queued provider | remote provider 真正进入产品路径 | canonical request/result、cancel/deadline、restart 和 late terminal 的 native parity | transport 持有 Session、Gateway、Router、child inbox 或 durable queue |
| 4 | Terminal / job / workflow / sandbox / retention / storage | 有明确 caller、可见性与恢复需求 | 每项有 run owner、cancel/timeout、settlement、dispose、restart/unknown-result 和 durable truth | 按 DSH 包名对称预建 abstraction |

每个实现包都必须先固定 DSH 四角色、scope、failure mapping 和 teardown；再只运行其 focused contract、Node 22
TypeScript/build 与适用 parity。任何包都不得把 Session、Router 或 Gateway 的真源复制到 sidecar、bundle 或 coordinator。

### 14.46 架构核对后的交付路线（2026-09-10）

本节是对 14.45 的执行性压缩，不以新增 Port、目录或 package 数量计量完成度。核对直接覆盖 DSH
`core/scope`、`core/agent`、`core/agent-loop`、`core/session`、`session-projection`、`subagent` 与
`app-boot`，以及 PilotDeck 的实际 native 和 sidecar 调用链。DSH 可复用的是 ownership discipline：scope
identity 同时决定可见性、effect owner 与 teardown；Session 只有一个 append owner；provider 的选择只在
composition 发生。PilotDeck 不应复制 Cordis 或为尚不存在的第二 consumer 预建 registry。

| 能力族 | 已核对的 PilotDeck 事实 | DSH 成熟度 | 当前动作 |
| --- | --- | --- | --- |
| Scope 与 agent publication | `ScopedServiceRegistry`、`AgentRuntimeScope`、`AgentFactoryProvider` 已有 generation lease、child-first dispose、unpublished setup、publish rollback 与 handle drain。 | M3 native | 保持现有 owner；新 contribution 只能以 exact scope effect 加入。 |
| Session durable truth | `SessionRuntime` 串行 `commitTail`，required persistence subscriber 与 `SessionProjectionDriver` 只消费 committed event；checkpoint/replay 可重建。 | M3 native | 新的 durable capability 必须写入此事件真源，不能写入 Gateway 或 sidecar 私有表。 |
| Model、tool、context、permission | `ModelInvokerPort`、`ToolPort`、Context/Permission provider 和 durable wrapper 已有 native/host consumer 与 session composition。 | M2 | 不新增泛化 registry；先由 C1 让 loop 消费窄 capability view。 |
| Core AgentLoop | 构造器仍接收 `AgentRuntimeDependencies`，并直接读取 context、router、token policy、event/lifecycle、plan/file 与 interaction 依赖；`buildSubagentForkApi()` 仍动态构造 `SubAgentSession`。 | M1-M2 | 唯一可主动推进的核心项，必须先过 C1 设计门。 |
| Subagent | continuable provider/registry/manager、child inbox、cold resume 与 parent-first settlement 在 native Gateway 已闭环；one-shot definition 已存在，但尚未成为 loop 的唯一 delegation consumer。 | M3 continuable / M1 one-shot | C1 后用 composition-bound delegation port 取代 loop 内 `new SubAgentSession`，保持 native fallback 行为。 |
| MCP extension lifecycle | `ProjectMcpRuntimeProvider` generation lease、`SessionMcpRuntimeRegistry` exact registration 与 `SessionMcpRuntimeBundle` 已有真实部署 consumer。 | M2 MCP | 仅当 LSP/其它 extension 出现独立 deployment consumer 时复用该 lifecycle；不建立 generic extension registry。 |
| Local boot 与 Gateway live coordination | local boot rollback/reverse teardown、project stage/publish/retire，以及 replay、interaction、replacement、completion fence、projection/telemetry 已有各自 live owner。 | M2 local/native | 维持 Gateway/Router/Session ownership；第二 deployment 出现前不建 profile matrix。 |
| Terminal、durable job/workflow、跨平台 sandbox、attachment retention/query、第二 persistence backend | 只有局部 helper 或 UI 生命周期，没有统一的 run owner、重启与迟到终态合同。 | M0 | 严格需求触发，不为 DSH 包名对称预实现。 |

#### Phase 0：固定边界与验收基线

在任何 core 改动前，冻结以下非目标：Session、Gateway、Router 和 child inbox 仍是各自 durable/admission
state 的唯一 owner；sidecar/transport 只投影 capability，不能持有这些状态。以 scope generation/lease、Session
append/replay、Agent publication rollback、Gateway turn drain、native/sidecar model-tool contract 为回归基线。该阶段
不修改 `AgentLoop.ts`。

#### Phase 1：C1 AgentLoop turn capability view 设计门

先交付设计而不是代码。Definition 是一次 turn 可见的不可变 capability view；Provider 由
`AgentSessionRuntimeBundle` 从现有 scope 和 runtime dependency 适配；Consumer 只有 `AgentLoop`；Composition
分别落在 native session bundle 与 sidecar default factory。设计评审必须产出：

1. `AgentRuntimeDependencies` 每个被 loop 使用字段到 capability、scope owner、durable/live/volatile 状态域的映射；
2. model/tool/context/interaction/delegation/event-output 五组 capability 的最小接口，明确哪些仍由 `AgentLoopInput`
   传入而不是变成 provider；
3. native 与 sidecar 的 prepare/stream、tool execution、permission/elicitation、abort/deadline、subagent fallback
   的 parity matrix；
4. failure mapping 与 teardown 表，证明 view/provider dispose 不会关闭 Router、Gateway、Session、child inbox 或
   persistence；
5. compatibility 方案：native one-shot fallback 仍由 composition 绑定为 delegation provider，不能以删除 fallback
   作为“模块化”。

只有上述产物通过评审，才允许修改 `src/agent/loop/AgentLoop.ts`。

#### Phase 2：一次可回滚的 core-loop 实现切片

将 C1 的 view 以 compatibility adapter 先接入 native bundle 和 sidecar factory，再让 `AgentLoop` 只依赖该
view。把 one-shot subagent 的创建移动到 composition-bound delegation port；loop 只发起 delegation request，不能
import 或 `new SubAgentSession`。不得把宽 dependency bag 原样改名后继续传入，不得迁移 Router 选路、Session event
recording、Gateway pending state 或 child admission。验收为：现有 native 行为不变、direct-loop contract、session
factory contract、sidecar contract，以及 prepared-model identity 和 one-shot/continuable subagent parity 全部通过。

#### Phase 3：由真实第二 consumer 触发的 deployment parity

只有实际进入产品的 host/remote/queued provider 才启动本阶段。每一项独立验证 canonical request/result、capability
negotiation、cancel/deadline、restart、late terminal、generation replacement 与 exact resource release。remote transport
始终不拥有 Session、Gateway、Router、child inbox 或 durable queue；MCP 以外的 extension 只有在具备独立 deployment
consumer 时才复用 stage/publish/lease-drain/dispose 模式。

#### Phase 4：产品能力按单项立项

Terminal、job/workflow、跨平台 sandbox、attachment retention/query 和第二 storage backend 必须各自先确认产品
caller、可见性和 durable truth；随后单独定义 run owner、cancel/timeout、settlement、dispose、restart/unknown-result
和 recovery contract。它们不阻塞 C1/C2，也不能以“对齐 DSH package”作为立项理由。

执行顺序因此固定为：**Phase 0 baseline -> C1 design review -> Phase 2 compatibility implementation -> Phase 3/4
按真实 consumer 触发**。每个切片都要在开始前给出 Definition、Provider、Consumer、Composition、scope、failure
mapping 和 teardown；完成时仅运行受影响的 focused contract、Node 22 build 与适用 parity，并把环境受限与语义失败分开报告。

### 14.47 R5.66：AgentLoop Turn Capability / One-shot Delegation（已完成 native M2，2026-09-10）

本节替代 14.45.1 与 14.46 中仍将 C1 和 Phase 2 写为待做的状态。实现不是把
`AgentRuntimeDependencies` 改名后继续传给 loop，而是完成了一个受限的 Definition、native Provider、唯一
core Consumer 和两个 composition consumer：

| DSH 架构性质 | PilotDeck 实现证据 | 当前结论 |
| --- | --- | --- |
| loop 只消费其运行所需的能力，不拥有 application scope、Session 或 boot composition | `src/agent/loop/AgentTurnCapabilities.ts` 定义 `model`、`tools`、`context`、`hooks`、`events`、`clock` 六组只读 capability；不包含 `scope`、Gateway、Session、Router owner、child inbox 或 persistence | `AgentLoop` 已达到 native/direct M2 seam；capability view 不是 service locator，也不具有 dispose 责任 |
| Provider 在 composition 选择，且 direct compatibility 不改变 owner | `createAgentTurnCapabilities()` 将现有 `AgentRuntimeDependencies` 适配为 capability view；`AgentSessionRuntimeBundle`、`SubagentRuntimeComposition` 和 sidecar default factory 显式创建该 view | 宽依赖对象暂时只作为 factory/composition 与 direct API 的兼容输入，不能再重新成为 loop 的运行时依赖 |
| subagent 的 Definition、Provider、tool Consumer 和 child-state owner 分离 | `src/agent/sub/OneShotSubagentPort.ts` 定义 `createForkApi()`；native provider 负责 `SubAgentSession` 创建、sidechain、timeout/abort、lifecycle 和事件；`AgentLoop` 仅从 capability view 取得 fork API | one-shot native delegation 从 M1 提升为 M2；Session、Gateway、Router、continuable child inbox 仍保持各自唯一 owner |
| 发布前 scoped composition 与 child runtime 保持同一边界 | `AgentSessionRuntimeBundle` 为 parent runtime 创建 native one-shot port；`SubagentRuntimeComposition` 为每个 child runtime 创建精确 port；`SubAgentSession` 消费 child capability view | nested native path 没有回退到 loop 内动态 import/new，也没有另建 durable queue |

实现后的核心不变量如下：

1. `AgentLoop` 构造器只接受 branded `AgentTurnCapabilities`；direct API 的宽依赖兼容只可通过
   `AgentLoop.fromDependencies()` 显式进入。loop 内不存在 `this.dependencies` 读取。
2. `AgentLoop` 不再 import 或 `new SubAgentSession`。one-shot 的 child 创建、sidechain transcript、超时/取消
   分类、hook 和 volatile event 都在 native provider 中；超时事件明确保持 `aborted: false`。
3. capability view 只携带调用 capability，不携带 service ownership。durable model/tool 事实仍经
   `AgentSessionRuntimeBundle` 的 recorder wrapper 写入 Session event owner；view 中的 event hook 只处理
   live loop event。
4. sidecar default factory 可构造同一 capability view，但没有因此获得 Session、Gateway、Router、child inbox
   或 persistence 的所有权。

本切片使用 Node 22 复核：`pnpm build` 通过；以下定向 contract 共 **68/68** 通过：

```text
agent/modules/default-factory
agent/modules/ports-adapter
agent/modules/sidecar
agent/session/agent-session-runtime-bundle
agent/session/agent-loop-factory
agent/sub/OneShotSubagentPort
agent/sub/SubAgentSession
agent/turn-environment
```

`SubAgentSession` 的 timeout/abort 回归必须在正常 Node test 生命周期下运行；`--test-force-exit` 会截断该文件
后半段测试，不能作为本切片的验收命令。

#### 14.47.1 更新后的模块成熟度

| 能力族 | 现在已经模块化的边界 | 仍然不是完整模块化的事实 | 后续动作 |
| --- | --- | --- | --- |
| Core AgentLoop | `AgentTurnCapabilities` Definition、native/direct provider、`AgentLoop` consumer、session/child/sidecar composition | direct 构造器仍允许宽依赖兼容输入；view 中 model routing 与 token policy 仍是一个 native provider 的同组能力 | 先完成 C2 的 compatibility-exit 审计；无第二 routing provider 时不为拆类型而拆类型 |
| One-shot subagent | `OneShotSubagentPort` Definition、native provider、tool runtime consumer、parent/child exact composition | remote/queued provider、sidecar delegation、parent abort 与 late terminal 的部署级对拍尚未存在 | 仅在真实第二部署 consumer 出现后，建立 host-owned provider contract 与 parity gate |
| Continuable subagent | provider registry、descriptor、Agent-owned FIFO inbox、manager、cold resume、nested Gateway consumer | provider registry lifecycle 尚未被 remote/queued deployment 验证 | 保持现有 owner；需求触发时补 provider replacement、restart 和 late-terminal contract |
| Scope / contribution | service scope、publication transaction、prompt/tool/hook 的具体 owner | 没有且不应伪造一个覆盖所有 contribution 的 generic registry | 只有同一 contribution 必须跨两个独立 provider 生命周期时，才以 exact scope effect 补齐 |
| Profile / boot | local bundle、stage/publish/retire、rollback/reverse teardown | 尚无第二 deployment 验证 DSH profile/patch matrix 的必要性 | 不主动搬迁 `createLocalGateway.ts`；第二 deployment 出现时再收敛 ordered bundle API |
| Execution world、terminal/job/workflow、storage/query、cross-platform sandbox | 已有针对实际产品路径的 port 或 native bundle | 尚未形成完整 run owner、restart/unknown-result 和 deployment parity 的能力不能标成通用模块 | 每个产品需求单独立项，先定义 durable truth 与 cancel/timeout/settlement/dispose |

#### 14.47.2 后续路线

**C2：compatibility-exit audit（下一个可主动推进的 core 工作包）**

目标不是删除 `AgentRuntimeDependencies`，而是验证它不再是 loop contract。先盘点所有直接 `new AgentLoop` 与
`__agentLoopFactory` consumer；生产 composition 必须传 `AgentTurnCapabilities`，direct 输入只能保留在明确标记的
compatibility adapter 和测试 helper。验收包括：

1. `AgentLoop` 与 `OneShotSubagentPort` 不重新引入 scope、Session、Gateway、Router owner、child inbox 或
   persistence 字段；
2. capability provider replacement/dispose 不关闭任何借入 service；
3. native、direct、child 和 sidecar 的 prepared request、tool execution、permission/elicitation、timeout/abort
   分类保持现有 canonical trace；
4. 所有外部 direct consumer 完成迁移或获得明确的弃用窗口后，才考虑移除构造器 compatibility overload。

**C3：model/routing policy definition（有第二 provider 时启动）**

当前 `model` group 有意保留 `stream`、request materialization、sticky invalidation 和 token limits 的协同关系。
只有 host/remote provider 或另一种 routing policy 需要独立替换时，才把它们拆成独立 Definition；届时必须固定
prepared-request/retry snapshot、route invalidation、token accounting 与 health 生命周期，不能让 Session 或 Gateway
成为 model policy owner。

**C4：one-shot deployment parity（有真实 host/remote consumer 时启动）**

sidecar/remote provider 必须由 host composition 提供 `OneShotSubagentPort` 等价能力，而不是让 transport 创建 child
Session。验收覆盖 request/result、deadline/cancel、parent abort、timeout、late terminal、sidechain reference 和
exact resource release；结果与 native provider 的 canonical trace 对拍。没有该产品路径前，不扩展 Module Protocol
或预建 remote registry。

**C5：其余能力按需求触发**

通用 contribution lifecycle、profile/bundle/boot patch、terminal/job/workflow、跨平台 sandbox、attachment retention/query
和第二 persistence backend 均不阻塞 C2。每项开始前必须先给出 Definition、Provider、Consumer、Composition、scope、
durable/live state owner、failure mapping 和 teardown，并只运行受影响的 focused contract、Node 22 build 和适用 parity。

更新后的顺序为：**已完成 Phase 0 -> 已完成 C1/Phase 2 -> C2 compatibility-exit audit -> C3/C4/C5 按真实第二
consumer 或产品需求触发**。这保留 DSH 的 ownership discipline，同时避免把 PilotDeck 重构成无实际 owner 的 package 对称结构。

### 14.48 R5.67：Capability-only AgentLoop Runtime Factory（已完成 native M2，2026-09-10）

R5.66 后仍有一个容易重新扩大依赖面的入口：Session factory 可以注入外部 runner。现已新增
`AgentLoopRuntimeFactory` Definition，正式 `CreateAgentSessionOptions.agentLoopFactory` 只接收：

```text
AgentRuntimeConfig + AgentTurnCapabilities + AgentLoopSeedState
```

它不接收 `AgentRuntimeDependencies`。`createAgentSession` 优先使用该 factory，默认 native loop 继续消费同一
capability view。此前的 `__agentLoopFactory` 保留为内部测试 bypass，专门用于验证 Gateway/Session composition
外围的 synthetic runner；它不是 sidecar、remote 或 production provider contract，不能据此把 raw scheduler、scope 或
durable writer 暴露回正式 external-loop seam。

这个区分是必要的：durable `ToolPort` 必须在已打开的 model step 内写 `tool_call`/`tool_result`。一个跳过
AgentLoop admission 的测试 double 若直接执行工具，会被 Session domain validation 拒绝；不能为让 double 通过而
退回暴露未封装 scheduler。真实 external runner 必须实现同样的 prepared model/step/tool transaction，C4 才能把它
接入 host/sidecar parity。

R5.67 覆盖的代码路径为：

- `src/agent/loop/AgentLoopRuntimeFactory.ts`：Definition；
- `src/agent/session/createAgentSession.ts`：capability-only external provider consumer；
- `src/agent/index.ts`：稳定 Definition export；
- direct session factory contract、native continuation host、Gateway continuation、permission/interaction、file-history
  composition regression。

Node 22 build 已通过；上述 focused suites **27/27** 通过。C2 的剩余事项不是继续改名，而是在有真实 remote/sidecar
provider 时实现 prepared-request、step admission、tool durability、abort/deadline 和 terminal replay 的完整 C4 contract。

### 14.49 C2 Constructor Compatibility Exit（已完成 native/direct M2，2026-09-10）

R5.67 后继续完成 compatibility exit，而不是让宽依赖对象继续作为另一个构造器 overload 存在：

- `new AgentLoop(config, capabilities, seedState)` 现在只接受 branded `AgentTurnCapabilities`，非 capability 输入立即
  拒绝；
- `AgentLoop.fromDependencies(config, dependencies, seedState)` 是唯一明确命名的 direct compatibility adapter；
- `createAgentSession`、`SubAgentSession`、sidecar default factory 和所有 production `new AgentLoop` 路径均传入
  capability view；
- 23 个 direct compatibility test caller 已迁移到静态 adapter；保留 capability 的 one-shot contract test 则继续直接
  构造 loop。

这使 `AgentRuntimeDependencies` 保持在 native composition/provider 层，而不再是 `AgentLoop` 的构造器 contract。
它仍是合法的 session、scope、continuation provider composition 输入，不能被错误地标记为应当全局删除的对象。

Node 22 build 通过；context/token/compaction、model override、steer、interruption recovery、port、session factory 和
one-shot delegation focused suites **44/44** 通过。至此 C2 完成；下一主动 core 重构必须等待真实第二 model/routing
provider，或以 C4 的完整 sidecar external-runner 事务为独立交付，而不是再扩张 capability bag。

### 14.50 R5.68：Gateway External Loop Factory Propagation（已完成 application composition，2026-09-10）

R5.67 的 Definition 若只停留在 direct session，Gateway 仍会把外部 loop 的部署边界截断。本切片将正式
`agentLoopFactory` 从 `createLocalGateway()` 依次传入 `ProjectRuntimeRegistry`、`ProjectSessionFactory`、
`ProjectSessionRuntimeBundle`，并在 continuable parent binding、child materialize 与 cold resume 中保持同一条
capability-only 路径。`__testAgentLoopFactory` 则以独立的 `testAgentLoopFactory` 字段原样保留，只能映射到
`CreateAgentSessionOptions.__agentLoopFactory`。

| 入口 | 正式 consumer | factory 获得的输入 | 容许的 legacy 路径 |
| --- | --- | --- | --- |
| Gateway parent / reload | `ProjectSessionFactory` create、resume/recreate | `AgentRuntimeConfig + AgentTurnCapabilities + AgentLoopSeedState` | `__testAgentLoopFactory` 仅用于 synthetic composition test |
| continuable child | `NativeSubagentContinuationHost` create、resume | 与 parent 相同的正式 factory；child 自己的 capability view | child test runner 仍可单独经内部 bypass 注入 |
| Gateway child tool consumer | `GatewaySubagentRuntimeBundle` / `SessionSubagentContinuationBundle` | 只转发 factory reference，不持有 capability 或 Session | 不把 full dependency bag 重新包装为 public contract |

这里的完成范围是 **application composition propagation**，不是 remote/sidecar deployment parity：真实外部
runner 若要调用 durable `ToolPort`，仍必须遵守 model-step admission、tool event durability、abort/deadline、terminal
replay 和 late-terminal settlement。当前 Gateway contract 只验证 capability-only input 能完成无工具 turn；native
continuation contract 验证 materialized 与 cold-resumed child 都使用正式 factory。C4 仍必须以完整事务合同单独交付。

Node 22 build 已通过；Gateway interaction/factory、native continuation host、Gateway live/cold continuation 和
session factory focused suites **18/18** 通过。测试配置的 title generator 指向不可达的本地 model endpoint，会记录
provider retry 后跳过标题生成；这不参与 external runner 的 turn 完成或本切片的验收语义。

### 14.51 R5.69：Module-Protocol Sidecar Runtime Client（已完成 transport/host M2，2026-09-10）

R5.68 之后，正式 `agentLoopFactory` 已能进入 Gateway 与 continuable child，但仍缺少一个真实可用的 host-side
sidecar client：应用若要把 AgentLoop 放到外部进程，只能自己处理 execute/module_call/final，容易重新绕回 raw
dependencies。本切片新增 capability-only 的 Module Protocol client provider：

- `createAgentLoopSidecarRuntimeFactory()` 是正式 `AgentLoopRuntimeFactory` provider，只接收
  `AgentRuntimeConfig + AgentTurnCapabilities + AgentLoopSeedState`；
- `AgentLoopSidecarConnection` 由应用提供进程、stdio、socket 或 RPC 生命周期，client 只负责 Module Protocol；
- sidecar 发出的 `model`、`capability`、`context`、`permission` module_call 全部回调本地 capability ports，durable
  model/tool/context/permission event 仍由 Session-owned wrappers 写入；
- sidecar server 的 terminal payload 附带可选 `seedState` projection，client 在下一 turn 的 `snapshotFileState()` 中恢复，
  但老测试 double 未实现 `snapshotFileState()` 时不会把成功终态改写为失败；
- `result_unknown` 不会被当成成功，而是回到宿主侧 error path，等待真正的 operation reconciliation。

这使 PilotDeck 具备了 DSH-style Definition / Provider / Consumer / Composition 闭环：Definition 是
Module Protocol connection + capability-only runtime factory；Provider 是应用拥有的连接与本地 capability view；Consumer
是 `createAgentSession`/Gateway 的正式 `agentLoopFactory`；Composition 不移动 Session、Router、Gateway 或 child inbox
owner。仍未完成的是 production process supervisor、resume/ack cursor replay、side-effect reconciliation 与 remote/queued
provider parity；这些属于 C4/C5 后续 deployment contract。

Node 22 build 已通过；sidecar client loopback、sidecar server、Module Protocol focused suites **23/23** 通过。新增
loopback contract 覆盖：真实 `AgentLoopSidecarServer(createSidecarExecution)`、host module_call 回调本地 durable ports、
tool turn 完成、terminal seed projection 恢复，以及 unknown terminal fail-closed。
