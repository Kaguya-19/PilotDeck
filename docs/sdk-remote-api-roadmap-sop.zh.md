# SDK Remote/Application API 开发 Roadmap、SOP 与 Goal

日期：2026-09-22。依据本任务对指定版本的代码检查；本文不是已实现能力声明。

**最新授权：完成全部 S0–S9 SDK 与必要服务端能力 → L1–L3 兰台后端迁移 → A1 最终验收。原先只执行 S0–S3 的阶段限制已撤销。**

## 1. Goal

在 `codex/minimal-lantay-capaction` 的现有工作基础上，扩展 `@pilotdeck/sdk` 的 Remote/Application API，使兰台后端能通过正式 SDK 使用附件、可信上下文、调用方 runId、权限资源及运行管理能力。

完成全部 SDK 应用接口及其必要 Gateway/Runtime 支撑后，继续实施兰台后端迁移，最后完成端到端验收与迁移交付。优先复用试验分支；按能力分阶段实现并验证，但阶段完成后自动进入下一阶段，不以首轮完成作为任务结束。SDK 暴露配置与资源接口；执行前安全屏障、精确生命周期和运行状态权威仍在服务端。

完成标准：

1. 公开接口具有实际可验证的服务端语义，不能仅添加字段或空实现。
2. 已有 SDK API 保持兼容，SDK/Gateway 使用当前统一协议。
3. SDK sessionStore、内存 handle、远程 callback 不冒充持久化运行状态或执行屏障。
4. 保留所有已有未提交修改。
5. Core 不增加 Lantay/Faxin 业务硬编码，使用配置、metadata 或通用 policy。
6. 缺少服务端能力时先登记依赖，再在本任务中实现所需通用模块和 Port，不能仅以 `blocked_dependency` 结束。仅真实外部环境或凭证缺失才作为未完成阻塞项，并继续其他独立工作。
7. 兰台业务运行通过正式 SDK 接入；HTTP/SSE、staging/OCR、业务锁、caller-owned 幂等（若业务服务提供）、last_result、trajectory、交付和数据源逻辑保留在兰台。
8. 验收矩阵、测试证据、迁移/回滚说明齐全，无必需能力被静默略过。真实环境未验证不得声称全部验收完成。

## 2. 仓库、版本与范围

- **唯一开发 worktree**：`/Users/a1/Desktop/claw/openbmb/PilotDeck-minimal-lantay-capaction`
- 预期分支：`codex/minimal-lantay-capaction`。
- 检查时提交基线：`e2b4bdc7`，另有现存未提交修改；启动开发时重新确认状态，不要求回退到该提交。
- 兰台参考与后续开发仓库：`/Users/a1/Documents/ChatGPT/Lantay/lantay_pilotdeck_API`。
- 参考引用：`origin/dev-0825-tmp`，检查时为 `bc67c032`，父提交 `5c0fa4df`。
- 参考仓库 checkout 不是指定引用。使用 `git show origin/dev-0825-tmp:<path>` 或从引用导出的副本，不能把 checkout 当作参考版本。
- 已有参考副本：`/tmp/lantay-backend-bc67c032-analysis`，临时目录可能被清理。
- 本文保存在主仓库，仅作为交接文档；**文档位置不是开发 worktree**。

不分析或修改 pilotdeck-service-adapter、UI、StaffDeck。不 reset、clean、stash、清理或覆盖已有修改，不擅自 commit/push。不以 `any` 绕过新增类型设计。不维护 Gateway 1.0 长期兼容分叉。

允许修改 SDK、必要 Gateway/Runtime 通用模块、类型/路由/窄接线、相关测试和文档。RunRegistry、Runtime 策略模块及 workspace admission/finalization 均已授权实现，仍应拆为独立阶段，不混入简单封装。兰台开发时从指定 bc67c032 基线创建隔离 worktree/开发分支，不覆盖当前 checkout。允许本地实现和必要测试；不擅自 push、部署或操作生产数据。

## 3. 已检查的能力基线

- 试验分支已有 FailureGuard、workspace 异常快照、LLMCenter premature stream-close recovery。用户提供 build 和 focused compiled tests 103/103 通过；本次分析没有重新执行这些测试。
- SDK `runs` 资源目前只公开 `start`；handle 有 events/result/abort，但没有跨客户端持久化运行管理。
- `runs.start` 内部生成 runId；当前启动行为依赖消费，不能把 handle 创建当作持久化接受。
- Gateway 已有 runId、attachments、uploadedAttachments、syntheticMessages 基础字段。
- `GatewayTurnReplayStore` 是内存缓存，默认 500 事件、256 KiB、终态保留 30 秒。
- `portable_text_messages` 只保留 user/assistant 文本，不是完整原生归档。
- SDK 有会话级 `skills` 可见性，不等价于旧兰台逐轮单技能强制注入、多技能选择范围。
- 检查时 SDK/Gateway 协议均为 1.2，旧兰台 base 为 1.0；实现时以配套当前版本为准。
- 试验 FailureGuard 默认标签仍有业务名；上游化时改为配置提供。
- 试验异常快照收尾前调用 `router.endTurn`；跨轮次 workspace 隔离需要专项验证及服务端修正，不能认为 103/103 已证明这一点。

## 4. Roadmap

| 阶段 | 目标 | 边界 | 完成门槛 |
|---|---|---|---|
| S0 | 固定现状和能力映射 | 相关 SDK 类型、提交链路、Gateway 实现和 tests | 输出接口→服务端落点→缺口清单 |
| S1 | 调用方 runId | 扩展 start 输入并透传 | ID 一致、默认兼容、校验明确；不宣称幂等 |
| S2 | attachments | 先提交既有引用，再独立做上传 | 引用真实消费，文本不回归，lease 仍由 Gateway 所有 |
| S3 | trusted context | 独立可信上下文字段和窄接线 | 来源、用途、身份与逐轮作用域明确 |
| S4 | 既有管理能力 | skill CRUD/import/validate/scan，之后 Always-on | 有真实服务端响应及错误契约 |
| S5 | Runtime 策略控制面 | 优先 FailureGuard，再 snapshot/recovery | 参数由服务端实际应用，客户端不能放宽宿主强制策略 |
| S6 | permission 资源 | list/watch/respond，独立于 Query callback | 审批前不执行；超时、重复和过期响应语义完整 |
| S7 | 完整 archive | manifest、原生 transcript、事件和资源 | 分页、完整性、子代理、大结果和访问投影明确 |
| S8 | 持久化 runs | get/observe/result/reattach | RunRegistry 先完成；断线/重启恢复不重复执行 |
| S9 | memory/snapshot/manager | 对接实际管理 Port | 无 Provider 明确 unavailable，不操作 SDK 本机文件冒充远程能力 |

当前授权覆盖 **S0–S9、L1–L3、A1 全流程**。S0–S3 已有第一轮实现，先修复下文已知问题再继续。后续阶段先固定契约再实现，依赖可调整先后，但 SDK/服务端基础完成并通过检查后才开展兰台业务迁移。S8 不得用内存回放或 sessionStore 代替 RunRegistry。

## 5. S1：调用方 runId

在现有 `PilotDeckRunInput` 增加可选 `runId`，保留其他字段及 options 类型。

实施要求：

- 显式 ID 校验后沿现有 createQueryWithTransport 链路提交。
- 缺省继续生成 UUID。
- handle.id 与请求中的 runId 一致。
- 本阶段不改变 start 的启动时机。
- 同 runId 去重、冲突检测和持久化接受留给 S8，文档不得承诺幂等。

测试：显式 ID、缺省 ID、非法 ID、handle/request 一致，以及现有调用兼容。

## 6. S2：附件

先支持提交既有附件引用，再独立实现上传。SDK 使用稳定的公开类型与显式 mapper，不直接耦合内部模块类型。

检查并复用：

- GatewaySubmitTurnInput。
- GatewayAttachmentTurnComposerPort。
- UploadedAttachmentResolverPort。
- UploadLifecyclePort 与上传 artifact lease。

在现有文本提交链路中保留 attachments/uploadedAttachments 信息；不通过 prompt 拼接路径模拟附件。

路径语义：Remote SDK 本地路径不是 Gateway 路径。优先上传得到资源引用；若支持服务端路径，需要明确作用域和授权，不得偷偷读取 SDK 本机文件。

测试：纯文本兼容、附件引用传递、非法引用、文本与附件共存、真实 Gateway 消费、服务端错误透传。涉及 lease 的改动验证释放与失败清理。

## 7. S3：可信上下文

建议独立字段（最终名称按现有 SDK 风格确定）：

```ts
type PilotDeckTrustedContextMessage = {
  text: string;
  source: string;
  purpose: "material_context" | "skill_context" | "application_context";
  scope: "turn";
};
```

映射 Gateway syntheticMessages 通路，不拼到用户 prompt。来源和用途必须进入服务端记录；协议不足时做窄扩展。可信身份由 Gateway 确认，客户端自称 trusted 不足以授权。若只有受信任宿主 token，记录适用边界，不自行扩建无关身份系统。

不开放任意提升到 system role 的能力。本轮字段不成为下一轮自动重注入的配置；历史 transcript 的保留遵循现有语义。

SDK 不增加兰台专用 enabled_skills API、不读取兰台技能目录。skills 表示可见性；强制载入使用通用 skill_context。不可把旧提示白名单说成已实现执行级授权。

测试：文本输入不被污染、source/purpose 服务端记录、作用域不意外复用、身份限制、非法输入及正常错误传播。

## 8. 后续阶段的服务端门槛

### S5：策略配置

定义策略在何时解析、固定和应用。宿主强制规则不能被调用方降低。FailureGuard 复用试验实现；阈值、标签、工具分组用通用配置。snapshot/recovery 没有实际消费者的字段不导出。

### S6：权限资源

确认 canPrompt 路径如何支持外部响应者，不能仍要求 canUseTool callback 才能等待。服务端拥有 pending request、执行暂停、超时和响应去重。respond 关联 runId/requestId/revision；watch 重连后能重新 list 校准。SDK callback 仅提交决定，不作为强制屏障。

### S7：完整归档

与 portable_text_messages 分开命名。定义 manifest、原生 entries、事件游标、子代理记录、tool result 资源引用与分块读取。完整性和保留期显式表达；不把受限审计或技能资产无条件暴露给普通业务身份。

### S8：持久化运行管理

Gateway-owned RunRegistry 是前置条件。推荐 RunRef 包含 projectKey/sessionId/runId；RunRecord 包含 state、revision、lastSeq、ownerEpoch、workspaceReusable 和结果/归档引用。

必须明确：

- accepted 是持久化接受回执，提交不依赖 observer 消费。
- 同作用域同 ID 同请求返回原运行，不同请求 conflict。
- 事件每 run 单调 seq，持久化后发布；历史转实时无空窗，客户端可去重。
- observe/reattach 只恢复观察，不重交用户输入。
- 取消观察不等于 abort；disconnectPolicy 显式定义。
- Gateway 重启后终态可读；失去执行者的活动 run 标记 interrupted。
- 首期不承诺恢复工具执行栈，不自动重放有副作用工具。
- finalizing 后才提交最终结果；未静止 workspace 不可复用。
- SDK sessionStore 只是镜像，不参与权威判定。
- 过期 cursor 返回明确缺口/过期错误，不伪装完整回放。

第一版可使用单 Gateway SQLite 事务存储与持久卷，通过 RunRegistryPort 隔离。多实例另需共享存储、owner lease 和 fencing，不自动宣称横向扩展。

### S9：管理资源

memory wipe 必须由服务端处理真实存储和缓存；不误删业务 workspace。snapshot list/get/restore 不等于 rewindFiles，默认恢复到新 workspace。manager sessions/browser 使用独立管理授权和通用 Provider。未装配能力明确 unavailable。

## 9. Runtime 扩展边界

所有 Runtime 改动采用“独立模块 + 通用 Port + 窄生命周期接线”。SDK 可以传配置和查询，但以下保证必须本地执行：

| 模块 | 服务端保证 |
|---|---|
| InvocationAudit | provider 发送前等待持久化；真实请求/响应、各 attempt 关联 |
| FailureGuard | 本地计数、禁止新调度、abort、停止原因持久化 |
| WorkspaceSnapshot | 执行前 pre；异常 drain 后 post；workspace 排他 |
| ExecutionPolicy | 工具执行前判断、进程环境隔离、受保护资源访问 |
| EventProjectionPolicy | wire、资源读取与 archive 投影一致 |
| ToolResultRetentionPolicy | 原始结果保留、稳定引用、有界预览、compaction 配对 |
| MCP confirmation | metadata 解析并强制执行前 ask |
| RunFinalization | 停止→drain→snapshot→archive→终态→释放执行权 |

工具结果完整保留指源结果可取回，不是无限放进上下文。数据源本体优先 MCP；Core 不按 Faxin 名称分支。

## 10. 每阶段 SOP

1. 记录分支、HEAD、git status，先确认 worktree。已有修改逐项保留。
2. 只检查本阶段链路：SDK 类型→客户端→transport→Gateway 类型/路由→实现→tests。
3. 写短契约：输入输出、默认值、错误、状态所有者、重连、兼容和非目标。
4. 做最小纵向实现，优先 mapper/Port，不复制执行链路。
5. 按 package scripts 运行最小相关检查。除参数映射外验证服务端实际消费；纯包装可复用现有服务端证据。
6. 文档标记 implemented/partial/blocked_dependency；示例可类型检查。
7. 审查 diff：无覆盖旧修改、业务硬编码、无消费者字段、无范围扩大。
8. 报告后自动进入下一阶段。遇服务端设计依赖先实现依赖；遇真实外部阻塞明确记录并继续独立工作，不把可实现的依赖当作停止理由。

不要为分析重新运行无关全量测试，不计算或要求文件校验和。实际修改涉及的失败、重试和生命周期测试必须有意义，不能镜像实现。

报告模板：

```text
阶段：
已完成接口：
服务端实际落点：
新增/变化的语义：
兼容性：
验证命令与结果：
依赖或未覆盖能力：
本阶段修改文件：
```

## 11. 必须阻止的假完成

- 只有内存 GatewayTurnReplayStore，却宣称持久化 observe。
- 只有 sessionStore，却宣称权威 runs.get。
- 只有 portable_text_messages，却宣称完整 archive。
- 只有 Query callback，却宣称独立 permission 管理。
- 只有 rewindFiles，却宣称 workspace snapshot restore。
- 仅增加 SDK option，没有服务端消费者。
- 仅透传 runId，却宣称幂等。
- 仅成功构建，却宣称断线、重启或安全保证成立。

## 12. 当前完整执行指令与 Goal

用户已明确授权将本任务扩展至全部 SDK 能力、兰台后端开发和最终验收。请在目标任务使用 create_goal 创建如下 Goal；若已有未完成 Goal，不虚报完成以替换它，按最新用户指令持续执行，并将新目标写入任务内进度文档。

```text
基于 codex/minimal-lantay-capaction 的全部现有修改，完成路线图 S0–S9 的
Remote/Application SDK 接口及必要 Gateway/Runtime 通用能力；随后基于
lantay_pilotdeck_API 的 origin/dev-0825-tmp@bc67c032 实施兰台后端 SDK 迁移；
最后完成后端能力矩阵逐项验收、端到端故障与恢复验证、迁移/回滚交付。

持续执行到目标实际达成，不以阶段报告、仅类型透传或 blocked_dependency
清单作为最终完成。按模块实现和验证，不请求重复授权。真实外部环境或凭证
缺失明确记录，不伪造验证，继续独立工作。
```

先修复首轮核查项：

- trustedContext/attachments 位于 PilotDeckOptions，client defaults 会每轮合并。明确限制逐轮输入，禁止意外继承；补两轮回归测试，保持文档与行为一致。
- identity: gateway 只是服务端元数据盖章。明确可信宿主授权边界并验证，不能把形状检查当作身份认证。
- 验证主/子代理原生 transcript 中 provenance 的保留、上传引用的真实消费及错误处理。

S0–S9 必须覆盖：附件提交和上传管理、调用方 runId/持久化接受与幂等、trusted context、会话/技能/项目/文件/模型/配置管理、Cron/Always-on、Runtime 策略控制、permission list/watch/respond、完整原生 transcript/event archive、Gateway-owned 持久化 RunRegistry 与 runs.get/observe/result/reattach/abort、memory 管理、snapshot 查询恢复、manager session/browser 控制。

必要 Runtime 能力一并补齐：provider 原始审计及发送前屏障、FailureGuard 上游化、pre_user/异常 post_agent 与 workspace 隔离、断流恢复、secret/skill policy、长结果/compaction、MCP confirmation、WS close/abort/finalization。全部使用独立模块、通用 Port、窄接线，不引入业务硬编码。

## 13. 兰台实施阶段

| 阶段 | 工作 | 完成门槛 |
|---|---|---|
| L1 | 从 bc67c032 创建隔离兰台 worktree；固定旧 HTTP/SSE 与四种 session/材料场景契约；新增正式 SDK Node 客户端进程 | 接口和业务 request/attempt/runtime runId 映射明确，保护现有 checkout |
| L2 | 替换临时 Node WS 脚本及 Python 直连 WS 路径，统一通过 SDK；保留 Python OCR/Office/PDF/staging、lineage、鉴权、per-session 业务锁、caller-owned 幂等（若有）、last_result、trajectory、deliverable gate、artifact、错误映射 | 断连先查/reattach 原运行，不重交；运行归档与业务交付分工清晰 |
| L3 | 法务数据源收敛 MCP；配置去业务硬编码；部署打包转为正式 SDK/Runtime 组合；旧会话迁移与回滚脚本/文档 | 不再依赖兰台专用 Core fork；新旧会话固定归属；无生产发布要求 |

可根据部署现状选择最小 Node 进程通信方式，不引入新业务服务体系。Faxin 等数据源连接、凭证和引用结构由 MCP/兰台所有，SDK 与 Core 不写业务逻辑。

## 14. A1 最终验收

输出可追溯能力矩阵，每项包含接口、服务端落点、兰台调用点、测试证据和状态。本次收尾的验收范围是本地/确定性实现、迁移桥接边界、文档和通用分支前置审计；该范围达到 implemented + verified 后即可结束本地目标。生产级 A1 扩展不纳入本次执行，不得将未执行项目写成通过。

当前矩阵见 `docs/pilotdeck-sdk-acceptance-matrix.md`；矩阵分别标记本地确定性证据、临时真实 provider smoke，以及明确未执行的生产级项目。它给出本地验收结论，不构成生产部署或跨主机 A1 通过声明。

必须覆盖：

- 同 ID 去重/冲突、接受 ACK 丢失、断网重连、双 observer、事件分页转实时无缺口。
- Node/Gateway 退出重启、失主 run 明确 interrupted、终态可重复读、不重放副作用工具。
- permission 审批前零执行，拒绝/超时/过期/重复回复；close/abort 不误杀后续运行。
- pre 失败时模型/工具零调用、异常 post 等待退出、跨轮 workspace 隔离和恢复。
- provider stage 失败零发送、流式/非流式/重试/子代理审计关联与收尾失败可见。
- FailureGuard 归因、阈值、仅触发一次、停止新调度；断流恢复无重复工具执行。
- secret/skill 边界，保留 bc67c032 stderr 重定向和 5c0fa4df 原地读取修正。
- 长结果源可取回，多次 micro/full compaction 后引用/citation/调用配对完整。
- 兰台四种材料场景、OCR 失败回退、转换、lineage、业务锁/幂等、交付 gate、输入污染过滤、JSON/SSE/last_result 语义、trajectory 可重建。
- memory/snapshot/manager/skill/Always-on 真实管理能力及授权/错误。
- 配套 SDK/Gateway 协议、无长期 1.0 分叉、无业务名 Core 分支。

使用项目支持的运行环境；检查时 node 25 曾产生 engine 警告，最终在项目支持的 Node 22 版本完成本地验证。临时真实 provider smoke 仅作为边界证据；本次不等待生产部署、跨主机运行或外部 OCR 服务。缺少这些环境时明确列为未执行项，不伪造通过，不以 mock 代替真实验收声明。

### 14.1 本次收尾结论（2026-09-23）

- 本地/确定性验收完成：SDK、Gateway/Runtime、RunRegistry、权限、归档、审计、迁移 runner/API、转换与幂等测试均以支持的 Node 22/Python 环境完成；协议面审计确认 SDK 与 Gateway dispatcher 的 100 个 request method 一一对应。
- 迁移桥接边界完成：兰台运行路径统一使用正式 SDK bridge；Python 继续拥有 staging/OCR/conversion、SSE、业务锁、lineage、delivery gate、trajectory、last_result 和 caller-owned 幂等；未恢复 protocol 1.0 直连，也未引入业务名 Core 分支或业务硬编码。
- 文档与可复用通用分支前置审计完成：SDK 打包输入、远程绑定/认证边界、项目身份、回滚选择、共享 `LANTAY_IDEMPOTENCY_DB` 约束均已记录。
- 明确未执行且不计入通过：生产部署与发布、跨主机/TLS/入口代理、外部 OCR/conversion 服务、生产级 provider retry/stream/finalization fault matrix、生产重启/跨主机恢复、四种材料的生产级 live delivery、生产共享幂等库演练、live manager-browser host provider 验证。

因此，本次 Goal 以“本地验收完成、生产级项目明确未执行”收尾；后续若要宣称生产级 A1，需要另行授权并补齐上述证据。

## 15. 监控交接

目标任务：扩展 SDK Remote API。hostId：local。threadId：01a0c918-0ac3-7ec1-b84b-b4ffaa178272。

S0–S3 首轮已完成，实际命令使用正确 SDK worktree，报告 SDK 130/130、Gateway 6/6。该记录为历史进度；当前本地收尾已完成。

监控交接已结束。本次不等待生产部署、跨主机运行或外部 OCR 服务；不得据此自动派发生产级验证。不得代批审批、push/部署或更改模型。

### 2026-09-22 持续执行进度

- Goal 已扩展为 S0–S9 SDK/Gateway/Runtime、兰台 SDK 迁移和最终 A1 验收；当前仍 active，不能以 S0–S3 报告结束。
- 已修复首轮逐轮字段问题：`attachments`、`uploadedAttachments`、`trustedContext` 从 `PilotDeckOptions` 移到 `runs.start()` 的 `PilotDeckRunInput`，client defaults 不再跨 run 继承；SDK 回归测试覆盖连续两轮。
- `trustedContext` 现在要求 Gateway host 注入 `trustedContextAuthorizer`；Gateway 记录 authorizer 返回的 `source` 与 `authorizedPrincipal`。字段形状校验不再被视为认证；未配置 authorizer 时返回 `CAPABILITY_UNAVAILABLE`。
- SDK 已补齐既有 Gateway skill CRUD/import/validate/scan 与 Always-on apply/abort/rerunPlan 资源包装，并有真实 RPC 传输测试。
- S6 第一轮：`permissions.list/watch/respond` 已以 Gateway-owned pending permission bus 接线；list 返回权威 live pending 集合，respond 只交付一次，turn 结束仍由 Gateway 拒绝未决审批。WebSocket 在请求/完成时发布观察通知，重连调用方必须先 list 校准。
- S8 第一轮：FileRunRegistry 已记录持久化 accepted 回执、请求冲突、单调事件序号与终态；Gateway 在 submitTurn 返回前等待已排队的 registry 写入，避免终态 read-after-return 竞争。重启中断标记与多 observer/游标缺口语义仍需加强。
- S9：SDK 已有 `memory`、`snapshots`、`manager` 资源与 Gateway RPC 入口；默认 InProcess Gateway 在没有真实 Provider 时明确返回 `CAPABILITY_UNAVAILABLE`。已有 content-addressed workspace snapshot store 现已提供 Gateway snapshot list/get/restore，restore 默认创建新的 Gateway 临时 workspace，并通过路径约束防止 manifest 越界；EdgeClaw memory 的项目/按 `sourceSessionKey` session wipe 与 manager sessions 已装配，manager browsers 仍 unavailable。
- S7 第一轮：新增独立于 `portable_text_messages` 的 native archive manifest/entries RPC。它从 Gateway 的持久化 transcript 读取原生 entry，提供 entry sequence 分页、subagent 数量和 tool-result entry 计数；现已增加受限的 `archives.artifact()` base64 读取（单一安全文件名、10MB 上限），但 retention/authorization 投影仍待完成。
- L1/L2 第一轮（历史记录）：已从 `bc67c032` 建立隔离兰台 worktree，并在 `runners/pilotdeck/sdk_bridge.mjs` 使用正式 `@pilotdeck/sdk`。同步和 SSE runner 默认进入该 bridge，使用 `runs.start`、断连 `reattach`/`observe`，不再运行 protocol 1.0 的 WS 路径；Python staging、OCR、锁、SSE、delivery gate 和 trajectory 层未被改写。当时真实 Gateway、SDK 包安装和 trusted-context authorizer 尚待环境验证；后续已补充临时真实 provider smoke。
- S9 snapshot provider：复用现有 content-addressed workspace snapshot store，Gateway `snapshot_list/get/restore` 已接入；restore 在目标项目下创建新临时 workspace，不覆盖源 workspace。新增 [Lantay migration/rollback] 文档，明确回滚通过 worktree/artifact 选择完成，不保留隐式旧协议开关。
- 验证：SDK 130/130、Gateway/storage focused 14/14、SDK/根目录 TypeScript 检查通过；兰台 `run.py` 已通过 Python 语法检查，bridge 无 Gateway 的失败路径输出结构化终态。S5、S7 artifact retention/authorization projection、S9 manager browsers、RunRegistry 完整恢复语义、兰台真实环境迁移及 A1 故障恢复验收仍未完成。
- 持续执行：已将 EdgeClaw 项目 memory provider 的真实 `list`/`clear` 管理端口接入 Gateway；配置 provider 时公布 `memory_list`/`memory_wipe` 并委托项目存储，未配置时仍返回 `CAPABILITY_UNAVAILABLE`。session wipe 现在删除该 `sourceSessionKey` 的待索引 L0 与归属 memory entry，不清理项目其他 session；新增核心隔离测试。Gateway provider 委托测试与 TypeScript 检查通过。
- S8 持续执行：RunRegistry 新增 Gateway 级同 ID 重试证据，重复 accepted run 只回放持久事件且不会再次执行；不同 request material 返回 conflict。Registry append/终态持久化失败现在向观察者发出 `result_unknown`，并在队列关闭前等待持久化写入；双 observer、分页到终态及 cursor gap 也有 focused 证据，RunRegistry 测试 5/5 通过。
- S8 持续执行：FileRunRegistry 现在在首次操作前完成启动恢复，将重启遗留的 accepted/running run 先标记为 `interrupted`；accept/append/恢复操作通过单写者队列串行化，避免并发同 ID 请求双重接受；新增并发 accept 回归证据，RunRegistry focused 测试 6/6 通过。
- S8 持续执行：提交已接受但被 Gateway preflight 拒绝的 run（session/workspace busy、SDK config/model/budget admission、dialog cleanup 等）现在写入终端 registry event，不再留下不可重试的 `accepted` 残留；新增 admission rejection 证据。
- S7 持续执行：native transcript manifest/entries/artifact 增加 Gateway-owned archive authorizer 边界；本地 Gateway 可配置 filesystem artifact retention window，超期 artifact 返回 `ARCHIVE_ARTIFACT_EXPIRED`，并有 provider short-circuit 与本地存储测试。外部 artifact store 的 retention 仍由其自身 metadata/policy provider 负责。
- S5/S8 持续执行：Gateway 增加按 resolved workspace identity 的跨 session admission，活动 turn 结束并完成 post-agent snapshot/finalization 前不会释放 workspace；新增跨 session contention focused 证据。
- S9 持续执行：manager sessions 现在复用 Gateway-owned session catalog，通过 `createLocalGateway` 提供真实 `manager_sessions` 结果并公布 capability；browser manager 已补齐 provider-neutral host port，配置 provider 时由 Gateway 转发并公布 `manager_browsers`，未配置时继续显式 `CAPABILITY_UNAVAILABLE`，不伪造本机浏览器状态。新增 Gateway provider delegation/capability 测试。
- L2 持续执行：兰台 SDK bridge 断线后使用 Gateway `runs.result` 获取终态，并按事件 durable sequence 去重；SDK 模块加载/缺失依赖也统一输出结构化 `__done__` 错误，不再让 Node 在 envelope 之前崩溃。
- L2 持续执行：兰台 Python streaming runner 已把原先不可达的空运行/断流重试契约接回正式 SDK bridge；中间失败不会发出终态 `__done__`，会发出 `run_retry`，空运行/忙会轮换 session，完整终态只发一次。新增回归测试覆盖断流后重试。
- L2 持续执行：SDK bridge 的同步与异步 Node 子进程都具备有界 timeout；超时会终止 bridge 并产生可分类的 `turn_timeout` 终态，不会永久占用 SSE/业务锁。
- L2 持续执行：已从兰台 `run.py` 删除不可达的临时 Node WS、Python 直连 WS 和独立 abort 控制路径；运行时代码只保留 SDK bridge，Gateway URL 仍由 SDK 负责连接。
- L2 持续执行：`runners/pilotdeck/batch_run.py` 也已改为复用同一 `run_pilotdeck()` SDK 路径，批量评测不再生成协议 1.0 的临时 WS 客户端。
- L2 持续执行：兰台健康探针改用 Gateway `/health` HTTP 端点；运行/批量/健康路径均不再自行构造协议 1.0 hello/request 帧。
- L2 持续执行：SDK bridge Gateway 地址支持 `PILOTDECK_GATEWAY_HOST`/`PILOTDECK_GATEWAY_PORT`，并兼容既有 `PILOTDECK_WS_*` 配置别名，迁移文档与容器端口配置一致。
- 验证更新：支持的 Node 22.23.1 下根目录与 SDK TypeScript `--noEmit` 均通过，SDK/Gateway focused suite 已扩展到 `34/34`（含真实 WebSocket 断连/重连交互覆盖）；`@pilotdeck/sdk@0.1.0-alpha.0` tarball 可安装并导入公共 exports。Lantay runner tests 在临时 `uv` pytest 环境下 `80 passed`，API suite `136 passed`；生产-like Gateway/model 凭证和完整端到端验收仍未覆盖。
- 当前增量验证：SDK transport + Gateway memory/manager + RunRegistry + memory composition focused 已扩展为 `148/148`；根目录与 SDK TypeScript `--noEmit` 均在 Node 22.23.1 通过，相关 worktree `git diff --check` 通过。SQLite experimental warning 仍属 Node 环境提示。

### 2026-09-23 增量

- S9：`InProcessGateway` 与 `createLocalGateway` 新增通用 `managerBrowsers` host provider seam；有 provider 时真实委托并在 `describeServer()` 公布能力，无 provider 时保持明确 unavailable。Gateway focused suite 在当前 Node 25 环境 `14/14`，local composition provider test `5/5` 通过；根目录 build 被项目 Node 22 要求阻止，未将 Node 25 结果当作最终支持环境证据。
- S8：RunRegistry 的同 ID 冲突 fingerprint 现覆盖所有执行相关 turn 字段（模型、超时、权限/工具策略、附件与 trusted context 等），仅排除 reconnect binding、runId 和观察性 telemetry；新增不同 `modelOverride` 的冲突回归证据。
- S8：task-budget admission rejection 现在同时持久化 `error` 与 `turn_completed(task_budget)`，终态 registry record 不再停留在 `failed`；RunRegistry + Gateway focused suite 当前为 `22/22`。
- S8：`runs.observe` 现在由 Gateway 校验 `limit` 为 1–500 的安全整数，避免负分页隐藏终态；RunRegistry pagination regression 已覆盖非法 limit。
- S7：native archive manifest/entries/artifact 的 session、cursor、page limit、safe artifact name 和 byte limit 现在由 Gateway 在调用任意 provider 前统一校验；Gateway capability suite 当前 `15/15`，RunRegistry suite `8/8`。
- S7 验证更新：archive retention/composition、manager provider 和 Gateway capability regression 合计 `24/24` 通过；仍没有生产-like Gateway/长结果/子代理归档环境证据。
- SDK 控制面：`runs.get/observe/result/reattach/abort` 现在在 SDK 端校验 session/run 引用与 observe cursor/limit，非法调用不会建立 WebSocket；SDK package suite 在当前环境 `131/131` 通过。
- S2/L2 增量：正式 SDK 新增 Gateway-owned upload `create/get/part/complete/cancel` 资源，Remote API 返回的附件元数据不暴露 Gateway 本地路径；兰台 SDK bridge 现在先上传 staged material，再以 `uploadedAttachments` 引用提交 run，避免把兰台本地路径误当作 Gateway 路径。Gateway upload 集成测试与 SDK transport 回归通过；真实跨主机上传、长文件分块和端到端 Gateway 仍待 live 验证。
- L2 验证增量：新增 hermetic bridge subprocess 回归，实际断言 staged 文件按 `create → part → complete → runs.start` 顺序上传，且 `runs.start` payload 不含本地 `path`；兰台 runner tests 当前 `70 passed`，API delivery contract 仍为 `48 passed`。
- S5/Runtime 增量：SDK/Gateway worktree 已接入通用 `ModelInvocationLogSink`。每次 provider attempt 在发送前同步 stage 原始请求，stage 失败时零发送；完成、provider/transport error、流式 incomplete/timeout 与 retry attempt 均 append 请求/响应记录，并沿 AgentLoop/Router/子代理保留 run、workspace、caller、logical call 与 parent tool provenance。新增 `tests/model/streaming/invocationStageBarrier.spec.ts`，根目录与 SDK typecheck 通过。真实 provider audit、重启与收尾故障仍待 live 验证。
- L2 增量：SDK bridge 在 staged 文件的 part/complete 失败时调用 Gateway-owned `uploads.cancel`，避免失败上传遗留到 retention 清理；新增 bridge subprocess 回归，兰台 runner tests 当前 `71 passed`。
- L2 验证增量：新增 bridge subprocess 回归，模拟连接丢失后通过 `runs.reattach`/`runs.observe` 恢复 durable events，按 sequence 去重并以 Gateway `runs.result` 作为终态；兰台 runner tests 当前 `72 passed`。
- S5/Runtime 验证增量：新增 `tests/router/router-model-invocation.spec.ts` 回归，确认 Router 执行上下文中的 workspace/run/caller/subagent provenance 会完整传递到 provider invocation audit context；该 focused router suite `2/2` 通过。生产-like provider audit 与 A1 live 验收仍未验证。
- 当前回归验证（此前增量记录）：SDK package suite `131/131`、Gateway/Runtime focused suite `31/31`、兰台 runner tests `72 passed`，根目录与 SDK TypeScript `--noEmit` 均通过。后续已补充真实 WebSocket 断连/重连覆盖，当前 focused suite 为 `34/34`；Node 25 仅作为当前环境检查，支持环境 Node 22 与生产-like Gateway/model 的完整 A1 故障恢复仍待验证。
- 本地传输增量：临时启动 worktree Gateway 后，`/health` 返回 `{"ok":true}`，正式 SDK 使用 Gateway token 完成 WebSocket `describeServer()` 并读到 capability 列表；smoke 完成后已停止进程。该证据不替代真实 provider、跨重启和 A1 live 验收。
- L2 配置修正：兰台 `api/health.py` 现在与 SDK bridge 共用 `PILOTDECK_GATEWAY_HOST/PORT`，并兼容 `PILOTDECK_WS_HOST/PORT`；此前非默认 Gateway 地址会导致健康探针误报。新增无网络配置回归，完整 API suite `136 passed`。
- L2 配置修正：SDK bridge 新增 `PILOTDECK_GATEWAY_TOKEN_PATH`，兼容 `PILOTDECK_SERVER_TOKEN_PATH`，不再把 `~/.pilotdeck/server-token` 作为唯一部署路径；新增 token 路径优先级/缺失文件回归，runner suite 当前 `74 passed`。
- L2 配置修正：兰台 `shared.config` 现在跟随 `PILOT_HOME`，使自定义 PilotDeck home 下的 skill/project/token 解析与 Gateway 一致；新增 import-time 环境回归，runner suite 当前 `76 passed`。
- L3 交付验证：SDK tarball 在临时安装目录中通过 `pnpm pack`、依赖安装和公共导入 smoke，`createPilotDeckClient` 可用；这证明本地包装边界成立，但不替代部署环境验证。
- 最终本地回归（更新）：支持的 Node 22.23.1 下根目录完整测试 `1,900 passed / 8 skipped / 0 failed`（共 1,908 项）；该结果仍不替代生产-like Gateway/model 与 A1 live 验收。
- 跨仓库本地 smoke：临时启动 Node 22 Gateway 与确定性测试模型，使用迁移 worktree 的 `runners/pilotdeck/sdk_bridge.mjs` 完成 staged attachment 上传、`runs.start`、有序事件转发和单一 `__done__` 终态；Gateway `/health` 返回 `{"ok":true}` 后已停止服务。该 smoke 不替代真实 provider 凭证、重启和生产部署验收。
- L2 断线恢复强化：bridge 现在按 `afterSeq` 分页重放 Gateway durable events，遇到 history gap 或分页停滞 fail-closed；新增多页重连去重回归，runner suite 当前 `80 passed`。
- L2 project identity 修正：兰台 runner 不再把每轮临时 `workspaceCwd` 作为 Gateway `projectKey`；新增 `PILOTDECK_PROJECT_KEY`（兼容 `PILOTDECK_PROJECT_ROOT`）配置，未设置时回退到 `PILOT_HOME` 通用 workspace，并保留临时 workspace 隔离；未注册的显式路径由 Gateway 拒绝。新增 runner 回归覆盖 project identity/workspace 分离；完整 runner suite 当前 `80 passed`。
- 临时真实环境增量：使用隔离 `PILOT_HOME` 加载现有 Gateway 模型目录（不输出凭证），`provider1/qwen3.6-flash-distill` 完成了正式 SDK 单轮和兰台 SDK bridge（含 staged attachment 上传）真实 provider smoke；随后重建临时 Gateway 后，原 run 的 `runs.get/result/observe` 仍返回 `completed`，同 ID 同请求只回放持久事件且未重复执行。该证据仅覆盖本机临时 Gateway/provider，不替代跨进程 ACK 丢失、权限交互、四种材料场景或生产部署验收。
- 临时 provider audit 增量：在隔离 `PILOTDECK_LEGAL_STORAGE_ROOT` 下，真实 provider 单轮写入一条 `success` 审计记录（attempt 1、`caller=agent`、run/turn/logical-call provenance、`responseComplete=true`）；请求/响应正文不写入本交接文档。重试、失败、流断、子代理及生产持久化故障仍未覆盖。
- S6 SDK 控制面修正：`permissions.respond()` 从独立 SDK 控制 WebSocket 回答运行中连接创建的 pending permission 时，不再被 renderer interaction binding 误判为 stale；Web/renderer 连接仍保留 binding 校验。新增 Gateway WebSocket connection 回归，确认回答前请求仍 pending 且独立控制连接返回 `delivered=true`。该修正仅有本地确定性证据，生产-like approval/timeout/reconnect 仍未验收。
- S6 临时真实 provider 增量：隔离 `PILOT_HOME` 下使用已配置的 `provider1/qwen3.6-flash-distill`，直接 Gateway turn 产生一次 `permission_request`；正式 SDK 的 `permissions.list/respond` 通过独立控制连接返回 `delivered=true`，且目标文件只在 allow 后出现。该证据覆盖本机临时 approval，不覆盖 timeout/reconnect 或 production-like acceptance。
- S6 临时 permission 矩阵增量：同一隔离真实 provider 环境覆盖 allow、deny、无响应 timeout 三个独立 session；allow 创建目标文件，deny/timeout 均未创建，timeout turn 产生原生 `permission_denied` 后完成。该证据仍仅覆盖本机临时环境，不覆盖 reconnect 或 production-like acceptance。
- S6 临时 permission reconnect 增量：真实 provider 产生 `permission_request` 后主动关闭运行 WebSocket；pending 请求仍可由 SDK 控制资源列出并回答，`permissions.respond` 返回 `delivered=true`，随后 `runs.reattach`/`runs.result` 读取到 completed durable result，目标文件成功创建。该证据仍是本机临时连接故障 smoke，不等同生产进程/网络 fault matrix。
- S8 临时进程重启增量：真实 Gateway 在 run 已发出 `input_accepted` 后被 SIGKILL，新 Gateway 重新打开同一 durable registry，`runs.reattach`/`runs.get` 返回 `interrupted`，SDK `runs.result` 返回 `result_unknown`。该证据覆盖本机 process-crash recovery，不覆盖 ACK-loss 或 production deployment。
- S8 临时 ACK-loss 增量：真实 provider run 在 SDK 收到 `input_accepted` 后立即断开连接，Gateway 继续完成原 run；独立 SDK 控制面通过 `runs.get/result/reattach` 读取 completed，未重新提交输入。该证据覆盖本机 accepted-ACK-loss smoke，不覆盖 production deployment。
- S7/Runtime 本地确定性增量：支持 Node 22.23.1 下 compaction/archive/reference focused suite `61/61` 通过，覆盖 rolling micro/full compaction、atomic snapshot replay、crash-tail recovery、oversized tool-result reference retrieval semantics，以及多轮后 tool-call/tool-result 配对保持。该证据不替代真实长结果/子代理归档或 production-like Gateway 验收。
- S7 本地 Gateway 归档增量：新增 `createLocalGateway()` 持久化回归并通过 `17/17`（单项 archive E2E `1/1`），实际从 Gateway-owned JSONL/artifact storage 分页读取两次 compaction snapshot、长结果引用与 artifact、tool-call/tool-result 配对及 subagent provenance；仍不替代真实 provider 或 production-like 子代理验收。
- S5 InvocationAudit 本地确定性增量：`invocationStageBarrier.spec.ts` 当前 `7/7`，新增 provider HTTP failure 与 incomplete stream 的 append 记录断言，并覆盖发送前 stage 屏障、重试 attempt 关联和完整响应；真实 provider retry/failure/stream-incomplete/subagent 运行时矩阵仍未完成。
- S6 权限本地确定性增量：permission lifecycle/control focused suite `26/26` 通过，覆盖 duplicate registration、timeout、abort/late reply、teardown deny、WS reconnect/replay 和独立 SDK control response；真实 production-like fault matrix 仍未完成。
- L1/L2 场景契约增量：兰台新增纯函数四场景分类（新请求有材料/无材料、续接无材料/带新材料）、续接场景沿用既有材料而无需重复上传，以及 staging → lineage manifest → delivery harvest 的组合回归；聚焦 API 合约 `85 passed`，完整 API suite 更新为 `145 passed`。该证据仍是本地确定性验证，不替代四种真实材料场景或生产服务验收。
- L1/L2 同步语义修正：同步 JSON runner 现在与 SSE runner 使用相同的 business-deliverable gate，按本轮 workspace baseline 识别真实业务文件，重试缺少交付物的可恢复结果，并返回 `delivery_status`/`missing_business_deliverable`；`test_empty_run.py` `72 passed`，完整 API suite `145 passed`。仍未替代真实服务的四材料场景验收。
- L1/L2 recovery 契约增量：新增 `last_result` 一次性读取回归，验证掉线恢复返回完整响应形状，首次读取后明确返回 `idle_or_already_delivered`；turn-lock/recovery focused `13 passed`，完整 API suite 更新为 `146 passed`。仍不替代跨进程/生产部署恢复验收。
- L1/L2 交付路径修正：runner 的 business-deliverable gate 现在扫描实际 `workspaceCwd` 而不是仅扫描 transport run directory，并递归识别嵌套业务文件；sync/SSE 均有回归，runner suite 更新为 `84 passed`。仍不替代真实四种材料场景验收。
- L1/L2 契约审计（历史快照）：当时 checkout 只有持久 per-session turn lock，尚未加入 Lantay-owned `Idempotency-Key`/business-idempotency store；后续已补齐显式 API 层 store，仍不把 SDK `runId` 去重误称为业务幂等。
- L1/L2 路由组合增量：新增 hermetic FastAPI sync B→C 回归，实际验证 fresh session 创建、同 workspace continuation、嵌套交付 harvest 与 `last_result` 持久化；聚焦场景/staging/delivery API 合约 `86 passed`，完整 API suite `147 passed`。该证据仍不替代真实 provider 或四种材料 live 验收。
- L1/L2 路由组合增量：新增 hermetic FastAPI sync A→D 回归，实际验证新会话上传材料的 staging/lineage/workspace mirror、续接会话新增材料但保留先前材料、逐轮 manifest 与交付 harvest；聚焦场景/staging/delivery API 合约更新为 `87 passed`。该证据仍是本地确定性验证，不替代真实 provider、OCR 或四种材料 live 验收。
- L1/L2 路由组合增量：新增 hermetic FastAPI sync OCR 失败回退回归，实际验证上传扫描 PDF 在 OCR 无结果时保留 raw 文件与 `*_ocr_failed.txt` 提示、发出 warning、仍完成模型路由并只 harvest 业务交付物；聚焦场景/staging/delivery API 合约更新为 `88 passed`。该证据不替代真实 OCR 服务或 provider 验收。
- L1/L2 回归更新：上述路由、staging、delivery 变更在 Lantay API 全套测试中通过 `149 passed`（一个既有 Starlette deprecation warning）；该本地结果不替代真实部署与 provider 验收。
- S4 控制面增量：Gateway `describeServer()` 现在按已装配的 host port 发布全部 Cron/Always-on 操作能力；未装配 Cron 时远程调用返回明确 `CAPABILITY_UNAVAILABLE`，不再暴露未分类运行时错误；六个 Cron RPC 均有 host controller 委托回归。Gateway capability suite `19/19`、支持 Node 22 TypeScript 检查通过。
- S4 回归更新：支持的 Node 22.23.1 下根目录完整测试通过 `1,903 passed / 8 skipped / 0 failed`（共 `1,911` 项）；这仍不替代 production-like Gateway/model 与 A1 live 验收。
- 2026-09-23 生命周期回归修正：发现持久化 RunRegistry 在 `turn_completed` 后立即进入终态，导致随后由 AgentSession 派发的 `SessionEnd` SDK hook 被终态 fence 拒绝。Gateway 现暂存终端 `turn_completed`，待 SessionEnd/live hook 生命周期完成后再按最后一个 durable event 发布；SDK 生命周期回归 `2/2`，Gateway/Runtime focused `44/44`，Node 22.23.1 根目录全量回归更新为 `1,907 passed / 8 skipped / 0 failed`（共 `1,915` 项）。该修正不改变生产式 Gateway、跨主机及 A1 外部验收边界。
- S8 控制面增量：Gateway 仅在装配 `RunRegistry` 时发布 `run_get`、`run_events`、`run_reattach` capability；未装配时仍由服务端返回 `CAPABILITY_UNAVAILABLE`，permission decision 资源明确纳入 capability 列表。Gateway capability suite 更新为 `20/20`，Node 22 类型检查通过。
- S8 结果契约增量：SDK `client.runs.result()` 现在读取 Gateway durable event log 并按分页重建与在线 handle 一致的文本/structured output；`aborted` 优先于同一终端 `turn_completed` 事件，failed/unknown 语义保持不变。SDK package suite `132/132`、SDK typecheck 与 `git diff --check` 通过。该证据仍不替代 production-like Gateway restart、跨主机和 A1 live 验收。
- S9 本地管理增量：`createLocalGateway()` 的 snapshot list 现在按 Gateway 派生 workspace identity 精确过滤并支持 cursor/limit 分页，snapshot get/restore 在读取前校验来源项目；跨项目或不存在的 snapshot 统一返回 `SNAPSHOT_NOT_FOUND`。新增真实本地 Gateway composition 回归通过。manager browser 仍由宿主 provider 提供，未装配时保持 `CAPABILITY_UNAVAILABLE`。
- S9 SDK 映射增量：公开资源的 `sessionId` 现在在 `snapshots.list()`、`manager.sessions()` 和 `manager.browsers()` 中明确映射为 Gateway 协议的 `sessionKey`，不会静默丢失 session 过滤；SDK transport suite 保持 `132/132`。
- S4 SDK 映射增量：`alwaysOn.abort()` 现在同样将公开 `sessionId` 映射为 Gateway `sessionKey`，并通过 transport 回归验证不会发送错误字段；SDK package suite 仍为 `132/132`。
- L2 当前回归复核：迁移 worktree 的 `runners/pilotdeck` suite `88 passed`、Lantay API suite `150 passed`（一个既有 Starlette deprecation warning）；runner/API 仍通过正式 SDK bridge，未发现 Python 直连 Gateway WebSocket 客户端。新增缺失 SDK 模块时输出结构化 `__done__` 终态错误，以及 SDK `result_unknown`/`failed`/`aborted` 状态不会作为成功业务结果交付的回归。该复核不替代真实部署、跨主机和 provider fault matrix。
- L3 交付边界复核：在支持的 Node 22.23.1 下重新生成 SDK tarball，并在全新临时目录完成依赖安装与 `createPilotDeckClient` 公共导入 smoke。迁移/回滚 runbook 现明确：本次只替换 transport，不做原地 session/业务数据转换；已接受 run 不在 SDK bridge 与移除的 protocol 1.0 client 之间切换，回滚仅由部署所有者选择先前 artifact/worktree。该证据验证本地打包边界，不替代部署验收。
- S8 接受/终态语义修正：Gateway `RunRegistry.accept()` 的非冲突持久化失败现在返回 `result_unknown`，带 inspect-before-retry 提示且不会执行 agent；只有明确的同 ID 请求冲突继续返回 `conflict`。`FileRunRegistry` 终态现在拒绝迟到事件，保持 `aborted`/`interrupted` 优先级。RunRegistry focused suite `10/10`、Gateway capability/lifecycle focused suite `38/38`、Node 22 root/SDK typecheck 均通过。
- S9 管理资源边界修正：Gateway memory/snapshot 方法现在在任意 provider 调用前拒绝空 `projectKey`、空 session filter、缺失 session-scoped wipe 的 `sessionKey`、空 snapshot ID（含空的 `targetProjectKey`），避免远程请求意外回退或扩大业务 workspace 范围；Gateway capability suite 当前 `22/22`，Node 22 root typecheck 通过。
- L1/L2 终态摘要回归：API 层 `_build_run_summary` 现在与 SDK runner 一致，将 `result_unknown`、`failed`、`aborted` 终态标记为错误，不会把 Gateway 重启/ACK 丢失等不确定结果作为成功业务结果交付；新增参数化 API 回归，Lantay API 全量 `150 passed`，runner suite `88 passed`（一个既有 Starlette deprecation warning）。该本地证据仍不替代生产式部署、跨主机和完整 A1 live 验收。
- 当前 SDK/Gateway 回归复核：支持的 Node 22.23.1 下 RunRegistry、Gateway capability、Runtime policy/invocation audit、Router provenance 与真实 WebSocket 断线交互组合 suite `44/44` 通过；SQLite experimental warning 和测试中预期的 fault-injection 日志不影响通过结果。该本地证据仍不替代生产式 Gateway、跨主机和 A1 live 验收。
- L2/A1 临时真实 provider 四场景 smoke：在隔离 Node 22 Gateway/API、已注册项目和 `provider1/qwen3.6-flash-distill` 下，fresh+material、fresh+no material、continuation+no material、continuation+new material 四次请求均通过正式 SDK bridge，HTTP 200、`has_error=false`，续接场景复用同一 session。该 provider 会话的权限策略阻止文件写入，因此四次均为 `generated_files=[]`、`delivery_status=not_required`；这只证明 transport、staged attachment/session 路由及错误整形，不证明真实 OCR/conversion、业务交付、跨主机部署或四种材料的 live 交付验收。迁移 `runners/pilotdeck` 完整 suite 现为 `89 passed`。
- S2/L2 权限放行补充 smoke：隔离 Node 22 Gateway 将默认权限配置为 `bypassPermissions` 后，正式 SDK 直接完成 `uploads.create/part/complete`、真实 `provider1/qwen3.6-flash-distill` run，并在已注册 workspace 生成 `scenario-allow.md`。这证明此前四场景中 `generated_files=[]` 的原因是权限策略而非附件上传/桥接故障；仍只覆盖单次 SDK/Gateway 运行，不替代四场景 API、真实 OCR/conversion、生产或跨主机验收。
- L2 迁移修正与 API 四场景 live smoke：发现 FastAPI async runner 将 `_Environ` 直接传给 Node 子进程，修正为 `dict(os.environ)`，并新增 `PILOTDECK_PERMISSION_MODE` 的可选、Gateway 仍裁决的 SDK `permissionMode` 透传；默认未设置时权限行为不变。配置显式 `PILOTDECK_SDK_MODULE` 与 host-approved `bypassPermissions` 后，fresh+material、fresh+no material、continuation+no material、continuation+new material 四个 SSE API 请求均 `has_error=false`，续接复用同一 session，四个 native `file_artifacts` 均为 `created/complete`。这些是 bounded local live evidence，ad-hoc 请求的 `delivery_status=not_required`，仍不证明 OCR/conversion、production-like 幂等或生产部署验收；runner suite 现为 `90 passed`。
- L2 delivery gate live smoke：使用同一隔离 Gateway/API、显式 SDK 模块和 host-approved 权限模式，提交包含 `write the deliverable file` gate marker 的材料请求；SSE 终态为 `delivery_status=complete`，native `scenario-api-gate.md` artifact 为 `created/complete`。这补足了 ad-hoc 四场景的 `not_required` 边界，但仍只是一条本机真实 provider 交付证据，不替代 OCR/conversion、跨主机、production-like 业务幂等或生产验收。
- 2026-09-23 当前复核（历史快照）：支持的 Node 22.23.1 下 lifecycle、RunRegistry、Gateway capability/archive、invocation-audit、真实 WebSocket reconnect/disconnect focused suite `42/42` 通过；SDK package suite `132/132` 通过。迁移 worktree 使用声明的 API requirements 运行 `runners/pilotdeck api`，`240 passed`，仅有既存 Starlette/httpx deprecation warning。机械检查确认 SDK 当前 88 个 request method 均有 Gateway WebSocket handler；未发现本地可修复的 SDK→Gateway 路由缺口。A1 仍保持未完成：production-like cross-host/restart/fault matrix、真实 OCR/conversion、production-like provider retry/retention、业务四场景交付和 caller-owned business idempotency store/key 尚无足够证据；后续已补齐本地 API 层幂等 store 与本地证据。
- 2026-09-23 live archive probe：首次探针误用了内部 `modelOverride` 形状，Gateway 正确回退到默认不可用模型并记录失败归档；修正为正式 SDK `options.model` 后，临时 Node 22 Gateway 使用 `provider1/qwen3.6-flash-distill` 完成真实长结果/子代理运行。重启 Gateway 后 native archive manifest 返回 `912` entries、`subagentCount=1`、`toolResultReferenceCount=16`；`archives.entries()` 五页达到 `complete=true`，并成功读取一个 `1,422,081` 字节的 tool-result artifact（`maxBytes=256` 时正确截断）。这只是 bounded local live evidence，production-like provider retry/retention、跨主机和完整 A1 仍未验证。
- 2026-09-23 provider failure probe：隔离 Gateway 将已声明的 `provider1/qwen3.6-flash-distill` 指向不可达 loopback endpoint；正式 SDK 运行在有界重试后以 `agent_model_error` 终止，Gateway invocation audit 持久化了 attempts `1–3` 的 `transport_error`，三条记录均保留 run/turn/logical-call provenance 且 `responseComplete=false`。这是 bounded local fault evidence，仍不等价于 production-like network/failure matrix。
- 2026-09-23 Lantay caller-owned 幂等增量：API 新增可选 `Idempotency-Key`，由 Lantay 自己的 SQLite store 持久化 canonical request descriptor、session/run 绑定和终态响应；相同 key 的完成请求只 replay、不再次执行，不同请求返回 `idempotency_conflict`，并发重复返回 `idempotency_in_progress`。新增 `api/test_idempotency.py` 通过 `11 passed`，覆盖结构化校验错误、跨进程 reservation fencing、stale owner fencing 和 artifact retention 边界；默认数据库位于 artifact retention tree 外。该能力与 Gateway `runId` 去重分开，仍需 production-like 多进程/部署验收。
- 2026-09-23 幂等回归更新：同步与 SSE API 均有相同 key replay 且不重复执行的路由证据；迁移 worktree 的 `runners/pilotdeck api` 合并套件通过 `251 passed`（一个既有 Starlette/httpx deprecation warning）。该本地结果不替代 production-like 多进程、跨主机和部署验收。
- 2026-09-23 SDK/Gateway 回归复核：支持 Node 22.23.1 下 SDK package suite `132/132` 通过；扩展的 lifecycle、RunRegistry、Gateway capability/archive、invocation-audit、Router provenance 与真实 WebSocket reconnect/disconnect focused suite `48/48` 通过。该确定性证据仍不替代 production-like Gateway、跨主机和 A1 live 验收。
- 2026-09-23 L3 幂等交付边界：迁移/回滚 runbook 现明确 production 或 release-controller 必须将 `LANTAY_IDEMPOTENCY_DB` 指向跨发布 artifact 共享的持久路径；worktree-local 默认路径只适于本地。该文档约束不替代实际部署演练。
- 2026-09-23 支持环境回归复核：在 Node 22.23.1 下重新执行 SDK/Gateway build 与完整根目录测试，结果为 `1,910 passed / 8 skipped / 0 failed`（共 `1,918` 项）。该结果确认本轮 SDK/Gateway 与运行时改动没有引入支持环境回归；仍不提供跨主机部署、外部 OCR 或 production-like provider fault matrix 证据。
- 2026-09-23 Lantay 幂等路由证据补充：新增实际 FastAPI sync handler 回归，owner-fenced completion failure 返回 `503 idempotency_completion_unknown`、携带 session/run 标识，并断言不会调用 `abandon()`；迁移 worktree API suite 更新为 `170 passed`，runner/API 合并为 `262 passed`，conversion/idempotency focused 为 `19 passed`。这些仍是本地确定性证据，不替代 production-like 部署与跨主机共享数据库演练。
- 2026-09-23 SDK/Gateway 协议面审计：从正式 SDK `RemoteGateway` 提取到 100 个 request method，并与 Gateway WebSocket dispatcher 的 100 个 dispatch case 做集合比较，缺失与多余均为 0；该机械审计只证明接口映射覆盖，不替代运行时/生产环境验收。
- 2026-09-23 Gateway 远程绑定增量：`GatewayServer` 现在支持显式的非 loopback 监听，但必须同时设置 `allowRemoteHost=true` 与显式 token；远程监听禁用 `/auth/local-token`，loopback 默认行为保持不变。CLI 通过 `PILOTDECK_GATEWAY_HOST`、`PILOTDECK_GATEWAY_ALLOW_REMOTE=1` 和 `PILOTDECK_GATEWAY_TOKEN`（或 `PILOTDECK_TOKEN`）传递该部署契约，新增绑定边界与认证 WebSocket 测试 `5/5`。这补齐了跨主机部署的服务端配置路径；真实跨主机网络、TLS/入口代理和生产发布仍未验证。
- 2026-09-23 InvocationAudit 增量：`invocationStageBarrier.spec.ts` 新增不完整流重试的逐 attempt 审计断言，以及子代理 `caller/subSessionId/parentToolCallId/runId` provenance 断言，focused suite 更新为 `10/10`。这加强了本地 provider fault 证据，但不替代 production-like 网络、子代理和收尾故障矩阵。
