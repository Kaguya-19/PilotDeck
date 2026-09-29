# G5 真实复现结果报告（2026-09-23）

## 结论

本轮不能宣称 G5 完整验收通过。上一轮闭环使用了泄露内部状态的用户台词（`completed`、槽位和 `scope_changed`），只能作为辅助证据；本报告已撤回其 acceptance PASS。当前继续验证使用普通项目请求，结果需以模型和合法配置自主选择实际 gate 为准。

## 真实复现证据

- 新复现 trace：`/tmp/g5-repro-20260923-1790138839/trace.json`
- 配置：`http://127.0.0.1:16224/api/v1`，`discoveryTimeoutMs=120000`；首个 ordinary turn 在 discovery 请求超时，返回 `agent_invalid_state`。
- 该 trace 的 `service=[]` 是旧取证缺口，不能证明请求未发出。对应日志只显示主 API `16224` 与 Harness capability MCP 随机端口 `58955` 启动；超时后主进程进入 background-task shutdown waiting，未留下完成的 route access 记录。
- 已补充 runner 取证：连接拒绝样本 `/tmp/g5-fetch-refused-trace-20260923.json` 记录约 `3ms` 的 `outcome=error`；不响应样本 `/tmp/g5-fetch-timeout-trace-20260923.json` 记录 `50ms` 配置、约 `53ms` 的 `outcome=aborted`。两者都保留脱敏 URL/端口、timeout、耗时、请求体和错误。
- 受内部指令引导的辅助 trace：`/tmp/g5-full-repro-rerun-20260923-140951/g5-full-trace-2.json`。它确实记录了 discovery、lifecycle、handoff、reload、resume、duplicate 和 completion，但输入中直接要求内部状态/槽位/分支，不能作为普通入口验收。
- 辅助 trace 使用的真实 public publish 对象绑定为 `project_delivery_plan@1.0.1`；原始发布 envelope 与平铺部署对象均保留在 `/tmp/g5-full-repro-rerun-20260923-140951/`，版本化输入来源和启动方式见 `evidence/g5-natural-input-audit-20260923.md`。
- 普通请求失败 trace 已版本化：`evidence/g5-natural-input-failure-20260923.json`，摘要为 `evidence/g5-natural-input-failure-20260923.summary.json`。该次 discovery HTTP 200 并选择 `project_delivery_plan@1.0.1`，实际执行 `read_file` 和 lifecycle `prepare/submit`，随后停在 `build_plan` 的 `awaiting_user`，未产生 handoff。
- 通用胶水修复后的普通请求成功 trace：`evidence/g5-natural-input-success-20260923.json`，摘要为 `evidence/g5-natural-input-success-20260923.summary.json`。同一普通请求在新构建上完成 discovery、`read_file`、prepare/submit、handoff、reload、human resume、duplicate replay 和 terminal `completed`。
- 受控 no-change 分支基线：`evidence/g5-no-change-controlled-20260923.json`，仍保留为 controlled 证据；正式发布定义的真实 no-change 证据为 `evidence/g5-staffdeck-native-real-published-no-change-20260923.json`。
- StaffDeck 原生入口状态已更新：`evidence/g5-staffdeck-native-entry-status-20260923.json`。真实入口 `app.core.agent_loop.AgentLoop.handle_turn -> HarnessV3Engine -> HarnessV3Runtime` 已在 Node 22.23.1、私有 Harness home/SQLite 上使用授权的 `provider1/qwen3.6-flash-distill` 直接加载正式发布对象 `skill_preset_project_001/project_delivery_plan@1.0.1` 执行成功。`g5-staffdeck-native-real-published-scope-changed-20260923.json` 记录普通文本自主完成 `n1_collect -> build_plan -> confirm_scope -> finalize_plan`；`g5-staffdeck-native-real-published-no-change-20260923.json` 记录普通 no-change 文本完成 `n1_collect -> build_plan -> finalize_plan`，无 handoff。runner、初始化命令、完整用户输入和前后持久化快照已版本化在同名 `.py`/`.json` 中。此前缺少 `apps/cli/lib/bin.js` 的结论来自错误 checkout 探针，已更正；本次不把 PilotDeck sidecar trace 当作 native 证据。

## 可行动诊断

- 原先复用隔离 SQLite 的 replay 使用了不同的 `APP_SECRET`。StaffDeck 日志明确显示请求已进入 `POST /api/v1/agents/.../sops:route`，随后 `TurnPlanner().plan` 在解密 `model_configs.api_key_encrypted` 时抛出 `Secret cannot be decrypted with current APP_SECRET`，返回 HTTP 500。该失败样本位于 `/Users/a1/Documents/Codex/2026-09-23/g5-runtime-independent-capture/staffdeck-capture.log`；它解释 replay 阻塞，不解释最初的真实 timeout 或旧 trace 的两次 422。
- 使用全新 SQLite、同一固定 `APP_SECRET` 写入并启动 StaffDeck，route-only 最小复现通过：`/tmp/g5-minimal-route.rBPHQI/staffdeck.sqlite3` 与 `/tmp/g5-minimal-route.rBPHQI/staffdeck.log`。`POST /sops:route` 返回 HTTP 200，选中 `project_delivery_plan`；SQLite `api_audit_logs` 记录该 route `duration_ms=16277.7598`。这证明主 API route、TurnPlanner/provider 调用和模型配置解密在一致密钥下均能开始并结束。
- 复用隔离库时的 `APP_SECRET` 不一致仍保留为失败诊断；本次成功复现使用全新 SQLite，并在写入模型配置和启动 StaffDeck 时保持同一 secret，避免复用旧加密凭据。
- 普通请求重跑必须重新确认 discovery、proposal、handoff 和 terminal gate；不能通过修改用户台词把内部状态直接喂给模型。
- 普通请求失败的实际原因是模型在计划步骤选择等待用户，而不是自主提交范围影响确认并进入 handoff；当前没有证据表明该失败来自已撤回的非原生限制。
- 该失败原因已定位并修复为两处通用信息缺失：StaffDeck adapter 原先只传出 outgoing step ID，丢失 edge condition/priority/label 与目标节点上下文；PilotDeck 提示也未明确要求在已知信息齐全时写入 `slotUpdates` 并按条件选择 `nextStepId`。修复增加 additive `transitions` 上下文和通用推进提示，未改变 owner validator、等待或审批规则。

## 已有 proposal / 422 定位

来自版本化旧 trace `products/pilotdeck-staffdeck-sop/evidence/g5-agentloop-natural-discovery-1.2.1.json`（该文件的顶层成功样本仍对应 `f52ae6fc`，不是本次新复现）：

1. `n1_collect` 上，模型提交 `status=completed`，但没有提交必填 `slotUpdates`。原生返回 HTTP `422` / `REQUIRED_SLOT_MISSING`，缺少 `project_goal`、`current_stage`、`known_blockers`。
2. `confirm_scope` 上，模型提交 `status=completed` 且 `nextStepId=build_plan`。当前节点不允许该转移，原生返回 HTTP `422` / `INVALID_TRANSITION`。
3. 上述辅助 trace 的节点路径为 `build_plan -> confirm_scope -> finalize_plan`，并记录了 handoff wait reload、human approval duplicate replay 和 terminal completion；这不等于普通请求已自主走完相同路径。普通请求重跑的完整成功或失败 trace 必须单独保存。

## 原生语义对照

- StaffDeck 原生 validator 保留两类约束：非法节点转移拒绝；`completed` 结果缺少必填 slots/capabilities 拒绝。
- 原生允许 `awaiting_user` 携带 `next_step_id`，也允许出现在声明 handoff 的节点或未声明 `expected_user_info` 的节点。
- 因此已撤回 `WAIT_STATUS_CANNOT_ADVANCE`、`HANDOFF_REQUIRED`、`WAIT_INPUT_NOT_REQUIRED` 等非原生限制；PD `303d06a8` 与 SD `e7f540fe` 对齐该语义。上述两次 422 是 proposal/图转移错误，不是这些已撤回限制造成的。

## 状态与 refs

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| StaffDeck 原生语义 | **PASS** | `e7f540feeaa92dba338e30f0ff6a343f0ac8fae4` |
| PilotDeck 等价等待语义 | **PASS** | `303d06a8286e912749199e7d5f8d73206066637b` |
| PilotDeck 失败取证 | **PASS** | `e1c07521de07dbafe8fe6f2ce59677f9b49263cd` |
| 真实 discovery 新复现 | **AUXILIARY PASS** | HTTP 200，选择 `project_delivery_plan`；输入含内部状态指令 |
| 普通请求自然入口（修复前） | **FAIL / EVIDENCE SAVED** | discovery、prepare、submit、read_file 成功；模型在 `build_plan` 等待用户，未进入 handoff |
| 普通请求自然入口（通用胶水修复后） | **PASS / EVIDENCE SAVED** | 完成 discovery、lifecycle、handoff、reload、resume、duplicate、completion |
| StaffDeck native AgentLoop entry | **PASS / FORMAL DEFINITION + REAL PROVIDER EVIDENCE SAVED** | `AgentLoop.handle_turn -> HarnessV3Engine -> HarnessV3Runtime`；provider1 普通用户文本直接使用 `skill_preset_project_001/project_delivery_plan@1.0.1`，完成正式四节点 scope-changed handoff/resume。 |
| `no_scope_change` conditional branch | **PASS / REAL PROVIDER; CONTROLLED BASELINE RETAINED** | `g5-staffdeck-native-real-published-no-change-20260923.json` 完成正式定义的 `n1_collect -> build_plan -> finalize_plan`；`g5-no-change-controlled-20260923.json` 仍作为受控基线。 |
| G5 完整/domain 验收 | **WITHHELD** | Formal-definition native entry、handoff/resume 和 real-provider no-change 已闭环；其余独立验收仍单独保留 |

当前最终分支 refs：

- PD：`codex/g5-sop-agent-pd`，当前提交含普通请求 runner 和本报告修正（其父链含 `e1c07521`、`303d06a8`）。
- SD：`codex/g5-sop-agent-sd`，包含 `e7f540feeaa92dba338e30f0ff6a343f0ac8fae4`。

## Domain matrix follow-up

已完成九项领域交付矩阵，见
`evidence/g5-domain-delivery-matrix-20260923.md`。修复后 PilotDeck
聚焦 SOP 矩阵构建与测试为 **35/35 PASS**，覆盖多 SOP 选择、无匹配普通路由、
不可见选择拒绝、禁用组合、缺少必需工具、定义/default binding 边界、条件分支和旧会话版本快照。
其中 discovery-routing 测试通过覆盖 `globalThis.fetch`，应分类为 controlled/mock
transport；real-provider ordinary entry 的证据单列在 natural-input trace 中。

StaffDeck 原生权限/租户与 SOP 边界测试已在隔离环境执行；当前聚焦命令为：
`backend/.venv/bin/python -m pytest -p no:capture backend/tests_harness/test_handoff_core.py backend/tests_harness/test_security_profiles.py backend/tests_harness/test_sop_capability_isolation.py backend/tests_harness/modules/test_sop_runtime.py backend/tests_harness/modules/test_sop_definition.py`
，结果 **55 passed**。完整正式定义的原生 AgentLoop real-provider 路径另见上述两个 versioned native artifacts。

连接拒绝和超时探针已纳入版本化 evidence：
`evidence/g5-discovery-refused-20260923.json`、
`evidence/g5-discovery-timeout-20260923.json`。StaffDeck route-only 成功仍是
HTTP 200 的 route 级证据，原始 log/database 尚在 `/tmp/g5-minimal-route.rBPHQI`，
不能升级为 native AgentLoop PASS。条件分支方面，正式发布定义的
`scope_changed`/`confirmation_received` 与 `no_scope_change` 均已有上述
provider1 native evidence；controlled no-change baseline 仍保留用于对照。

本报告仍不宣称 G5/domain 完整验收通过；当前可交给继续实现审查，但不得签收
完整验收。未修改独立验收活动树，未借用 `16400–16429` 服务，也未执行自动集成。
