# 同一集中任务的完整处置表：D01–D18 / C01–C04

2026-09-27。交付根目录：`/Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake`。唯一整合入口 01a0e240-e9c4-76b0-991e-a2144273b08c。最终双 clean refs、parents、目录和复核命令见交付根目录 DELIVERY.md；这是全部已交源成果和未闭合项的一次 cleanpair 交付，不是全部功能 PASS，不启动独立业务轮。

权威仍为 `/Users/a1/Desktop/claw/openbmb/PilotDeck/STAFFDECK_FRONTEND_ACCEPTANCE_GATE.md`，唯一运行清单仍为准备目录 `EVIDENCE_MATRIX.md`。本表补完整源码处置，不替换矩阵、不新建验收轮、不修改旧 state/raw。历史 G1/G2 FAIL；G0/G3/G4/G5/G6/G7 NOT RUN。新 pair 尚未独立核验，不能把本地 build/mock/DOM PASS 迁移为 gate PASS。

## 来源与唯一 owner

| 范围 | 唯一 owner 与本次固定成果 | 整合边界 |
|---|---|---|
| UI 原 0.1.13 WIP | UI 01a0e22b-7b86-7161-ac30-746b44a0b269；SD972f38 / PDce837 固化快照 | 原 primitive/graph/Markdown/layout/三Page/三Host 保留；旧 dirty 树未覆盖。 |
| UI 接续 | SD32b87446 → 674821da → be3b7a4163a5d8b953cf72cb54f20693af3fa860 → 332387195761d6a973a112fddf522874ecb91eed；PDd77691af → e53589cbf385e23023fda0d422734bb23eb5dd34 | 实际 ref、Progress/Tooltip、用户内容、图谱标签、selected draft publish query。独占 canonical 呈现源码，PD vendor 只由整合者同步。 |
| adapter/context | 01a0e22b-8565-7db3-92f3-cc4b2f8eef6f；a7518c10 → 3fa7b145 → 1524821d → 8e8d5cdf → d29e9a34 → e56bcdf3c199255b969d38ba4f398ba99f405ad9 | clients、宿主 adapters/copy-scope、请求/响应/snapshot/notify；原 PD 六文件和 SD 两文件 WIP 按 patch 保留。common helpers 单源由整合者放置。 |
| 公开/runtime | 01a0e22b-681f-7213-8475-a510215540f5；4319eadd → e8a53ad955e023238f8a2127be436cdce9316209 | 独立 server-only 能力/runtime/readiness helpers；不直接双写 adapter/route。 |
| 公共/集中接线 | 整合者 | modules.js、身份/abort公共桥、Gateway/receipt、Toast warning、runtime mounted observer/provider/状态面板、canonical/vendor/依赖/构建/处置表。clients/adapter只加已交 e56 上的窄 runtime callback hunk；不改变其余唯一 owner。 |

原件位于交付根目录 `ui-wip-handoff/`、`adapter-wip-handoff/`、`public-boundary-delivery/`。只读取上述固定 clean 提交；执行线当前目录与原在途树未修改。332 的 typed mock 修正、原 gallery mounted hook 测试修正、真实 canonical 类型解析和普通 native 参数类型桥由整合者完成；没有替换业务权限数据或扩大 policy。

## 完整处置（源码、定向证据、未闭合项分别列出）

“已接源码”只描述具体实现；表末状态针对该组完整证据，不能从几个测试推为全部 props/API/UI PASS。

| ID | 已接源码与可复核路径 | 定向证据 | 完整项当前状态、剩余与 owner |
|---|---|---|---|
| D01 | canonical FormalHostPrimitives、三 Host/三 Page 及 PD formal-primitives/Dialog ports，Distill 工厂实际注入 components；原 Escape preventDefault 保留；Host 状态按挂载隔离。 | 已交 Dialog/Portal/Host 测试，sd-changed-consumer-tests 与旧 mounted 日志。 | NOT RUN：全部 Dialog controlledClose/ref/focus/aria/尺寸合同尚无完整双 Host 签证。UI owner 对全部原 props 负责；独立 S03 需核实际消费者。 |
| D02 | 原 Radix primitive 机械 port；SD native与PD宿主 Input/Textarea forwardRef；实际全屏 button ref；原 icons 按注入来源保留。 | UI ref/Page/Portal 7 项及 PD primitive/locale、呈现日志；e535实际primitive4 PASS，覆盖Input/Textarea DOM ref、Progress aria、Checkbox mixed/disabled、Dialog ref/asChild/Portal/autofocus/preventEscape/首次Close、Select键盘/disabled/焦点。 | NOT RUN：本次关闭上列具体primitive/ref定向证据缺口；Dropdown/Popover/Tooltip/Accordion生产调用、Footer showCloseButton与Confirm loading的实际Host调用、全部注册/三Host注入仍需完整核验。未用样本数代 111 项。 |
| D03 | Formal Scope Loading/Badge/Control、StatCard、DetailField/StatusBadge/Paginator；内部 TooltipProvider；两宿主 Progress 将 value 传真实 Radix Root。 | SD/PD 实际呈现各3 PASS；App/Host 生产模块图。 | NOT RUN：全 AppHeader slots、Models/UISelect、每个 tone/class/label/value 合同和双 Host 实际主题未完整采集。UI owner；非权限阻塞。 |
| D04 | 原 enterprise graph 入口 reexport canonical FormalKnowledgeGraphVisualization/Model；两 build 均实际包含主 graph/cytoscape 源。新增 graph 资源名/说明 translate=no 边界。 | 原 owner renderer/model13 PASS；本次改 renderer 测试实际经过 canonical，SD changed 记录。 | NOT RUN：双 Host 真实节点编辑/保存/重载及主题/交互仍无业务 raw。主 renderer 源复用不以 ViewAll 小 canvas 代替。 |
| D05 | FormalKnowledgeLayout/Presentation、Knowledge 局部样式和原 block/inline/table/code/image Markdown 源；native Markdown 与 PD Host 指向同源。 | 两生产模块图包含 FormalMarkdown；mounted 多实例消费者测试。 | NOT RUN：完整原 Markdown 内容、布局/响应式/深浅色 DOM/PNG 尚未逐项闭合。UI owner保原样式；不复制私有整份全局 CSS。 |
| D06 | 原 ConfirmDialog/ResourceImportDialog 及正式 Button/Select/Checkbox ports保留，使用共享业务 renderer。 | 已交 Import Portal/真实复制选择、ref与呈现测试；本次 gallery-copy2 PASS。 | NOT RUN：loading 时两按钮禁用/阻关闭和完整 import/confirm 键盘合同需双 Host 核验；不以源码保留签真实动作。 |
| D07 | SopVersionDetailDialog 正式源、原 primitive 和关闭语义保留，用户名称/版本/业务域/正文边界已接。 | UI actual Dialog/Page tests与来源32；SD build。 | NOT RUN：全部版本/关闭/ref/受控状态合同在新 pair 的真实 UI/持久化证据未运行。旧详情/Close有限 PASS只属原 refs。 |
| D08 | 三 canonical Host 无 module activeHost；per-mounted copy context/目录/target/tenant，editor bootstrap与卸载取消；public GET返回经核 tenant/actor/agent；旧 storage/cache key保留。 | 多实例 Host、copy/bootstrap/abort、实际 HTTP身份变更聚焦日志。 | NOT RUN：真实 cache/dirty/同ETag/多窗口/browser隔离未采；team/非target原可见范围依赖D18，不能由默认target策略代签。adapter/公共已接，不再等待tenant/mountedHost交接。 |
| D09 | FormalApiError 单源原构造(status,rawBody,statusText)与 status/code/body/class判别；get/postWithSignal到真实 browser fetch；request-local server signal贯穿身份/凭据/业务请求并finally dispose。 | final-runtime-adapter36、Knowledge12、既有 request/helper/actual HTTP abort日志；真实 pending copy fetch abort。 | NOT RUN：真实 upstream服务终止和全部原错误/异步UI采集未运行；本地HTTP替身不能签 live cancellation。无silent retry/404create救援。 |
| D10 | FormalHostContractHelpers由固定native4lib+scope规范化提取，Host/native旧lib/PD leaf reexport；catalog/focus/pageshow/visibility、handofftrim/web/null、team存储、clipboard fallback保原；focus先于DOMranges恢复；cn使用原clsx/tailwind-merge。 | SD28/PD51旧helper聚焦、40源同源 verifier；clipboard顺序测试。 | NOT RUN：完整用户focus/selection/真实系统clipboard及所有事件UI证据未采。无两份独立helper或shared反向import PD叶。 |
| D11 | Knowledge root/document/concept path ID权威、queryscope/decode、精确路径守卫、export坏shape拒绝；alternate knowledge/knowledge-bases query已接。 | 本次 Knowledge adapter12 PASS，既有 scoped/edit/bridge测试。 | NOT RUN：真实root/文档/concept写→ownerDB回读未跑；native可见范围PEP仍D18 BLOCKED。已修query/body合同不能冒称PEP通过。 |
| D12 | 首create投影真实SkillRead/rowID/draftID/content/version/同响应ETag，mounted snapshot保首次值；公共create保selected sopId并拒冲突skill_id；随后replace不抓新ETag背书旧内容。 | adapter lifecycle与HTTP create/rollback/ETag聚焦、row-ID guard测试。 | NOT RUN：真实首次save/refresh/replace/persistentDB/冲突UI未在新pair执行。没有预create、自动publish或rebase。 |
| D13 | 错误move-to-draft→create、Remove→archive已撤掉；现有archive保持自身语义。 | adapter明确能力错误，server planner同语义阻塞零请求。 | BLOCKED：公开缺原overall/admin move状态及employee hidden/deleted branch/binding删除语义；需正式有界facade+PEP与获批route白名单。公开owner薄契约见下表，adapter只消费批准等价协议。unsupported是缺口，不是功能PASS。 |
| D14 | Knowledge精确scoped路径、IDs/query/body/response与坏export拒绝；SOP正式versions/read/rollback保持真实服务合同。 | Knowledge12、SOP lifecycle与row-ID测试、旧owner公开协议证据。 | BLOCKED：SOP sync/promote/historyDELETE无同语义v1；原historyDELETE A07仍在范围。Knowledge原无agent参数bucket/chunk不自行加core分支规则；完整65调用仍需源核/真实矩阵。 |
| D15 | SERVER-ONLY public client/planner/SSE decoder保realdata/HTTP/202/job/result/ETag/UTF8/cursor/signal；browser public-capability-adapter仅gateway façade+gateway decoder；prepared server gateway默认authorizedOperations=[]，原十项不变。 | helper13/receipt3历史；frontend façade8；server gateway+HTTP8；本次readiness4。 | BLOCKED：公开已有tools/general/generate/rewrite/jobs读取，但新增route白名单pending；dirty/current_skill/conversation preview不等价持久draft；cancel scope pending。unsaved probe、extract、models/users、resume/event命名空间仍准确列缺；不伪token/202或偷save。 |
| D16 | 三Host notify映正确可见toast，ToastKind/样式保warning；runtime面板EN/ZH分别显示发布/快照/刷新/receipt；用户文本不翻。 | 已交toast/locale组件证据；本次runtime-status7 PASS含实际EN→ZH/失败receipt。 | NOT RUN：全success/failure/412/并发用户动作的实际浏览器DOM/PNG尚未采，dispatch/mock不代全部visible通知通过。 |
| D17 | 真实data/drafts封套严格拒绝坏shape；rowID≠skill_id；每个draft保原顺序/日期/ID，重复ID拒绝、多draft无明确选择拒写；Page选中行传自己draft_id；无伪now/默认synced、缺status不造draft。 | e56 adapter更新 + SDselected-draft2；final-runtime-adapter36/Knowledge12；production editor路径选精确draft。 | NOT RUN：真实多draft/history/统计/日期/selected版本浏览器与owner回读未采。原统计定义0默认不统称伪造；缺字段明确边界按源码处理。 |
| D18 | Knowledge/SOP/copy每请求核PD user、正式actor/tenant/target/ownedcredential，撤销/身份变化后不进入业务上游；浏览器无SD key。 | 实际公共HTTP身份5/后续bridge6+gateway2，copy bridge9（既有原件）。 | BLOCKED：原native可见employee/team/合法非target每operation PEP尚无完整公开等价合同。直接调用native read不执行FastAPI dependencies；configID/HTTP200/ownedmetadata不代PEP。当前target约束不签原范围parity；若需core policy改变先报，未改core。 |
| C01 | 唯一现有publish包一次正式请求→owner响应→完整atomic bundle→真实Gateway reloadExtensions→持久owner receipt；GET management重建回读；browser per-mount observer/provider+实际入口保 sibling runtime，UI分阶段状态，effective始终false。 | 原runtime13+receipt3、actual route单publish；本次production editor+EN/ZH状态7 PASS；readiness4仅配置准备。 | NOT RUN：model_for_agent有效配置、真实discovery/modelwire/runtime下一load/newpin/oldpin同wait恢复/审批/仅web重启/实际Gateway失败仍未运行。ack不等于effective；单writer进程限制保留。代码/投影接线已交，不再等待adapter/UI。 |
| C02 | 三Page/版本详情/graph资源内容 FormalUserContent；Portal独立locale边界；mounted日期locale；raw名称正文保translate=no，labels仍EN/ZH。 | 真实DOM/ImportPortal/EN→ZH7、PDPortal1，新增graph content和runtime状态测试；动态Dialog/aria模板混入用户文本仍为UI具体未完实现，不能统称仅运行项。 | NOT RUN：所有页面语言/主题/日期/Portal实际浏览器矩阵未全采；局部保护证据不签全内容边界。 |
| C03 | 0.1.13 canonical全部40源逐字vendor；UPSTREAM指精确SDref。manifest补齐clsx/tailwind/router/Radix/cytoscape/lucide实际peer版本；使用各自locked安装和本树解析，无借依赖/临时shared symlink。移除ambient Record<any>伪类型，SD编译真实canonical。两生产模块图保存。 | SD tsc-b+Vite PASS；PD tsc noEmit与enabled生产build PASS；final-vendor-check PASS。 | NOT RUN（整组/独立S06）：build/typecheck子检查PASS；原Page ts-nocheck仍保留，完整原props和fresh四clone/后端锁/实际装配尚未独立核。不以删除nocheck重写Page来制造通过。 |
| C04 | 原layout/palette/classes/paginator/padZero/current/ellipsis/aria/跳页合同源提取；PD现有pagination消费；scope tooltip与progress实际调用修复。 | SD/PD presentation各3、selecteddraft/Portal/graph测试及两生产build。 | NOT RUN：全layout响应式/主题/所有props、clamp/resetKey真实行为与双Host视觉尚未完整签证。UI owner不是等待文件分配。 |

## 公开语义缺口与最小薄契约（统一 BLOCKED 表）

以下全为待批准/待实现合同，不是现有功能或新route。白名单pending只阻匹配接入；cancel权限pending只阻SOP取消。已授权正常publish、context/abort/notify/build不受其阻塞。

| 缺口 | 需保持的精确公开语义 | 阻塞与唯一接线 owner |
|---|---|---|
| move-to-draft | overall+admin，修改原对象状态；不得create另一个draft。 | 无等价v1；public提出facade，公共route owner接，adapter映射。 |
| Remove | overall删除与employee hidden/deleted branch/binding的原PEP/继承行为；archive inactive和移除binding都不等价。 | 同上，禁止近似替代。 |
| SOP sync/promote/historyDELETE | 原分支sync/promote/admin限制；当前active version删除409，不自动rollback。 | 无等价公开route；historyDELETE A07不遗漏。 |
| dirty preview generate/rewrite | 原current_skill/conversation/available_tools/sops/target_path+target_paths/label/model字段；不持久化，真实stream_text；tenant+user owned preview job独立namespace。 | v1生成改写会持久化draft；PUBLIC_PREVIEW_REQUIRED零save，不能映job或伪chunk。 |
| tools/general目录与已存测试/import/publish/archive | 固定v1合同/HTTP envelope和mask拒回写；archive只禁用。 | 协议已存在但白名单pending；server prepared gateway=[]，frontend无production启用。 |
| generate_sop/rewrite_saved_sop/get_job/result/events | 真实202、服务分配draft/ETag、终态error、SSE/Last-Event-ID，消费者接受后cursor；不自动重连/save/cancel。 | 同上；已存source和dirtypreview分开，不冒称原编辑器全接通。 |
| unsaved tool probe/delete | 未保存body probe；正式delete，保scope/actor；已有:test需要ID，不等价。 | 无等价route/明确scope与白名单；public薄facade。 |
| SOP extract | 原filename/content_base64/5MiB/支持类型/400/413，只回filename/text，不建KB/job。 | KB upload不等价；需要正式facade。 |
| model/user目录 | 可选模型metadata与原可见handoff users，不泄provider凭据，保原PEP。 | model binding/effective:false不是catalog；handoff记录不代users目录。 |
| SOP job cancel | cancel_requested和最终cancelled区分，原job owner语义。 | 正式user_full_access缺sops:cancel/jobs:cancel，用户决策pending；不换key/改scope/core。 |
| Knowledge visible scope PEP | 原tenant+actor可见employee/team/非target逐operation判断与正式ownedcredential撤销一致。 | native module read不执行dependencies；缺完整公开facade/PEP，D18 BLOCKED，不声称观察到泄露。 |

完整薄route输入方案仍见 PD `docs/validation/public-runtime-integration.md`；本表取其准确边界，不启用其中提案。readiness helper只读传入配置/bundle/receipts/pins，不扫描全局会话、网络或模型，也不证明effective。

## 聚焦原件与环境

全部raw位于交付根目录，不合并抹掉首FAIL：

- `sd-build-first.log`、`sd-build-resolved-source.log`、`sd-build-typed-consumers.log`：实际解析/类型首次失败；`sd-build-final-source.log` 和 `sd-build-production-graph.log` 最终通过。
- `pd-typecheck-first.log`：缺CapabilityScope/旧draft类型；`pd-typecheck-final.log`及最终`pd-typecheck-cleanpair.log`通过；`pd-build-cleanpair.log`为最终面板/生产接线的enabled构建。
- `sd-changed-consumer-tests.log`：8文件20测试首次19 PASS/1 FAIL（旧gallery-copy额外undefined断言）；只改同一fixture合同，`sd-gallery-copy-corrected-test.log`该文件2/2 PASS，其余7文件未重跑。合计20不同测试通过，不能把两次测试数相加。
- `final-runtime-adapter-tests.log`：4文件36 PASS（clients、SOP、copy、runtime6）；`adapter-knowledge-final-tests.log`12 PASS；`public-readiness-integrated-tests.log`4 PASS。
- `runtime-production-publish-test.log`与`runtime-status-final-tests.log`：后续runtime7 PASS，覆盖实际editor factory→get_draft→一次publish→receipt、相同signal、读draft不触发runtime错误、失败snapshot/refresh/receipt与EN/ZH。7中6是前述runtime用例，不能重复计数。
- `final-vendor-check.log`：40 canonical源逐字同源；`sd-production-module-graph.json`、`pd-production-module-graph.json`保存真实production modules/chunks，不用源码import猜产物。
- 历史聚焦原件分别在三handoff目录：mounted/api/helper/HTTP identity/abort/receipt/Portal/ref/Progress/scope/paginator；本次未无理由重跑已通过局部测试。旧实际业务FAIL/state仍在其原目录。

Node22.23.1、pnpm10.32.1。SD frontend npm ci --ignore-scripts、PD pnpm frozen-lockfile --ignore-scripts分别用本树锁与本树node_modules；无需新增锁条目，shared只声明已安装host peers。SD原lucide1.27.0、PD0.515.0的兼容peer范围已明确。PD root LFS缺assets/awo.gif远端对象，保留指针，不代媒体PASS；本次enabled UI构建不依赖该对象。两build仅报chunk size warning。example-seven-managed只作静态模块装配形状，其placeholder绝不是有效模型/服务配置。

## UI e535 固定增量收口

SD be3b7a41 graph hunk已在0de673e5 canonical/vendor；这次不重复合入、不重跑已测graph。PD e53589cb固定提交新增宿主Input/Textarea forwardRef及实际primitive test；其Progress hunk与当前实现逐字相同，保留现有行。owner目录后续LocaleBoundary dirty仅查状态路径，未读内容；只读取不可变commit diff。

本次聚焦4/4及最终PD typecheck/StaffDeck-enabled生产build通过，raw为交付根 `ui-wip-handoff/ui-e53589cb-{integrated-tests,typecheck,enabled-build}.log`；SD源码未变不重build。仍具体未完：Dropdown/Popover/Tooltip/Accordion生产调用、DialogFooter showCloseButton/Confirm loading实际Host、最终三Host全注册/ref/props、动态Dialog/aria用户内容窄hunk。双Hostdark/light/响应式/图节点编辑保存/真实语言错误并发继续唯一矩阵NOT RUN；不把这些实现/聚焦缺口全部推成独立业务验收。

## 后续唯一依赖与交付顺序

1. UI owner继续完整原props/注册项/键盘/ref/focus与布局证据；从最终SDref接续，无须再等0.1.13快照；Graph/selecteddraft/ref/Progress已交不重做。
2. adapter owner继续完整65原调用合同和正式scope/PEP接口消费；从最终PDref接续，runtime callback窄hunk由整合者交patch，避免覆盖clients/copy/snapshot。
3. public owner保D13–D15精确薄合同、D18需正式PEP的边界和真实模型/newoldpin/wait证据要求；权限未决仅保对应BLOCKED；readiness未挂新endpoint，不阻cleanpair。
4. 整合owner只处理公共route/共享依赖/vendor/跨线重叠。文件owner和当前精确目录见FILE_OWNERSHIP.md；没有可用会话发送工具，公开文件是协调入口，不再重复queue。
5. 本交付前没有独立业务轮。后续是否进入独立S01–S06由现有独立验收会话依据此完整表决定；不能因cleanpair存在略过BLOCKED或将unsupported算PASS。通过源核后仍按唯一矩阵四fresh/locked、同DB/HOME/bundle、双Host真实Knowledge/SOP/身份/装配/语言连续矩阵；首实质FAIL保raw并停止扩大业务覆盖。

无push、merge、部署、核心权限/AgentLoop/版本策略变更或新任务/验收轮。G0–G7未全部独立通过，目标不宣称完成，部署文档不宣称可直接部署。
