# 已授权公开 SDK / StaffDeck 有界 facade：本批交付

授权依据：`/Users/a1/Documents/Codex/2026-09-27/g0-g7-acceptance-preparation/PUBLIC_SDK_AUTHORIZATION.md`。本批只在公开/runtime owner 隔离树实现，供唯一整合者按固定提交接入同一 G0–G7 候选；不是生产已启用或业务验收 PASS。PD browser 继续只走现有模块网关，不 import SD backend 或持账户 key。SD `public_api/staffdeck_facade.py` 只调用原正式 owner 函数，不改业务核心。PD `ui/server/staffdeck-public-capabilities.mjs` 为逐名 server SDK/planner，`.d.mts` 提供对应输入类型，未知操作拒绝；整合者独占 `modules.js` 中真实 owner transport、固定授权列表、公开网关/SSE 转发。

本轮范围按 `/Users/a1/Documents/Codex/2026-09-27/g0-g7-acceptance-preparation/EMPLOYEE_TEAM_SCOPE_EXCEPTION.md` 收紧为固定配置目标的 Knowledge/SOP。下表中已交 selected/team 能力保留，但非目标员工切换、跨员工管理、team 目录/preview/写入、团队同步/提升及其扩展矩阵是**用户明确排除**，不计 PASS，也不阻本轮准入。固定 target 的公开路径、PEP、KB/document 归属、source 保护、draft content+ID+原 ETag/412、审批 wait/reload/continue/幂等和版本仍须实证。整合者在 server client 设置 `fixedTargetAgentId=<配置目标ID>`，adapter 仍显式传同一 target scope；SDK 对其他 agent/team 请求在传输前报 `PUBLIC_FIXED_TARGET_SCOPE_MISMATCH`，绝不转向 target。

## 固定操作表

相对 SD `/api/v1/`；路径参数由 SDK URI 编码，body 中 tenant/agent/actor 由 principal/path 决定，不接受调用方覆盖。下面权限列是 SD scope 的第一道门，原函数的 admin/owner/branch/resource PEP 仍执行。`202 APIJob` 会**持久化 draft**；`202 preview job` 使用原 transient stream job，**不写 APISOPDraft**。APIJob SSE 以 `id` / `Last-Event-ID` 恢复；preview 原 SSE 在 `data.seq` 中有序号，续流用 `after_seq`，不能凭空转成同一 ID 命名空间。

| SDK operation | Method + route | 输入 → 原响应 | Scope / 原边界 |
|---|---|---|---|
| `list_tools` | GET `agents/{agent}/tools` | 无 → `data[]` 掩码 | `tools:read`，scoped目录 |
| `list_general_skills` | GET `agents/{agent}/general-skills` | 无 → `data[]` | `skills:read`，scoped目录 |
| `list_knowledge_bases` | GET `agents/{agent}/knowledge-bases` | 无 → `data[]` | `knowledge:read`，员工 viewer PEP/可见 branch |
| `list_sops` | GET `agents/{agent}/sops` | 无 → `data[]/drafts[]` | `sops:read`，员工 viewer PEP/可见 branch 与已存 draft |
| `get_sop_draft` | GET `agents/{agent}/sops/{sop}/drafts/{draft}` | 原 sopId+draftId → 原 draft body 与 `ETag` header | `sops:read` + selected viewer/tenant/agent/draft 匹配；team 无 API draft，BLOCKED |
| `list_sop_versions` | GET `sops/{sop}/versions?agent_id={selected}`；team `team/sops/{sop}/versions` | sopId → `{data:[]}` | `sops:read` + selected viewer/原 branch 可见版本；team 由原 `agent_id=None` 读 |
| `get_sop_version` | GET `sops/{sop}/versions/{version}?agent_id={selected}`；team `team/sops/{sop}/versions/{version}` | sopId+精确 version → 原 SkillVersionRead | `sops:read` + selected viewer/原版本可见集合；不存在 404 |
| `create_sop_draft` | POST `agents/{agent}/sops` | `{content:完整SkillCard}` → 201 原 draft body+`ETag` | `sops:write` + selected manager；原 structured draft，不 publish；team 写 BLOCKED |
| `replace_sop_draft` | PUT `agents/{agent}/sops/{sop}?draft_id={draft}` | `{content:完整SkillCard}`、原 `etag` → 原 draft body+新 `ETag` | `sops:write` + selected manager/原 draft；SDK 精确 `If-Match`，缺失 428、旧值 412，不接受 latest ETag 救旧 content；team 写 BLOCKED |
| `publish_sop` | POST `sops/{sop}:publish?agent_id={selected}` | `{draft_id:原ID}` → `{sop,draft}` | `sops:publish` + selected manager/原 validate+owner publish；原路由未要求 `If-Match`，不得额外造第二次 publish；team 写 BLOCKED |
| `archive_sop` | POST `sops/{sop}:archive?agent_id={selected}` | sopId → 原 archived SkillRead | `sops:publish` + selected manager/原 archive；team 写 BLOCKED |
| `rollback_sop_version` | POST `sops/{sop}/versions/{version}:rollback?agent_id={selected}` | sopId+version → 201 新 draft body，body 内原 `etag` | `sops:write` + selected manager/原选定版本；创建草稿，不直接改 published；team 写 BLOCKED |
| `create_tool` | POST `agents/{agent}/tools` | 原 ToolCreate body → 掩码 tool | `tools:write`，原 owner/agent PEP |
| `update_tool` | PUT `agents/{agent}/tools/{tool}` | 原 ToolUpdate body → 掩码 tool | `tools:write`；拒绝 `********` 回写 |
| `test_tool` | POST `agents/{agent}/tools/{tool}:test` | 已存 tool ID+test body → 原结果 | `tools:test`；不代 unsaved probe |
| `import_general_skill` | POST `agents/{agent}/general-skills` | 原 import body → skill | `skills:write` |
| `publish_general_skill` | POST `agents/{agent}/general-skills/{slug}:publish` | slug → skill | `skills:write` |
| `archive_general_skill` | POST `agents/{agent}/general-skills/{slug}:archive` | slug → skill | `skills:write`；不代 Remove |
| `test_general_skill` | POST `agents/{agent}/general-skills/{slug}:test` | slug+body → 原结果 | `skills:test` |
| `generate_sop` | POST `agents/{agent}/sops:generate` | `title/raw_content/business_domain?/model_config_id?` → 202 APIJob | `sops:write`；成功结果是服务分配的持久 draft，不再 create |
| `rewrite_saved_sop` | POST `agents/{agent}/sops/{sop}:rewrite` | `instruction/target_paths?/model_config_id?/draft_id?` → 202 APIJob | `sops:write`；仅已存 draft/published，dirty/current_skill/conversation 直接拒绝 `PUBLIC_PREVIEW_REQUIRED` |
| `get_job` | GET `jobs/{job}` | job ID → APIJob | job kind 的 `sops:read` 等原 `_require_job_scope` |
| `get_job_result` | GET `jobs/{job}/result` | job ID → `{job,result,error}` | 同上；未终态原 409，不造结果 |
| `job_events` | GET `jobs/{job}/events` | job ID、`Last-Event-ID?` → 原 SSE id/event/data | 同上，AbortSignal 原传 |
| `cancel_job` | POST `jobs/{job}:cancel` | job ID → APIJob `cancel_requested`/原终态 | SOP job 仅账户 `sops:cancel`；不加 `jobs:cancel`，仍 `_owned_job` |
| `preview_generate_sop` | POST `agents/{agent}/sops:preview-generate` | 原 SkillDistillRequest 去 tenant/agent 后的 title/raw/context fields → 202 `{job_id}` | `sops:write` + 原 manager/模型上下文；transient，不创建 draft |
| `preview_rewrite_sop` | POST `agents/{agent}/sops/{sop}:preview-rewrite` | 原 current_skill/instruction/model_config_id/target_path/target_paths/target_label/conversation/available_tools/available_sops → 202 `{job_id}` | `sops:write` + 原 manager；path skill ID 必须等于 `current_skill.skill_id`，dirty 原样送模型，不偷 save |
| `get_preview_job` | GET `agents/{agent}/sop-preview-jobs/{job}` | preview ID → 原 job status/last_seq | `sops:read` + 原 tenant/user job owner；与 APIJob ID 分开 |
| `preview_job_events` | GET `agents/{agent}/sop-preview-jobs/{job}/events` | preview ID、`after_seq?` → 原 token/status SSE `data.seq` | `sops:read` + 原 job owner；不伪 `id`，decoder 另暴露真实 `sequence` |
| `cancel_preview_job` | POST `agents/{agent}/sop-preview-jobs/{job}:cancel` | preview ID → `cancel_requested` | 仅账户 `sops:cancel` + 原 tenant/user job owner |
| `move_to_draft_sop` | POST `agents/{agent}/sops/{sop}:move-to-draft` | SOP ID → SkillRead | `sops:write`，原 overall+admin、原对象改 draft；非 create{} |
| `remove_sop` | DELETE `agents/{agent}/sops/{sop}` | SOP ID → hidden/deleted | `sops:write`，原员工 branch+binding deleted、overall/admin语义；非 archive |
| `sync_sop_from_overall` | POST `agents/{agent}/sops/{sop}:sync-from-overall` | SOP ID → synced/head_version | `sops:write`，原员工管理+published trunk 限制 |
| `promote_sop_to_overall` | POST `agents/{agent}/sops/{sop}:promote-to-overall` | SOP ID → promoted/version | `sops:publish`，原 admin/branch/validate 限制 |
| `delete_sop_version` | DELETE `agents/{agent}/sops/{sop}/versions/{version}` | 精确 version → deleted | `sops:publish`，原 overall/admin+active version 409；非 rollback |
| `probe_unsaved_tool` | POST `agents/{agent}/tools:probe` | 原 ToolProbeRequest 去 tenant → ToolProbeResponse | `tools:test` + agent manager，未写工具；非已存 :test |
| `remove_tool` | DELETE `agents/{agent}/tools/{tool}` | tool ID → hidden/deleted | `tools:write`，原 branch/overall 管理；非 archive |
| `extract_sop_text` | POST `agents/{agent}/sops:extract-file` | `{filename,content_base64}` → `{filename,text}` | `sops:write` + manager，复用原 5MiB/类型/400/413，不建 KB |
| `list_model_catalog` | GET `agents/{agent}/model-catalog` | 无 → `data[]` id/name/model/provider/enabled/is_default | `sops:read` + agent view，只给元数据，无 key/base URL；实际有效模型仍须配置+modelwire |
| `list_handoff_users` | GET `agents/{agent}/handoff-users` | 无 → `data[]` 本地 web 用户最小 metadata | `agents:read` + agent view；外部 control identity source 无公开目录 reader 时明确 503，不回退 shadow rows |

`PUBLIC_OPERATION_CONTRACTS` / `PUBLIC_APPROVED_OPERATIONS` 是这张表的机器可读固定集合；默认客户端授权仍 `[]`。整合者以已验证 owner 给 server gateway `authorizedOperations` 赋**此集合的明确需要子集**，并为每个 operation 写固定 dispatch 与响应封套；不可把浏览器 operation、path、URL 作为任意代理透传。浏览器 adapter owner 仅消费经模块网关允许的方法与状态，不 import server-only helper。

## 当前所选 scope 的固定合同

`call(operation,input,{scope,signal})` 的 `scope` 为 `{kind:'agent',agentId:<当前所选员工ID>}` 或 `{kind:'team'}`。所有含 agent/team 路径的操作必须显式传；构造时的 `agentId` 仅留旧 Host 兼容，不得作为当前所选 scope 的默认值。无 scope 报 `PUBLIC_SELECTED_SCOPE_REQUIRED`，team 无等价 route 报 `PUBLIC_TEAM_PROTOCOL_UNAVAILABLE`，均不发请求。本轮固定目标模式再由 `fixedTargetAgentId` 拒绝任何非目标/team 显式 scope。`get_job/get_job_result/job_events/cancel_job` 以原 job ID 为范围，不借配置 target 造 agent；SD 仍依原 job tenant/credential/agent 与 namespace scope 检查。通用 SDK 的其他 selected 能力仅为已交保留，不要求本轮跨员工验收。

| 操作 | employee path | team path | 原 PEP |
|---|---|---|---|
| `list_tools` | `agents/{selected}/tools` | `team/tools` | 原 `list_tools(tenant,None,agent_id)` 可见资源；team 用 `agent_id=None`，只允许账户 key；工具凭据仍掩码 |
| `list_general_skills` | `agents/{selected}/general-skills` | `team/general-skills` | 原 `list_general_skills(tenant,db,agent_id)` 分支/团队可见集合；team 只允许账户 key |
| `list_knowledge_bases` | `agents/{selected}/knowledge-bases` | `team/knowledge-bases` | 原 `list_knowledge_bases(tenant,agent_id,db)`；员工入口还经过公开 Knowledge viewer PEP；team 只允许账户 key |
| `list_sops` | `agents/{selected}/sops` | `team/sops` | 原 `list_skills(tenant,db,agent_id)`；员工入口返回对应 API drafts 且显式 viewer PEP；team 的原语义无 API drafts，返回 `drafts:[]`，只允许账户 key |
| `list_sop_versions` / `get_sop_version` | 原 `/sops/{sop}/versions...` 携 `agent_id={selected}` | `team/sops/{sop}/versions...` | 原 `list_skill_versions(..., agent_id)` 的分支/整体可见集合；team 用 `None`、账户 key |
| `preview_generate_sop` / `preview_rewrite_sop` | `agents/{selected}/...` | `team/...` | 原 SkillDistill/RewriteRequest 的 `agent_id` 为 selected 或 `None`；原 owner manager/模型上下文/tenant、path SOP ID 校验不变，current_skill/conversation/target_path(s)/label 原样送 transient job |
| `get_preview_job` / `preview_job_events` / `cancel_preview_job` | `agents/{selected}/sop-preview-jobs/...` | `team/sop-preview-jobs/...` | 原 tenant+actor job owner，facade 再校验 job 创建时的 selected/team 绑定；cancel 仅账户 `sops:cancel` |
| 其他 agent 路径操作 | `agents/{selected}/...` | **BLOCKED** | 按表中原资源 PEP；team 没有已审等价公开 route，不能落回配置 target |

`list_knowledge_bases` 与 `list_sops` 是第 31、32 项，随后增加上表 8 项管理原语和下文 11 项固定目标 Knowledge 原语，再补 16 项全文、bucket/chunk、concept、export、discovery/job 原语，共 67 项固定 operation。team 仅覆盖四类读目录、SOP 版本读与 transient preview；team API draft/写入仍逐项 BLOCKED。`.d.mts` 的 `PublicOperationOutput` 对目录、draft、job、preview acceptance/status/cancel、Knowledge job/discovery/export 给结构类型；其余原 owner 响应保持 `PublicRecord`，SSE body 保持 `unknown` 并由两个 decoder 解析。`call` 返回值还包含原非 2xx 错误 body，调用方先按 status 分支；headers/ETag 原样保留。`replace_sop_draft` 必须拿当前选中 draft 的原 etag 作精确 `If-Match`；其他管理操作沿原路由的条件语义，不能用新 ETag 覆盖旧编辑内容。

## Knowledge PEP 与范围收紧

SD 新增 `public_api/knowledge_pep.py`，在既有 `resources.py` 的 13 个公开 Knowledge 路由（含两个调用对应 update 函数的 archive 入口）显式调用原 `require_agent_scope_viewer` 或 `ensure_agent_scope_manager`，加 `ensure_public_agent`、路径 KB 的可见分支/版本核验；文档更新另核 document ID 确属路径 KB。原 enterprise route 的 `Depends` 在直接调用 Python 函数时不会自行执行，故显式补回。create/update/search/rollback 的 body tenant/agent/KB 覆盖被拒，upload/ingest 先过范围门，原异步 worker 仍用原 actor/credential。聚焦 HTTP 用例覆盖非 owner 403 与 owner 200；这只证明本地 PEP 回归。固定目标 KB/document 归属与 source 防误写仍待完整候选实证；team/非目标扩展证据按用户例外排除。

固定目标 Knowledge 公共 route 除目录外新增以下 **server SDK 规划合同**；默认授权仍空，公共 modules.js/adapter 的真实分派尚未接通。路径均以 `agents/{target}/knowledge-bases` 为根，body 只含原 owner 字段，tenant/agent/actor 从 principal/path 取得。SD 入口先执行固定目标 viewer/manager、KB 可见 branch，文档更新另校验 document 属于路径 KB；本批修正了该更新对原 owner 的 `agent_id` 传参，避免误走 overall source。SDK 仍未将上传文件转成 entries 或把 archive 当 Remove。

| SDK operation | Method + suffix | 输入 → 原响应 | scope / 条件 |
|---|---|---|---|
| `create_knowledge_base` | POST 根 | `{body:{name,description?,capability_scope?,metadata?}}` → KnowledgeBaseRead | `knowledge:write` + manager |
| `update_knowledge_base` | PATCH `/{base}` | `{knowledgeBaseId,body}` → KnowledgeBaseRead | `knowledge:write` + manager + KB branch |
| `archive_knowledge_base` | POST `/{base}:archive` | `{knowledgeBaseId}` → KnowledgeBaseRead | `knowledge:write` + manager + 原 archive |
| `search_knowledge_base` | POST `/{base}:search` | `{knowledgeBaseId,body:{query,...}}` → 原 search/evidence | `knowledge:read` + viewer，path base 唯一授权集合 |
| `upsert_knowledge_entries` | POST `/{base}/entries` | `{knowledgeBaseId,body:{entries},idempotencyKey?}` → 202 APIJob | `knowledge:write` + manager；原 Idempotency-Key、job result/事件仍走全局 APIJob |
| `list_knowledge_versions` | GET `/{base}/versions` | `{knowledgeBaseId}` → `{data:[]}` | `knowledge:read` + viewer/可见 branch |
| `rollback_knowledge_base` | POST `/{base}:rollback` | `{knowledgeBaseId,version}` → 原 rollback result | `knowledge:publish` + manager/原 version 规则 |
| `list_knowledge_documents` | GET `/{base}/documents` | `{knowledgeBaseId}` → `{data:[],next_cursor:null}` | `knowledge:read` + viewer/当前可见 version |
| `update_knowledge_document` | PATCH `/{base}/documents/{document}` | `{knowledgeBaseId,documentId,body:{content_md?,expected_updated_at?,...}}` → KnowledgeDocumentRead | `knowledge:write` + manager/KB/document 归属；原 `expected_updated_at` 如提供，冲突原 409，不改写为 SOP 412 |
| `archive_knowledge_document` | POST `/{base}/documents/{document}:archive` | 两 ID → KnowledgeDocumentRead | `knowledge:write` + manager/KB/document 归属及原 archive |
| `list_knowledge_concepts` | GET `/{base}/concepts` | `{knowledgeBaseId}` → `{data:[]}` | `knowledge:read` + viewer/KB branch |

multipart 文档上传的固定 target facade 保持原 HTTP `200` 与 `KnowledgeIngestJobRead`（`id/status/knowledge_base_id/document_id/filename/stage/progress/...`）响应；SDK 不把它伪装成 `202` accepted-job，后续 job 状态仍由 Knowledge ingest owner 的 job routes 提供。OKF import、单文档详情、bucket/chunk、concept 详情/编辑/export、discovery/job 视图现已有固定 target facade 与 SDK planner；JSON gateway 仍须由 modules.js owner 接入，不能把 upload 改成 entries。真实 source 防误写、原文归属、job/discovery PEP 与拒绝证据仍需完整候选验证。团队/跨员工深层操作是用户范围排除；67 项 planner 测试/类型不代真实业务结果。

## PilotDeck 宿主 Port/provider 边界

按 `PILOTDECK_HOST_CAPABILITY_DECISION.md`，工具/通用技能目录、模型配置与调用、文件解析、任务提交和事件流的通用执行入口归 PilotDeck 公共 Port/provider；modules.js 只注入这些既有 provider，并把固定 operation 的请求、响应、headers、AbortSignal 和真实事件流交给 adapter。SD facade 不创建第二套工具/模型/解析目录，也不 import PilotDeck 私有 backend、数据库或 AgentLoop 类。`list_tools`、`list_general_skills`、`list_model_catalog` 等 SDK 条目只描述已授权的领域公开读取；模型元数据不能证明实际生效配置。

Knowledge/SOP 的领域状态、版本、owner、权限、ETag、审批和 job/discovery 语义仍由 SD 原 owner 与公开 route 负责。`BackgroundTaskPort` 只表示宿主后台执行能力，不等价于 Knowledge ingest、APIJob 或 transient preview；缺少同语义 provider 时保留准确阻塞码，不把后台 task 或近似 operation 当成成功。文件解析和事件流接线沿既有 Port 合同完成，不能在 facade 层反向双写、伪造 token/sequence 或改变 draft/source 生命周期。

## 本批校验与剩余具体边界

- SD 新 facade 固定方法、selected/team 与原 viewer/manager PEP、dirty preview、draft ETag 原条件写入：本批 13 个聚焦测试通过（12 个本线 facade/PEP 与 1 个既有 SOP 生命周期）；完整 G4/G5 业务未运行。
- PD 旧真实目录/job/SSE/error 测试及新固定路由/selected scope/固定 target 拒绝、dirty preview/preview `data.seq`、draft `If-Match`：13/13 聚焦 node:test 通过；上一提交 `.d.mts` 单文件 typecheck 通过，本次类型增量尚未重跑。不得由这些测试声称 runtime pin、真实模型或浏览器已接入。
- 外部 control identity source 的 handoff **枚举**目录仍无可供账户 key 调用的正式 reader，facade 给 `USER_DIRECTORY_UNAVAILABLE` 503；若只服务本轮排除的员工/team 选择器，不阻固定目标候选。固定目标已有 `assignee_user_id` 的 SOP 在保存/发布时会经原 `_validate_handoff_assignees → resolve_members → require_internal_member` 校验：外部 control provider 必须提供 `resolve_members(tenant_id, ids)` 和 `member_identity_source`，否则明确 503 `MEMBER_DIRECTORY_UNAVAILABLE`/`MEMBER_DIRECTORY_INVALID`，这是正常审批路径的真实核心阻塞，不能用本地 shadow 用户或换控制 token 绕过。该 reader 的存在、配置处理人可解析及 wait/reload/continue/幂等仍需同一完整候选证据。
- 固定目标 Knowledge 的 KB/document 归属、source 不误写尚未在完整候选运行验证，仍 NOT RUN；team/非目标扩展不再作为准入项。`preview` 采用原 transient stream job 存储，facade 另将原 job ID 绑定创建时的 agent path；服务重启后其 in-memory job 不支持恢复，保持原语义，不将其映射到持久 APIJob。实际模型配置与 `model_for_agent` 仍需下一完整 candidate 证明。
- 整合者接入 PD modules.js 和 adapter 固定公开响应/stream，串行 build/typecheck 后统一一个 cleanpair；独立验收 G0–G7 不因本批代码自动升 PASS。无 push/merge/deploy、AgentLoop/core/PEP 策略修改。
