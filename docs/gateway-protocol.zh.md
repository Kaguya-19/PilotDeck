# Gateway WebSocket 协议

PilotDeck Gateway 是 Agent、会话、任务和扩展能力的本地 WebSocket 边界。本文只定义 WebSocket 协议；`/api/web/*` 是 Web UI 的转发层，不属于该协议。字段和类型的权威来源是 `src/gateway/protocol/types.ts`、`src/gateway/protocol/frames.ts` 与其导出的 TypeScript 类型。

## 连接与帧

- Gateway 只绑定本机的 `127.0.0.1` 或 `localhost`，WebSocket 地址是 `ws://<host>:<port>/ws`。
- 客户端首先发送 `hello`：`protocolVersion` 必须等于当前的 `PILOTDECK_GATEWAY_PROTOCOL_VERSION`（目前为 `1.0`），并携带 `clientName`、`clientVersion` 和 token。成功后收到 `hello_ok`；鉴权或版本不匹配会关闭连接。
- 本地客户端可通过 `GET /auth/local-token` 读取 token；`GET /health` 返回健康状态。两者是本地 Gateway 辅助端点，不是业务 RPC。
- 常规调用使用 `{ type: "request", id, method, params }`，成功响应为 `{ type: "response", id, ok: true, result }`，失败响应为 `{ type: "response", id, ok: false, error: { code, message } }`。
- `submit_turn` 是流式调用。服务端对每个中间事件发送递增的 `seq` 和 `final: false`；结束时发送一个 `final: true` 的 `turn_completed` 事件。客户端以最后一帧为流结束标记。
- `notification` 是没有请求 id 的服务端推送，例如配置刷新。关闭连接会中止该连接仍在执行的 turn。

## Turn 与事件

`submit_turn` 输入为 `GatewaySubmitTurnInput`。`sessionKey`、`channelKey`、`message` 是基本输入；可选项包括附件、工作目录、agent/plan 运行模式、权限模式、`maxTurns`、`timeoutMs`、`runId` 及 synthetic messages。

- 同一 `sessionKey` 同时只允许一个 turn；并发提交会得到可恢复的 `session_busy` 错误。
- `timeoutMs` 到期会中止 turn、拒绝挂起的权限/追问并关闭该 session；下一次提交会创建新 session。
- 所有 turn 流事件可携带 `runId`。使用调用方传入的 id，未传入时由 Gateway 生成。
- `GatewayEvent` 包含文本/思考增量、模型请求、工具开始与结束、附件、结构化输出、上下文预算、agent 状态、权限/追问请求、完成和错误。工具大结果仅提供预览、大小和 `resultPath`/detail 引用，避免在事件流复制全部内容。
- `permission_request` 必须由 `permission_decide` 回答；`elicitation_request` 必须由 `elicitation_respond` 回答。turn 完成、超时或中止后，旧 request id 返回 `{ delivered: false }`。

## 方法

除 `submit_turn` 外，以下方法均为单响应 RPC。可选能力在旧服务端或未配置的 Gateway 上可能返回 `unsupported`/`not_configured`，或产生标准 Gateway 错误响应；客户端应做能力探测和错误处理。

### 执行与会话

| 方法 | 参数 | 响应/事件 | 测试 |
| --- | --- | --- | --- |
| `submit_turn` | `GatewaySubmitTurnInput` | `GatewayEvent` 流 | `websocket-contract: submit_turn` |
| `abort_turn` | sessionKey、可选 runId/reason | `{ ok: true }` | `websocket-contract: RPC dispatch matrix` |
| `list_sessions` | `ListSessionsInput` | `ListSessionsResult` | 同上 |
| `resume_session` | sessionKey | sessionKey | 同上 |
| `new_session` | `NewSessionInput` | sessionKey | 同上 |
| `close_session` | sessionKey、可选 reason | `{ ok: true }` | 同上 |
| `record_agent_status_message` | status payload | `{ recorded }` | 同上 |
| `describe_server` | `{}` | `GatewayServerInfo` | 同上 |
| `active_turn_snapshot` | sessionKey、可选 includeEvents | `GatewayActiveTurnSnapshot` | `execution-lifecycle: snapshot` |

### 交互与历史

| 方法 | 参数 | 响应 | 测试 |
| --- | --- | --- | --- |
| `elicitation_respond` | sessionKey、requestId、answer | `{ delivered }` | `execution-lifecycle: interaction buses` |
| `permission_decide` | sessionKey、requestId、decision、可选 remember/reason | `{ delivered }` | 同上 |
| `grant_session_permission` | sessionKey、entry | `{ granted, entry? }` | `websocket-contract: RPC dispatch matrix` |
| `read_session_messages` | session message query | projected messages | 同上 |
| `read_subagent_messages` | subagent message query | projected messages | 同上 |
| `fork_session` | fork request | fork result | 同上 |

### 项目与运行时

| 方法 | 参数 | 响应 | 测试 |
| --- | --- | --- | --- |
| `list_projects` | `{}` | projects | `websocket-contract: RPC dispatch matrix` |
| `describe_project` | projectKey | project summary | 同上 |
| `reload_config` | `{}` | reloaded 或 unsupported | `websocket-contract: optional handlers` |
| `prepare_weixin_login` | `{}` | login request 或 unsupported | 同上 |
| `reload_extensions` | 可选 reload input | reloaded 或 unsupported | 同上 |

### Cron

| 方法 | 参数 | 响应 | 测试 |
| --- | --- | --- | --- |
| `cron_create` | `CronCreateInput` | `CronCreateResult` | `websocket-contract: RPC dispatch matrix` |
| `cron_list` | `CronListInput` | `CronListResult` | 同上 |
| `cron_update` | `CronUpdateInput` | `CronUpdateResult` | 同上 |
| `cron_delete` | `CronDeleteInput` | `CronDeleteResult` | 同上 |
| `cron_stop` | `CronStopInput` | `CronStopResult` | 同上 |
| `cron_run_now` | `CronRunNowInput` | `CronRunNowResult` | 同上 |

### Skills

| 方法 | 参数 | 响应 | 测试 |
| --- | --- | --- | --- |
| `skill_list` | `SkillsListInput` | `SkillsListResult` | `websocket-contract: RPC dispatch matrix` |
| `skill_read` | `SkillAddressInput` | `SkillReadResult` | 同上 |
| `skill_write` | `SkillWriteInput` | `SkillWriteResult` | 同上 |
| `skill_create` | `SkillCreateInput` | `SkillCreateResult` | 同上 |
| `skill_delete` | `SkillDeleteInput` | `SkillDeleteResult` | 同上 |
| `skill_import` | `SkillImportInput` | `SkillImportResult` | 同上 |
| `skill_validate` | `SkillValidateInput` | `SkillValidationResult` | 同上 |
| `skill_scan` | `SkillScanInput` | `SkillScanResult` | 同上 |

### Always-On

| 方法 | 参数 | 响应 | 测试 |
| --- | --- | --- | --- |
| `always_on_apply` | `AlwaysOnApplyInput` | `AlwaysOnApplyResult` | `websocket-contract: RPC dispatch matrix` |
| `always_on_rerun_plan` | `AlwaysOnRerunPlanInput` | `AlwaysOnRerunPlanResult` | 同上 |

## 客户端实现约定

`RemoteGateway` 是 TypeScript 客户端实现：`submitTurn()` 使用流，其余方法透传为同名 WebSocket RPC。客户端必须处理 `GatewayRequestError` 的 `code` 和可选 validation 信息，并在需要权限或追问的 turn 中持续消费事件流，直到提交对应的回答或收到最终帧。

协议的测试索引：wire transport 覆盖在 `tests/gateway/websocket-contract.spec.ts`，客户端映射覆盖在 `tests/gateway/remote-gateway-contract.spec.ts`，session 生命周期、快照和交互 bus 覆盖在 `tests/gateway/execution-lifecycle.spec.ts`。既有 `active-turn-snapshot`、`map-agent-event-runid`、`tool-result-preview` 和 `cron-editing` 测试继续覆盖实现级行为。

Agent Loop 的内部执行边界、状态机、恢复策略和分阶段测试路线见 [`agent-loop-trd-roadmap.zh.md`](agent-loop-trd-roadmap.zh.md)。

细粒度协议文档见 [`trd/01-gateway-wire.zh.md`](trd/01-gateway-wire.zh.md)、[`trd/02-gateway-lifecycle.zh.md`](trd/02-gateway-lifecycle.zh.md)、[`trd/06-agent-events.zh.md`](trd/06-agent-events.zh.md) 和 [`trd/44-gateway-bridge.zh.md`](trd/44-gateway-bridge.zh.md)。
