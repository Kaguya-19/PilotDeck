# 公开能力与 runtime 接入交付（同一 G0–G7 候选）

现行合同更新：下方保留原始方案及当时 pending 记录；`PUBLIC_SDK_AUTHORIZATION.md` 已批准固定逐名白名单和仅账户 `sops:cancel`，代码/方法/响应以 `public-sdk-delivery.md` 为准。`EMPLOYEE_TEAM_SCOPE_EXCEPTION.md` 将非目标员工/team 扩展排除本轮；固定目标与原 owner/PEP/ETag/审批/runtime 仍是准入要求。

执行 owner：01a0e22b-681f-7213-8475-a510215540f5。整合入口：01a0e240-e9c4-76b0-991e-a2144273b08c。

本线从整合者已经提交的 PD `9f49f0bee88cd739488c904398d8bc3ceeecbfe0` 创建隔离 worktree，仅新增本文和 `ui/server/staffdeck-public-capabilities{,.test}.mjs`、`ui/server/staffdeck-publish-runtime{,.test}.mjs`。没有复制或修改其他人的 dirty WIP，也没有以 fixed 0.1.12 覆盖 0.1.13。契约依据为唯一 FIXED_012_CONSOLIDATED_AUDIT / PUBLIC_PROTOCOL_READINESS；额外仅从已提交 SD `60873869ae66e84178d779fac3cb8317236c0df0` 核实 JobRead、SkillRead、draft payload 和原生成/改写入口。SkillRead.id 是 owner row ID，skill_id 才是 runtime ID；两者不能误判为必须相等。

## 已实现与接线接口

### D15：独立公开客户端

```js
import {
  createPublicCapabilityClient, decodePublicJobEvents,
} from './staffdeck-public-capabilities.mjs';

const client = createPublicCapabilityClient({
  agentId: authenticatedAgentId,
  transport: authorizedPublicTransport,
  authorizedOperations: explicitlyApprovedOperations,
});
const response = await client.call(operation, input, { signal });
```

transport 接收 `{method,path,headers,body,signal,responseType}`，返回 `{status,body,headers?}`。path 为相对已配置 `/api/v1/` 的固定协议路径；body 为对象，由 transport 序列化。transport 必须沿用现有 PEP/owned credential/目标绑定，不使用调用方 URL，不重新取得 token，不重试请求。客户端默认授权列表为空，本文不授予白名单扩展。HTTP 非 2xx 原 status/body 原样返回，adapter 负责沿原错误合同展示，不能当成功。

| operation | input / 保留合同 |
|---|---|
| list_tools / list_general_skills | 无 body；严格检查 data 数组，不把坏 shape 投影成空列表 |
| create_tool / update_tool | `{body,toolId?}`，update 必须 toolId；拒绝 auth/headers/connection headers/env 的 `********` 回写，不自行猜测删除还是保留秘密 |
| test_tool | `{toolId,body}`；只表示已存工具测试，无 unsaved probe 别名 |
| import_general_skill | `{body}`；对应正式 import route |
| publish_general_skill / archive_general_skill | `{slug}`；archive 不表示 Remove/delete |
| test_general_skill | `{slug,body}` |
| generate_sop | `{body:{title,raw_content,business_domain?,model_config_id?}}`；要求 202，返回原 job，服务实际持久化 draft；不做第二次 create |
| rewrite_saved_sop | `{sopId,body:{instruction,target_paths?,model_config_id?,draft_id?}}`；仅明确的已存来源操作，拒绝 dirty/current_skill/currentSkill/conversation/conversation_context；不能接为原 dirty editor rewrite |
| get_job / get_job_result | `{jobId}`；终态 error、draft ID/content/draft_version/ETag/日期均不改写 |
| job_events | `{jobId,lastEventId?}`；保 Last-Event-ID 与 AbortSignal；返回原事件流，不偷偷 cancel |

所有含 body 的操作拒绝 body 中覆盖 tenant_id/agent_id/user_id/actor_user_id，身份由公开端正式 principal 决定。客户端不做 draft 投影或 snapshot 更新；该部分归 adapter owner。

`decodePublicJobEvents(response.body,{signal})` 接收异步字节流，输出真实 `{id?,event,data}`（data 为原 SSE 文本，多行仅按协议连接）。支持 UTF-8 跨 chunk、CR/LF/CRLF、注释心跳；不造 chunk/message_chunk、status/百分比，不把尾部未完帧当成功。它不负责重连、cursor 持久化或 job 取消，adapter 以实际已消费 id 恢复。

现有 generate/rewrite 会创建持久 draft，而原临时 preview 不持久化：本客户端支持公开原语，不宣称原 UI 生成/改写已等价接通。新增操作尚未挂接 router 或 advertised methods，等待用户白名单决策；没有扩大权限。

### C01：正式发布到部署快照与刷新请求

```js
import {
  createAtomicBundleStore, createPublishRuntimeCoordinator,
} from './staffdeck-publish-runtime.mjs';

// 用宿主已声明的 YAML parser 读取现有 definitionsPath；新写 JSON 仍可被 YAML loader 读取。
const coordinator = createPublishRuntimeCoordinator({
  store: createAtomicBundleStore({ parse: parseYaml }),
  requestRefresh: requestExistingGatewayReloadExtensions,
});
const result = await coordinator.publish({
  binding: resolvedSopBinding,
  owner: { tenantId, actorUserId, agentId, credentialId },
  sopId,
  publish: () => existingAuthorizedPublishCall(),
});
```

接在现有正常 publish 分支，替换原单次调用的包裹方式；不要在已有 publish 之后再调用 publish。`owner` 来自已验证请求上下文，不能采信浏览器 body；binding 使用 request-local 已解析配置。config 检查只验证 management/discovery endpoint、agent、defaultSopId、definitionsPath 一致，不冒充 PEP。既有运行 credential 可以不同于管理 credential，不能为求一致换 key/token。

返回保留原 `{status,body,headers?}`，另附 `runtime`；失败 cause 在 `runtimeError`，只供服务端处理，不直接 JSON 序列化给浏览器。公共 route owner 必须选择可公开 runtime 字段并按原协议接入 UI。不要把 runtimeError 或配置对象发往 UI。owner publish 非 2xx 原样返回，不读写快照、不重试、不刷新。

正常发布成功后：

1. 校验正式响应 sop.status/skill_id/version/content，拒绝不匹配源；不从输入 dirty content 或 draft 拼造。
2. 读取已有完整 bundle（也支持原单个 published 格式），精确替换/新增该 ID，保其他定义和未知字段。不得删掉旧会话仍需选择的 ID。
3. 同目录临时文件写入并 rename，防止 runtime 读到半文件。不修改任何会话 persisted bundle，不反向写 owner，不用独立 definitions PUT 救援。
4. 经宿主既有 Gateway port 请求 `reload_extensions`。必须真实接线，不允许 callback 直接返回固定成功，不可替为 `reload_config`。若 Gateway 不 ready、未配置或拒绝，返回明确失败阶段。
5. ack 之后仅为 `awaiting-runtime-observation`，`effective:false`。这不是生效断言；后续真实 runtime 首次读取和正常新 run 的 pin 证据归同一集中矩阵。

runtime 字段：`status`、`ownerPublished`、`snapshotWritten`、`refreshRequested`、`effective:false`，有正式源时另含 `sopId/version`，失败含 `failure:{phase,code}`。phase 为 configuration / published-source / snapshot / refresh。后段失败保 owner 发布成功，不改成“未发布”或再发布。宿主应持久化这份 receipt，web 重新启动后不得用临时内存值声称已生效。本线未新增数据库或共享 UI 状态。

同一 Node 进程、同 definitionsPath 的发布调用和快照更新串行执行，避免并发 publish 的旧响应覆盖新快照。整合必须维持一个 writer 进程；跨进程/外部 writer 的协调不在本 helper 内，不能多个 web 进程同时写同文件。手工改文件不属于此正常链路。

现有源码支持的 pin 依据：SopStateStore.loadOrCreate 已存在会话原样返回；SopAgentLoop.prepareForModel 将 persisted.bundle 送 owner prepare，replace 也用 persisted.bundle。新 factory 从 definitionsPath 读取新 bundle。与此同时 selectSop 仍要求当前 bundle 包含 persisted selected ID，因此 helper 保留其他 ID。以上只是源码依据，不签等待恢复/oldpin/newpin 运行 PASS，核心文件未变。

## 无等价能力：一次明确的薄公开契约方案

下表均为待决定/待实现方案，不是现有 route。PD 不导入 enterprise backend；SD public facade 复用原服务和显式 PEP。新增白名单尚未批准，本文没有修改 public routes 或 scopes。

| 缺口 | 建议薄 route 与必须保留语义 | 当前阻塞 |
|---|---|---|
| dirty rewrite / 原 token 事件 | `POST /agents/{agent}/sops/{id}:preview-rewrite`，body 精确保留原 SkillRewriteRequest 的 current_skill、instruction、model_config_id、target_path（默认 all）、target_paths、target_label、conversation（list[dict[str,str]]）、available_tools、available_sops；tenant/agent/actor 从 principal 注入；path ID 必须匹配 current_skill.skill_id。在 SD 内复用原 rewrite stream/job 创建和 `_owned_stream_job` 的 tenant+user 约束，以真实 stream_text 事件输出，不写 APISOPDraft。新 preview job 必须有独立明确读取/事件 namespace，不能混用 APIJob IDs。 | 现有 v1 只改写持久来源并新建 draft。薄 route、PEP、job namespace 与授权接线尚缺。 |
| 原临时生成 | `POST /agents/{agent}/sops:preview-generate`，复用原 distill scope manager、context enrichment、stream_text；保持真实结果/事件与不保存语义。 | v1 generate 会持久化；不能把其 job 映射成原临时 stream 后又 create。 |
| overall move-to-draft | `POST /agents/{agent}/sops/{id}:move-to-draft`，调用原 move 行为；严格原 overall+admin 限制、只改原对象 status。 | 不能用 create{}；不存在现成等价 v1 route。 |
| Remove/delete | `DELETE /agents/{agent}/sops/{id}`，保原 overall delete 与 employee hidden/deleted branch/binding 差异及原 manager/admin PEP。 | archive=inactive，不等价；删除 binding 会重显继承。 |
| sync/promote | 分别 `POST /agents/{agent}/sops/{id}:sync-from-overall` 与 `:promote-to-overall`，直接复用原分支规则及 promote admin 限制。 | copy/import/gallery 不能替代；需有界 facade。 |
| 历史删除 | `DELETE /sops/{id}/versions/{version}`，保原 overall/admin、当前 active version 409，不自动 rollback。 | 公开现有 read/rollback 不等价。 |
| tool probe/delete | 单独 `POST /agents/{agent}/tools:probe` 接原未保存 tool body，和正式 `DELETE /agents/{agent}/tools/{id}`；保原 scope/actor 限制。 | test 需持久 ID，archive 只禁用 binding。 |
| SOP extract | `POST /agents/{agent}/sops:extract-file`，沿原 filename/content_base64/5MiB/支持类型和 400/413 错误；只回 filename/text，不建 KB/job。 | 无同语义公开 route，需 facade 与明确 scope。 |
| models/users | 单独只读可选模型 metadata / 可见 handoff user 目录；保原可见范围，模型不返回 provider secrets。 | agent model binding `effective:false` 不是 model catalog/有效配置，handoff 记录不是用户目录。 |
| cancel | APIJob 已有 `/jobs/{id}:cancel`；保持真实 job.cancel_requested 与最终 cancelled 区分。 | 账户缺 sops:cancel/jobs:cancel，用户决策 pending；新增 client 不提供可绕过接口。 |

已核实 preview 的原字段就是 `conversation: list[dict[str,str]]`；target_path 和 target_paths 并存，不能只转后者。生成 preview 的原字段为 title/raw_content/business_domain/model_config_id/available_tools/available_general_skills/available_knowledge_bases，连同服务端注入的 tenant_id/agent_id 构造正式请求，沿原 context enrichment，不丢目录上下文。原 `_owned_stream_job` 的 tenant+user 所有权不等于 APIJob 的 tenant+agent 可见性，两种 job 不能静默互换。

## 聚焦自验与整合剩余项

最小命令（无安装、无服务、无真实模型）：

```sh
/Users/a1/.nvm/versions/node/v22.23.1/bin/node --test ui/server/staffdeck-public-capabilities.test.mjs ui/server/staffdeck-publish-runtime.test.mjs
```

13 个聚焦测试：授权缺失零请求、不等价操作拒绝、编码/目录坏 shape、mask/scope 回写拒绝、dirty/current_skill 零 save、真实 202/result、原 HTTP failure/AbortSignal/cursor、逐字节 UTF-8 SSE、真实临时文件 atomic snapshot、owner row ID 区别、失败发布零 runtime 写、刷新失败保发布、错 owner/来源/文件失败、并发顺序、单 published 文件兼容。协议替身和临时文件只验证 helper；不属于独立业务轮，不签 G0–G7 运行。

首次命令因 shell PATH 无 node 返回 127；改用本机已存在 Node 22.23.1，无安装。测试临时目录自动移除。

整合依赖：

- adapter owner 接能力 helper 的请求/事件/错误投影；只有明确批准的 operation 才能进入 authorizedOperations；白名单未决项保持 BLOCKED。
- 公共文件 owner 接正常 publish coordinator、现有 Gateway `reload_extensions` port、receipt 持久化及准确 UI 状态。本文不改 routes/modules.js。
- C01 真实 newrun/newpin、已有 run/oldpin、wait/reload/审批、runtime failure、仅 web 重启由一次完整候选验证。测试未证明 runtimeObserved，不应把 `effective:false` 改成内存 true 来关缺口。
- 实际模型有效配置仍 NOT RUN。需从 PD effective model/profile 与 SD model_for_agent 正式配置分别核 provider/model/agent，正常 route/turn 的 modelwire 才是运行证据。此前请求 distill 返回 flash 的 alias 差异继续记录；本线没有发新模型请求或声称有效。

没有共享桥/vendor/lock 修改，没有 core/ETag/cache/权限变化，没有 build 或新 164xx/166xx 服务，无 push/merge/部署。此交付是可整合本线代码，不是一个新候选或完整 cleanpair。

## 整合者已接入的公共桥

正常 `POST /api/modules/sop/management/call` 的 publish 分支已由整合者接入 coordinator，包裹原 `callSopManagement` 一次，不另调 publish。经原身份核实返回的 tenant/actor/agent/credential ID 构成 owner；相对 definitionsPath 沿正常 PILOT_HOME 解析。使用既有 `getPilotDeckGateway().reloadExtensions({changedPaths:[definitionsPath]})`，不回退 reload_config。

返回 `{result: 原正式发布body, runtime: 独立状态}`；不会把 runtimeError 原因、凭据或部署路径发给浏览器。runtime 增加 receiptPersisted；若存储失败，另有 receiptFailure.code，但仍保原发布成功，effective 始终 false。receipt 存于 definitionsPath 相邻的 `.publish-receipts.json`，原子写入；发布/快照/receipt 在单 writer 进程内按路径串行。既有 `GET /api/modules/sop/management` 在正常身份核实后返回 `runtime:{receipts:[...]}`，仅含当前 owner 的 sopId/version/status 和阶段状态；web 重建后从盘回读，不靠内存宣称生效。

adapter 接线须保留 response 同级 runtime，不能只读取 result 而丢弃运行状态；UI 分开呈现 ownerPublished 与 runtime 状态，awaiting-runtime-observation、failed 或 receiptPersisted:false 均不能显示“已在运行时生效”。具体 UI/adapter 改动仍由其唯一 owner 交付，不以管理 metadata 返回替代实际页面证据。

GET management bootstrap 同时返回正式核实的 tenantId、actorUserId、agentId；不公开 credentialId，不改 adapter 旧 cache namespace。Knowledge query/citation/call 与 SOP management GET/call 每次显式核实身份，不依赖 native read 自动执行 FastAPI dependencies。新增两项真实 HTTP 聚焦测试在首次合法请求后撤销/改变正式身份，后续 read/write 均拒绝且不触发业务上游；连同原 route 测试共 5 PASS。

整合者新增 `ui/server/staffdeck-publish-route.js` 与聚焦测试；原 13 项 helper 测试加 3 项持久 receipt 测试共 16 PASS，公共实际 HTTP route 3 PASS（create/ETag、abort、一次 publish→快照→Gateway port→receipt metadata）。这些使用正式协议替身与自有 166xx 端口，不是独立真实模型或 ownerDB 验收。

## Historical pure protocol placement inference (superseded by final SERVER-ONLY contract)

The capability client/planner/SSE decoder from4319eadd has no Node or authentication imports. Its canonical implementation now lives in ui/shared/staffdeck-public-capabilities.mjs, byte-for-byte unchanged; ui/server/staffdeck-public-capabilities.mjs is a compatibility re-export. Browser consumers may inject it from that neutral shared path and an existing explicitly authorized gateway transport, with no server imports or SD credentials. The publish/runtime coordinator alone uses Node and remains server-only. Earlier statements calling both helpers server-only are superseded by this correction.

Adapter8e8d5cdf supplies response/error/job/event consumption and request-local cursors only. No production initialization or route/operation advertisement is introduced. Existing management/call supports only its original declared operations; it cannot carry new protocol operations until the explicit route whitelist decision and matching transport contract are resolved. Therefore no new path-based browser proxy or approximate mapping to an existing management operation is installed. authorizedOperations remains empty while pending; dirty/current_skill/conversation cannot become saved public jobs; cancel remains blocked.

## d29e9a34 final server-only placement receipt

Accepted immutable d29e9a345708b45925141f6276320cd6acdb9611 (parent8e8d5cdf), applying its exact frontend comment and final gateway-only documentation contract. The capability owner's explicit SERVER-ONLY placement takes precedence over the previous inference from missing Node imports. Both4319eadd helpers stay under ui/server; no capability helper object/SD decoder is imported or injected into the browser. Frontend public-capability-adapter accepts only the authorized module gateway facade and that gateway's public stream decoder.

The integrator's ui/shared capability relocation and frontend helper-injection test from4505a24a are removed. Original server protocol implementation is restored byte-for-byte; its old path is again the implementation rather than a shared re-export. Earlier relocation test evidence remains historical and is not current-placement or gate evidence.

modules.js now provides a server-only createStaffDeckPublicCapabilityGateway after verified management owner context, binding createPublicCapabilityClient/decodePublicJobEvents to the same server credential transport as the original management calls. authorizedOperations is fixed at []; it does not take authorization from browser input. The prepared factory is not attached to a new operation dispatcher. Existing original-ten-operation management whitelist/advertisement is unchanged; no new route or SSE proxy is enabled pending approval. runtimeError/config/keys and direct StaffDeck transport remain server-side.

Focused checks justified by the transport extraction: six existing actual HTTP public-bridge cases plus two server gateway owner/default-denial cases =8/8 PASS. Raw: /Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/adapter-wip-handoff/adapter-server-placement-tests.log. Owner53 frontend+4 helper were not rerun for comment/doc changes. No dirty preview->saved job, cancel enablement, second publish or effective claim. Same integration, no new candidate/round or gate promotion.
