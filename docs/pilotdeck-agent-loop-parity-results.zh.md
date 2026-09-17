# PilotDeck AgentLoop 对拍结果

## 范围

本基线比较同一 PilotDeck checkout 中 native 与 Module Protocol sidecar 两条 AgentLoop 链路。Gateway sidecar
必须通过 `PILOTDECK_AGENT_LOOP_TRANSPORT=stdio` 进入正式 deployment profile 和
`createAgentLoopSidecarRuntimeFactory`；测试不再注入自实现 runner 或 `__testAgentLoopFactory`。

模型和工具使用确定性本地 mock，但只能经正式 host module dispatcher 调用。该结果证明生产 sidecar factory、
Gateway/WebSocket、module protocol 和 durable callback 的确定性语义一致，不代表真实外部 provider 或完整部署 E2E。

执行 checkout：`/Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-core-integration`

执行分支：`codex/integrate-sdk-0901`

环境：Node `v22.23.1`，pnpm `10.32.1`，Python `3.12.2`。

## 命令和结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `pnpm build` | PASS |
| Protocol/ports/sidecar/Gateway focused tests | 下方明确文件列表 | 109/109 PASS |
| SDK package tests | `pnpm --filter @pilotdeck/sdk test` | 123/123 PASS |
| Harness contract/negative-control | `cd tools/agent-loop-parity && python3 -m unittest test_trace.py` | 18/18 PASS |
| Gateway 旧生产路径基线 | `run.py --comparison same-version --surface gateway --scenario all` | 48/48 PASS；仅证明当时的 scenario 集合 |
| Gateway 当前生产路径 gate（2026-09-17） | `run.py --comparison same-version --surface gateway --scenario all` | 49/49 PASS；`FAIL=0`、`BLOCKED=0`、oracle failure `=0` |
| Gateway metadata/configuration gate（2026-09-17） | `run.py --comparison same-version --surface gateway --scenario all` | 52/52 PASS；`FAIL=0`、`BLOCKED=0`、oracle failure `=0` |
| 本轮 metadata focused suites | `default-factory`、`llm-model-port`、`sidecar-client` | 72/72 PASS |

全量命令：

```bash
export PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH
pnpm build
node --test --test-force-exit --test-timeout 300000 \
  dist/tests/agent/modules/module-protocol.spec.js \
  dist/tests/agent/modules/ports-adapter.spec.js \
  dist/tests/agent/modules/default-factory.spec.js \
  dist/tests/agent/modules/llm-model-port.spec.js \
  dist/tests/agent/modules/sidecar-client.spec.js \
  dist/tests/agent/modules/tcp-sidecar-transport.spec.js \
  dist/tests/agent/loop/seed-read-state.spec.js \
  dist/tests/agent/session/steer-terminal.spec.js \
  dist/tests/gateway/operation-deadline.spec.js \
  dist/tests/protocol/module-protocol-contract.spec.js \
  dist/tests/sdk/seed-read-state-e2e.spec.js
python3 tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-core-integration \
  --comparison same-version \
  --surface gateway \
  --scenario all
```

当前全量摘要：

```json
{
  "scenarios": 52,
  "blocked": [],
  "failed": [],
  "oracleFailures": [],
  "knownGaps": []
}
```

## 生产路径证据

sidecar oracle 要求每个适用场景同时出现：

- `transport_selected: stdio`；
- 正式 sidecar `handshake_completed` 与 stream binding；
- 场景要求的 host `module_call_received`。

缺失任一证据均分类为 `BLOCKED`，不能由 comparator 结果变成 PASS。harness negative-control 已验证 fake runner
或缺少 handshake 时会失败关闭。

新增七个闭环场景的原始 trace 结果：

| 场景 | 生产 module 证据 | durable / 行为结果 |
| --- | --- | --- |
| `sidecar_budget_limit` | `budget` | 1 次 model request；预算状态写入一次；replay 可见一次；工具副作用为 0 |
| `sidecar_elicitation` | manifest interaction availability + host capability path | `canPrompt=false, canElicit=true` 时两侧均暴露询问工具；wire 不传 channel 对象 |
| `sidecar_elicitation_execution` | `capability.execute_batch` | 真实 `ask_user_question` 经 host channel 完成，工具结果进入第二次 model request |
| `sidecar_sdk_tool_progress` | `capability.execute_batch` | SDK `agentProgressSummaries` 开启后，host progress callback 恰好投影一条 Gateway `tool_progress` |
| `sidecar_live_steer` | `turn` | 2 次 model request；accepted guidance 与 `steer_applied` durable 一次 |
| `sidecar_durable_compaction` | `turn.persist_compaction` | replacement/boundary 先于后续 model request；1 次 boundary、1 次 completion |
| `sidecar_full_request_compaction_budget` | `context.try_auto_compact`、`budget`、`turn.persist_compaction` | host 用完整 canonical request template 重建预算；system prompt/tool schema 参与估算；1 次 boundary、1 次 completion |
| `sidecar_projected_request_compaction_budget` | `context.try_auto_compact` | history 经 `maxContextMessages=1` 投影后仍执行 request-level estimator，不得静默跳过预算 |
| `sidecar_seed_read_state` | production runner seed-state projection、`model.stream_next` | seed 在 host runner 应用并投影到下一 turn；写文件前 freshness gate 与 native 一致 |
| `sidecar_live_model_stream` | `model.stream_next` | 首个 text delta 的 trace sequence 早于 provider completion；event 顺序与 terminal 一致 |
| `sidecar_model_metadata` | `model.get_metadata`、`model.prepare` | 初始 effective route 的 limits/protocol/cache snapshot 由 host 提供；prepare 后可刷新路由结果 |
| `sidecar_empty_system_prompt` | `model.get_metadata` | SDK 显式空 system prompt 不会被当作未配置或恢复默认 product prompt |
| `sidecar_additional_working_directories` | `model.get_metadata` | SDK additional working directories 进入 model-visible prompt；工具授权仍由 host permission context 拥有 |

## 结论

`48/48` 与 `49/49` 是历史基线；当前 `52/52` 已在正式 stdio factory 下重跑，并补充 metadata/configuration 生产路径覆盖。`plan_mode_host_policy` 验证四轮 host-owned
permission mode 生命周期、plan-mode 写拒绝和退出后的一次副作用；projected-history 场景同时验证实际 `maxContextMessages`
投影与原始/replacement request-level budget。trace invocation identity、必跑场景清单和 baseline oracle 缺失均为
`BLOCKED` 或失败，不能以 comparator 的空差异替代。model pull stream 使用 `stream_next`，旧 `stream` 仅保留 batched
compatibility fallback。

报告中的 format warning 只涉及已声明的 transport/envelope、随机 identity 或 actor-local sequence 差异；terminal、
错误码、模型请求、工具调用与副作用、permission、checkpoint、mailbox、boundary 和 transcript 可见状态仍严格比较。
trace、日志和临时运行目录位于 ignored `tools/agent-loop-parity/artifacts/` 或 `/tmp`，不进入 Git。

StaffDeck Harness/TaskFrame/SOP/lease/fencing 及真实外部服务 deployment E2E 不在本次 PilotDeck-only 基线范围内。
