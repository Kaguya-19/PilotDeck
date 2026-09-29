# 固定审批主体集中交付（生产入口尚待整合）

PD 本线 parent 974c4ee7（3文件已整合至6ce7937a），共享domain文件与固定fb3c3b77一致；SD本线parent2da6f276，新提交56c6fb60d9042fbfa3ca86c79ad6ea576f0725da。两树按APPROVAL_OWNER_HANDOFF_20260928.md分配修改，未写整合root/HTTP/RPC/adapter/native chat.py。只交窄diff，不旧parent整文件覆盖。

## 实装及DTO

- `StaffDeckApprovalAuthority`: `{tenantId,sessionId,subject:{tenantId,userId,source:'web',role:'admin'|'member',disabled}}`。它是认证root核原session访问后创建的内部值，**不得把浏览器/RPC body.authority直接透传**。domain只能验证内部值的一致性，无法凭类型认证请求来源。
- `StaffDeckPinnedApproval`: `{waitId,revision,skillId,version,nodeId,assigneeUserId}`。从原session持久bundle解析同active skill/step；不读取最新definition，不用default SOP或部署审批人覆盖node。原status附`approval`；缺pin/assignee附`approvalError`，原status/state/wait仍可读取，resume精确拒绝。
- human resume在原session lock内重新解析pin、核subject/session/tenant与原wait/revision；保SD原规则：admin可回复，member须等于node assignee。不推断缺assignee规则；缺失返回SOP_APPROVAL_ASSIGNEE_REQUIRED。
- 授权事实只附原`resumeRequests[requestId].authorization`（authority、pinned approval、原expectedRevision），没有第二store。duplicate仍每次重新认证；锁内核原主体、revision、wait/source/message/slotUpdates，返回原receipt/revision。旧无授权事实记录返回SOP_APPROVAL_LEGACY_RECEIPT，不补造证明。external_task不能冒充human，原external_task链不改。
- 原control.resume传内部authority给store，不修改transition/AgentLoop。subject字段不是新的客户端审批参数。

## 正常认证与重放输入

`createFixedApprovalAuthority(...).authenticate({bearer,signal})`调用审批人的正常SD `/api/auth/me`，返回带disabled的subject。固定native部署核实际tenant/approver/source/role/disabled；body/目录/APIkey不提供身份。

`authorize`现在可接原`{sessionKey,waitId,requestId,message,expectedRevision}`及审批Bearer，**不再GET当前pending wait或先核当前revision**。根入口仍必须认证session mapping，然后提交原command与内部authority到control.resume。首次和重放走同认证链；是否duplicate只由原resumeRequests决定。

## SD公共router/真实HTTP client

新增`backend/app/public_api/pilotdeck_approvals.py`，public app include router：

- `GET /api/v1/pilotdeck/approvals/{session_key}`，正常SD用户Bearer；只取显式mapped session，不扫描全局wait。
- `POST /api/v1/pilotdeck/approvals/reply`，`{session_key,request_id,wait_id,expected_revision,message}`；extra字段（subject/tenant/assignee等）拒绝。无pending preflight，因此可重放已提交request。
- `PilotDeckApprovalClient(origin,bridge_token,tenant_id,agent_id)`由SD服务root绑定至`public_app.state.pilotdeck_approval_client`。这是实际httpx transport，不是空接口；每请求固定tenant/target。根认证与原session mapping仍由PD owner处理。
- client向PD `POST /api/module-host/approvals/{status,resume}`发原camelCase command；`Authorization: Bearer <service token>`仅认证SD服务，`X-StaffDeck-Approver-Authorization: Bearer <审批人的正常SD token>`分开输送并由PD再核current-user。原HTTP失败status/body保留，不跟redirect、不写SD handoff，不自动continue。

这些**PD bridge路径是本批交整合实现的具体消费合同，目前未装配，不能称已存在生产route**。bridge service token只能由正常部署凭据取得，不造token；若根现有认证不支持服务主体，应集中反馈准确auth差异，不能关闭认证。

## 整合唯一owner须消费的窄hunk

1. 现有`/api/sop/resume`与`sop_resume`RPC所有human入口均先验证正常PDuser/session访问与SD审批Bearer，再创建内部authority；旧入口不能透传caller authority绕过。原external_task权限独立，不能拿external source绕human wait。
2. 同session权威mapping须核PD原session归属、固定SDtenant/target；SD端`ExternalSessionBinding.external_session_id`是原外部关联值，不能在未证明它是PD sessionKey时直接推导或借目录补ACL。本批未假定缺失mapping存在。
3. public app root注入上述HTTP client；PD root新增两条service桥，认证service及原审批Bearer，同wait/pin/revision请求交control。GET也须主体与session核验后才投影；不通过只核tenant扫全局状态。
4. 两Host UI只注入同public status/reply consumer，不改SD native handoff inbox/filter/reply；原continue是独立用户动作。

共享路径已按授权裁定实现domain本线，无需重新批权限。服务桥、root、RPC与UI仍原owner消费；若原session没有足够跨Host绑定，此缺失是准确接线依赖，不新造影子session/state或扩审批权限。

## 验证及剩余范围

PD Node22.23.1聚焦7/7通过：pinned node、清wait后duplicate原receipt、错误subject/session/tenant/source与冲突拒绝、正常current-user认证、原401、无pending重放。SD正常venv pytest4/4：实HTTP client header隔离、原owner403、extra主体拒绝、router错tenant零transport。两树diff --check通过。均为聚焦自验，不是完整候选业务PASS。

19项实际provider、领域模型/文件/任务Python DI、有效七槽profile仍是原集中任务未完成项；本批router仅approval DI，不冒称全部领域DI。旧91cffab2通用caller-method wrapper不算实际provider。未运行模型/审批业务、pin/new-old/wait continue；没有占位有效profile，无push/merge/部署或新轮。
