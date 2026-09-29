# G3–G6 公开/runtime 只读预检交付

本文件记录公开/runtime 执行线的只读预检基线，接续 4319eadd；不是新候选、业务验收或部署配置。后续公开 SDK 的逐项合同与现行范围见 `public-sdk-delivery.md`、`EMPLOYEE_TEAM_SCOPE_EXCEPTION.md`。只读 helper 不修改现有 runtime/config/core/PEP/模块路由文件。

## 现有整合状态与最小接线

FILE_OWNERSHIP.md 当前记载：整合者已以 PD d42d6015 接通单次正式 publish、Gateway `reloadExtensions` 和原子 receipt；`ui/server/staffdeck-publish-route.js`、`ui/server/routes/modules.js` 均属整合者。其 public management GET 返回 owner 过滤后的 `runtime:{receipts:[...]}`，publish 返回 `{result, runtime}`。ack 状态为 `awaiting-runtime-observation`、`effective:false`，仍需新运行证明。能力 client 默认 `authorizedOperations: []`，本增量不扩大。

本线新增只读函数：

```js
import { prepareStaffDeckRuntimeReadiness } from '../staffdeck-runtime-readiness.mjs';
const preparation = prepareStaffDeckRuntimeReadiness({
  profile: resolvedServerProfile,             // 当前 profile 的原始七槽配置 + SOP management 绑定
  bundle: parsedDefinitionsSnapshot,          // 仅由正式配置 definitionsPath 读取；不能由 UI dirty 输入代替
  receipts: ownerFilteredRuntimeReceipts,     // 已有 publish-route.read({binding,management,owner}) 的 runtime
  persistedSessions: scopedReadOnlySnapshots, // 可选；只读同 owner 会话原 bundle/state/wait
});
```

`profile` 要来自服务端已解析且属于当前 owner 的配置；其 `modules` 包含七槽 agentLoop/skills/tools/context/modelProvider/sop/knowledge。若当前集成 API 的 runtime profile 只给前端一个脱敏形状，公共 owner 可在 server 侧另构造该函数输入，不能把 key/私有路径送前端。`bundle` 的读取需用现有正式 loader；本 helper 不读文件，不额外调用 StaffDeck。`persistedSessions` 未做正式受限只读接口时传空数组，不能通过扫描全局状态目录补齐。结果可以用于集中验收准备报告；若要加公共只读 endpoint，归整合者 modules.js owner 且必须沿既有身份和 owner 过滤。没有此 endpoint 不阻完成下一完整 cleanpair。

输出只含枚举/ID/版本/状态：`slots`（absent/installed-off/configured-on/invalid-enabled-state）、`modelDeclaration`（selected/providerDeclared/effective:'unverified'）、`discovery`（configured/managementConfigured/ownerBindingConsistent/routeObserved:false）、`bundleVersions`、`publishReceipts`、`declaredPins`、`bindingIssues`、`requiredEvidence`。绝不输出 secret、endpoint、definitionsPath、owner credential；不调用 Gateway、不运行模型、不发布。即使输入 receipt 错含 `effective:true`，输出也保持 `runtimeObserved:false`。持久会话声明旧版本只显示 `declaredVersion`，`resumedAfterReload:false`，不能升 oldpin PASS。

七槽 profile 准备时重点核：installed-off 与 absent 区分；管理/发现 agent 及 endpoint 是否一致；defaultSopId 是否存在于 bundle；定义 ID/version 有效且唯一；agent.model 的 provider 是否在声明中。`providerDeclared:true` 仍不证明模型可用。正常 route 需要 StaffDeck `model_for_agent` 有效配置，并从实际 route 与 modelwire 取证。example-seven-managed/external 中的 example.invalid endpoint 与 placeholder secret 只作配置形状参考，不能用于真实验收。应由整合者提供独有隔离 profile 的 effective 配置原件（脱敏）并填入同一 EVIDENCE_MATRIX。

## 可直接执行的下一步与精确阻塞

1. 公共 owner 可将此 helper 作为 server-only 只读预检接入现有管理/诊断路由，输入必须为当前 owner 的配置、bundle、receipt。此接线不需白名单/取消 scope 扩展。不要把结果标成运行已生效。
2. 新完整 cleanpair 前，整合者已有正式 publish 链可集中采单次 owner 响应、receipt 与 Gateway ack；实际 runtime 下一次 factory load、正常新 run 选中已发布版本及同 wait 旧 run 恢复需在完整候选的同 bundle/DB/HOME 中观察。web 重启和 Gateway 未 ready 失败项也在同轮测。没有完整候选时只准备命令/记录点，不独立启动业务验收。
3. `reload_config` 仅配置重读；文件内容变化需正式 Gateway refresh/rebuild。`reloadExtensions` ack 只意味着 invalidate/mark dirty，不能替代下一 runtime bundle 和真实运行 pin 证据。若 runtime 在旧会话加载过程中不能保持 persisted bundle，报告具体核心缺口，不擅改 AgentLoop。
4. 此段原始预检时的“白名单/取消待批”已由 `PUBLIC_SDK_AUTHORIZATION.md` 解除：固定逐名 SDK/SD facade 与仅账户 `sops:cancel` 已在公开线隔离提交，详见 `public-sdk-delivery.md`，但公共 modules.js 逐名接线和完整候选运行仍待证据。`EMPLOYEE_TEAM_SCOPE_EXCEPTION.md` 又将非目标员工/team 扩展、团队同步/提升排除本轮，不计 PASS 或准入阻塞；固定目标 Knowledge/SOP、原 PEP、draft ETag/412、审批 wait/reload/continue 与版本仍须真实验证。不能用 create/archive/test/KB upload 近似替代原生命周期。
5. `StaffDeckSopDiscoveryClient` 已有正式 route POST；该路由从 StaffDeck `model_for_agent` 取模型。需要真实 SD 有效模型配置与 route/modelwire，不以 PD provider 200 或 example profile 推定。当前模型实际有效配置仍 NOT RUN。

聚焦自验：`/Users/a1/.nvm/versions/node/v22.23.1/bin/node --test ui/server/staffdeck-runtime-readiness.test.mjs`，4/4 PASS；无安装、网络、服务、模型 turn、独立 164xx 轮。代码仍需整合者按新增文件 diff 接入当前 canonical，不把本线旧基线整树合入。
