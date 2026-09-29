# 2026-09-28 最小链路公共整合交付

现行范围：[用户已接受的最小链路](/Users/a1/Documents/Codex/2026-09-27/g0-g7-acceptance-preparation/DELIVERY_SCOPE_OPTION_20260928.md)。完整领域分析引用原 owner DELIVERY；本文件只记录公共接线/构建和跨线差异。业务均 NOT RUN，不称有限版本跑通或原 G0–G7 全通过。

## 已接固定实现

| 固定源 | 本树应用与行为 |
|---|---|
| public PD8d51cdc8 | 19ae167b；91aed706 在 createLocalGateway registry 当前 generation 绑定同 ModelRuntime 的 prepare/stream、真实 catalog available/default selection及 UTF-8 txt/md file_parse。没有第二模型、目录、任务或新造session权限context |
| adapter PD71e63fc8 / ccc4be6a | 6e9392d4 / 36463da3；保原 FormData/AbortSignal/status/raw error和Knowledge ingest namespace，canonical无KB上传走具名auto，而非猜KB/拆create+upload |
| public SD56a457 / 8ad463 / 97a990 / 0d20209 | SD efb6 / a748 / a4af / ee91；public ingest调用PD parser，public检索和ingest不取第二SD默认模型；auto-upload一次原owner创建private KB/version/native ingest。worker再核active credential与原target PEP，内部来源不进入KB/doc/source/native metadata |
| public SDK8aec0975 | 43c92d26；新具名upload_knowledge_document_auto planner，原200 KnowledgeIngestJobRead合同 |
| 公共网关4496af69 | /api/modules/staffdeck-sdk/file allowlist具名auto，保原bytes/title/capability_scope/200/body/headers/signal，无任意代理；原JSON入口拒文件伪装 |
| SD root c762495c | 显式部署bind_pilotdeck_domain_client，正常Gatewaytokenpath/origin/response-derived PDuser/exact tenant/actor/target；缺配置启用失败，wrongtuple在transport前拒绝 |
| 绑定准备91aed706 / 293a3250 | 允许同时省略延期approver响应；仍核fresh actor/PDuser/target/owned credential；部分env/configPatch不冒有效profile，正常部署token不mint、不复制 |
| public SDd7f33288 / PD61cac7fc | SD1383e39a / PD17691edb；正常Knowledge query使用账户Bearer、原PEP、public_host_retrieval与正式module envelope，PD凭credentialEnv只从server进程取账户key；旧无认证module路径不作有限版绑定 |
| 整合PD3aadf223 / b3e8d441 / 88d84c29 | 私有profile组合把准备好的copy、management、discovery与public limited renderer合一；target/key/bundle不一致及相对bundle路径拒绝。compiled-tree profile测试路径修正，不改生产协议 |
| adapter f858ddb2 | 固定[Knowledge查询consumer处置](minimum-knowledge-query-consumer-delivery-20260928.md)：正常对话的认证module读已由后续public合同接通；正式Knowledge页单KB检索仍把自动选择的PD `model_config_id`传给当前拒绝此字段的SD public search。结构化响应/引用投影无需改，输入模型绑定尚未闭合 |
| public PD35bbd45a | 本树已接[浏览器模型选择合同](browser-knowledge-model-selection-delivery-20260928.md)及公共route：SDK用同一已认证Gateway/selected Host Port的catalog校验唯一可用默认`provider/model`；非2xx Host响应保原status/body，成功检索的`host_model_selection`写回浏览器JSON。SD原词法检索、PEP和evidence/citations不变 |
| adapter PD123f0271 | 本树已接[正式页面模型输入映射](browser-knowledge-model-selection-adapter-delivery-20260928.md)：单KB搜索把页面所选PD ID移到外层`selectedPdModelId`，SD body保留原查询过滤但不含`model_config_id`；空值和陈旧值交SDK原样拒绝，不选择替代模型 |
| public PD e9e3e69f / 21a5e0ad，SD 3820a9b0 / 8e476b64 | [Fresh3 SOP route 原件](fresh3-sop-route-pd-model-delivery-20260928.md)：PD discovery 明传`model_source: pilotdeck_host`，追加测试核同一catalog/stream模型；SD 保原可见SOP/PEP与TurnPlanner校验，借既有服务端Gateway Port调用当前`list_model_catalog`/`model_stream`，多个可用模型在stream前拒绝。整合SD启动继续使用已存在的`bind_pilotdeck_domain_client`和同一正式URL/token/PD用户；`FixedPilotDeckDomainHostClient.plan_sop_route`校验固定tenant/actor/target，不作第二次无scope绑定 |
| Fresh5 P3 整合 profile 守卫 | `compose-limited-staffdeck-profile.mjs` 拒绝把 SOP runtime origin 配成 SD API origin；CLI及导出的 `composeVerifiedLimitedStaffDeckProfile` 写出 enabled profile 前实际 GET runtime `/healthz`，核 `sop.runtime`、`sop.lifecycle/v2`、协议`2.0`和`prepare/submit`声明。独立准备程序须调用此 verified 入口或CLI，不能仅调用纯配置函数。discovery/management 仍用 SD `/api/v1`，bundle/默认SOP不变。此 guard 阻止 fresh5 误指址，实际 portable runtime 启动与操作仍待新隔离验证 |

同源校验：SD packages/staffdeck-business-ui 与 PD vendor @staffdeck/business-ui 0.1.13 **41个canonical源逐字一致**，manifest无差异；本批无canonical、lock、vendor实现改写。

## 当前必要差异

1. 认证Knowledge源码合同已接，实际PD账户key、原PEP、文档引用和正常模型回答尚未在新进程中观察。SD facade当前只广告`query`；旧`resolve_citation`与高级管理按最小范围不冒等价能力。原模型回答中的citation须由同次查询结果验证。
2. limited renderer和私有binding组合已接；实际enabled profile须等独立fresh正式身份、账户key、原生无审批已发布bundle、模型环境取得后写入并由Gateway启动选中。native-five原占位endpoint与approval示例不作为本轮profile。未观察启动/manifest/模型配置前不称effective。
3. root暂未广告tools.list，其工具执行/管理合同仍由原public provider owner承接；若最小SOP编辑需要目录，须原runtime.tools.list的准确descriptor固定投影。工具不可执行不伪装probe/create，保同真源；最小链路未使用操作按用户延期，非PASS。
4. K3正式Knowledge页单KB输入、SDK模型校验、公共route和原SD词法检索在源码上已接通。实际启用profile后的页面查询、返回引用及正常对话模型引用仍NOT RUN；无单KB选择或多KB搜索不计本轮单文档映射PASS。空/陈旧模型和不可用默认值会在SD请求前明确失败，不自动替换。
5. Fresh3首个真实FAIL为SD`sops:route`查SD默认模型导致409；本pair的显式PD模型源修复已接源码和构建，尚无新隔离模型调用。`PUBLIC_HOST_SOP_ROUTE_UNAVAILABLE`、模型/流异常必须保持真实失败，不回退SD默认、不关闭discovery。公开owner的较宽mocked discovery-routing用例仍报`SOP_STEP_RESULT_REQUIRED`，未归因或迁成此修复PASS。

员工/team扩展USER EXCLUDED；审批和高级管理USER DEFERRED。既有固定consumer/router/源码/失败保留。没有正常approver reader/admitted mapping时human mount禁提交，旧直接human resume不恢复；external_task仍沿原路。审批输入不再作为首轮前置。领域ETag/412、版本/PEP/正常合法分支规则不变。

## 聚焦检查与串行构建

原始证据集中目录 `/Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake`：

- `minimum-upload-consumer-tests.log`：browser file client、Knowledge Host和同源SDK gateway，38/38（聚焦consumer与transport，不是业务PASS）。
- `minimum-sdk-tests.log`：具名SDK planner14/14。
- `minimum-domain-binding-tests.log`：SD正式root binding/domain/auto owner12/12；native原metadata不构成public来源。
- 准备/私有组合8/8；active model/text Port5/5已通过。新增gateway测试最初fixture漏SOP管理scope得到403，补齐fixture后17/17；未减少生产身份guard。
- 新SD public read pytest3/3；PD Knowledge transport/profile4/4。第一次在`dist`运行profile测试因standalone `.mjs`未复制到`dist`报`ERR_MODULE_NOT_FOUND`；b3e8d441让测试按工作树资源路径读取，修后4/4。
- public模型选择SDK Node测试16/16；公共route Vitest18/18（含同一principal/catalog、原Host 422、错配前置拒绝及成功receipt）。这些为源码聚焦检查，非浏览器/模型业务PASS。
- 接公共route后PD根TypeScript `--noEmit`、UI TypeScript `--noEmit`和Vite build串行通过；Vite仍有既有CSS/大chunk告警，不影响构建。SD本批无源码改动，其既有构建结果沿用。
- 接adapter页面映射后，Knowledge Host与公共route聚焦合计33/33、UI TypeScript `--noEmit`、Vite build通过；根TypeScript与SD源码未因本批改变，沿用前述检查。仍无真实页面或模型业务采证。
- Fresh3修复接入后PD根`tsc -p tsconfig.json`、PD UI typecheck/Vite通过；PD discovery/active-model聚焦4/4、Host远程/route聚焦8/8。SD route/host/fixed启动绑定pytest 7/7；SD frontend用`package-lock.json`锁定安装后`tsc -b`/Vite通过。首次在无依赖树执行SD typecheck因缺包失败；该环境问题不记产品FAIL。较宽PD mocked discovery-routing单用例仍FAIL `SOP_STEP_RESULT_REQUIRED`，原错误保留为已知测试缺口。以上都不是新fresh业务证据。
- Fresh3追加提交：PD native catalog/stream一致性测试在整合树1/1，根`tsc --noEmit`通过；公开owner SD route/host/ingest聚焦14/14。整合SD树的新增Python文件语法检查通过；本地未装pytest依赖，未在整合树复跑14项。唯一可用模型守卫和固定身份绑定已合入，实际Gateway模型与业务仍NOT RUN。
- Fresh5 P3 配置守卫聚焦2/2：错址、正确manifest、404与假200无合同均覆盖。此测试注入本地响应，证明配置逻辑；真实portable runtime的健康与`prepare/submit`需新隔离进程采证。
- 当前PD b3e8d441 根tsc emit、前端typecheck/Vite均通过；另用limited renderer的离线fixture生成enabled入口后再跑前端typecheck/Vite，随后恢复原generated文件。fixture构建只证注册与打包，不证实际endpoint/model/key。
- 当前SD1383e39a frontend tsc-b/Vite通过；仅借既有dependency路径，未运行install、未改锁，临时link已删除。Vite体积告警；PD CSS minify亦有既有warning，未导致构建失败。

此前冻结refs保存在[MINIMUM_SOURCE_FREEZE.json](/Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/MINIMUM_SOURCE_FREEZE.json)，保持 `candidateReady:false`，不再指令验收重启旧根。最新待准入双源及缺口集中于[NEXT_MINIMUM_CANDIDATE_ADMISSION.json](/Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/NEXT_MINIMUM_CANDIDATE_ADMISSION.json)。源码与跨线准入结论见[DEPENDENCY_CLOSURE.md](/Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/DEPENDENCY_CLOSURE.md)。旧CLEANPAIR.json/原始失败保持。无push/merge/deploy/archive。

## runtime-6/7 后的窄整合

- public SD `2f1dcd28` 已窄接为 `23d9319d`：只改原 PD host SOP route candidate 执行和定向测试，复用 `LLMClient.generate_json` 的原 JSON/schema repair。没有改已固定 `pilotdeck_domain_binding.py` 或启动 root；不证明此前缺 problem body 的 K3 503 子因。整合树用现有依赖解释器执行 controlled portable/host/public-route 三文件，17/17通过，无模型业务调用。
- public PD `4601344a` / `1814a420` 已接为 `f899b67c` / `d69f40ca`：[owner 原件](runtime6-runtime7-public-handoff-20260928.md)与[portable/profile supplement](runtime6-runtime7-profile-focused-evidence-20260928.json)。8a03 verified CLI及短时真实portable manifest/prepare/submit已验证，进程已停；fixture身份/模型与这些协议结果不作部署或业务PASS。
- 新共享[启动工具](minimum-startup-admission-20260928.md)保单一bootstrap/enabled认证DB，门禁Harness产物、verified tuple/profile、实际portable manifest、本轮Gatewaytoken、认证describe/catalog和同profile唯一默认模型；拒绝时不启动SD命令，保原非2xx body。它不运行stream、不声称SD DI生效，生成的准备receipt始终`candidateReady:false`。18/18 focused通过，PD根TypeScript emit通过；本批无frontend/canonical/vendor/lock代码变化，不重复UI构建。实际enabled profile构建仍是新进程准入项。
- runtime-6/7已封存并idle；当前尚缺下一进程真实Gateway auth/describe/catalog/stream、fixed SD DI响应及selected Port证据。准入前只可准备这些输入，不通知独立重启或运行旧root。Fresh5 K3仍记discovery503，P3按原raw记health404，UI/adapter无此次hunk；无K3/P3浏览器AX/DOM原件不签页面操作PASS。shared validator/native覆盖仍沿原owner固定交付，active public Port的400不能代该覆盖。
