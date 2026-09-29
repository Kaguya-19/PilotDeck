# 集中整合代码交付记录

本提交接续已交0.1.13，属于原集中任务的一次cleanpair源交付，不签G gate或全功能PASS。

完整22组处置、公开语义缺口、唯一owner、原件及最小复核方法见 `/Users/a1/Documents/Codex/2026-09-27/g0-g6-integration-intake/CONSOLIDATED_DISPOSITION.md` （链接唯一版本化处置表）与同目录 `DELIVERY.md`。这是一份完整处置表，既有 `EVIDENCE_MATRIX.md` 仍为唯一独立运行清单。

已接固定 UI be3b7a41/33238719、adapter e56bcdf3、public e8a53ad9；保留此前全部在途固化与各线增量。三Host mounted context、原ApiError/Signal/tenant/Toast warning、正常单publish→atomic bundle→真实Gateway ack→持久receipt已有公共接线。browser按每mounted provider观察同级runtime，分开显示发布/快照/刷新/receipt，effective始终false；client返回result不变，UI回调错误不重复publish。get_draft读不触发runtime回调。两个4319helpers与readiness仍server-only，frontend只有modulegateway façade。authorizedOperations=[]，原十项whitelist不扩展。

SD真实canonical类型与生产构建、PD类型与enabled静态profile生产构建、40源vendor验证通过；修改测试只用实际Host类型，移除ambient伪类型。producer图在SD dist/business-ui-modules.json与PD dist/composition-modules.json，独立copy原件在交付目录；example profile只为静态build，不证明运行配置。

D13–D15等价公开语义/route白名单和cancel scope、D18原可见范围PEP保持精确BLOCKED；完整props/真实DB/UI/模型/newoldpin/wait未运行。旧首FAIL/raw不变，无业务轮/push/merge/部署，不以unsupported代功能PASS。

UI固定e53589cb增量追加：宿主Input/Textarea forwardRef与实际primitive4测试通过，Progress行已同源不重复改；SD be3graph已接不重跑。PD typecheck/enabled build通过，raw在ui-wip-handoff。仍未完生产Dropdown/Popover/Tooltip/Accordion、Footer/Confirm与三Host全注入、动态Dialog/aria用户文本详见唯一处置表；不升gate。
