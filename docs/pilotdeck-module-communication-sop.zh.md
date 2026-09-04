# PilotDeck AgentLoop Module Protocol SOP v0.3

状态：执行稿
适用范围：PilotDeck AgentLoop 与 StaffDeck、DSH 及其他语言模块之间的调用、事件传递和跨进程接入。

本 SOP 仅约束模块与模块之间的通信边界、执行语义和可靠性，不规定模块内部实现。它定义 Module Protocol v2.0；进程内 Cordis plugin 的内部调用不自动纳入该协议，也不要求每个模块或每条消息携带全部身份字段。

当 PilotDeck AgentLoop 作为跨语言 sidecar 被 StaffDeck 或其他宿主调用时，sidecar 可以在同一条双向 NDJSON 连接上发送 `module_call` 请求。该请求只用于调用宿主持有的 model、capability、permission、checkpoint 或 context 模块，不能创建第二套 session/turn/run 状态。

## 一、边界和核心规则

1. 同一进程内优先直接调用；只有跨语言、资源隔离或独立部署时才跨进程。
2. 宿主执行层是 `session`、`turn`、`run` 和 operation 最终状态的唯一 owner。
3. 模块不得创建第二套公共执行状态，也不得直接结束或替换宿主的 Session、Turn、Run 或 Transcript。
4. adapter 负责协议转换、进程管理和 transport；AgentLoop 不直接处理 HTTP、WS 或 stdout。
5. 每个具体 execute request 最多有一个终态；每个 operation 只能有一个最终 outcome。
6. 不为每个 package 自动创建 HTTP 服务；跨进程必须带来实际的语言兼容、隔离或部署收益。

Module Protocol 不定义 Gateway 对外 API。Gateway WebSocket 只是宿主 transport 的一种实现；Gateway 的 `sessionKey` 仍是内部路由键。

## 二、必须保留的约束

### 2.1 身份和所有权

- `runId` 由宿主产生，用于隔离旧 run 的迟到事件。
- `operationId` 标识一次跨 retry 的逻辑 operation。
- `requestId` 是 Module Protocol 上一次具体 execute attempt 的 wire identity；同一 operation 的 retry 必须使用新的 `requestId`。
- `module_call` 的 `requestId` 只标识一次宿主模块调用；它不得替换外层 execute operation 的 `requestId`。
- `attemptId` 只属于宿主内部状态、审计和 operation snapshot，不是普通 request/event 的公共必填字段。
- `toolCallId` 在同一 `runId` 内跨 retry 稳定，最终只能投影一个 `tool_result`。
- `sessionId`、`turnId` 只有在模块需要会话或 turn 上下文时才传递。

Gateway、Permission、Elicitation 等外部等待可以继续使用各自的 `requestId`。如果需要跨边界传递，必须在 adapter Mapping 中明确命名空间和转换关系，不能把它们与 Module Protocol 的 `requestId` 偷换成同一语义。

### 2.2 终态、错误和聚合

- 每个具体 `requestId` 最多一个 `final: true` 事件。
- attempt 的 `result_unknown` 必须使 operation 进入 `resolving`，先通过状态或副作用查询确认。
- operation 终态只能由宿主聚合产生；模块事件不能替代 `HostOperationStatus` snapshot。
- 已由宿主提交的 `completed` 不能被后续 cancel 覆盖。
- 连接级错误不能冒充业务终态；已建立 stream 的业务失败必须使用带 request identity 的终态 event。
- sidecar 将 AgentLoop 结果映射为失败终态时，顶层 `code` 优先保留结果中的原始业务错误码；
  只有结果未提供错误码时才使用 sidecar fallback，不能仅为 transport 改写大小写或命名。

### 2.3 取消、deadline 和副作用

- operation-level cancel 必须原子地标记 `cancel_requested`、禁止新 retry，再广播给未终态 attempt。
- retry 不得延长 `operationDeadline`；到期优先于创建新的 retry。
- 副作用 operation 必须携带稳定 `idempotencyKey`。
- `retry_after_status` 必须先查询模块 attempt 状态或副作用状态，不能盲目重试非幂等操作。

### 2.4 流恢复和去重

- 流事件按 `(streamId, sequence)` 去重；sequence gap 不能静默丢弃。
- 旧 run、旧 stream binding、旧实例或旧连接的事件不得覆盖当前状态。
- `resume` 必须显式携带旧 stream 和上一次 binding；没有显式 resume 时，旧 stream 不得自动进入新连接。
- cursor 过期必须显式返回 `CURSOR_EXPIRED`。
- 恢复时先重放 `lastAppliedSequence` 之后的事件，再发送 sequence 更大的 live event。

## 三、字段模型

### 3.1 基础字段

| 字段 | 使用范围 | 语义 |
| --- | --- | --- |
| `kind` | 所有消息 | `request`、`response`、`event`、`error` |
| `messageId` | request、response、控制消息 | 单条协议消息的身份；response 用 `inReplyTo` 关联 |
| `method` | request | `hello`、`capabilities`、`execute`、`cancel`、`status`、`resume`、`ack` |
| `payload` | request、event、response | 业务输入或输出 |

### 3.2 执行字段

| 字段 | 使用范围 | 规则 |
| --- | --- | --- |
| `runId` | execute、execute event、operation cancel | 宿主产生，旧 run 事件必须丢弃 |
| `operationId` | execute、execute event、operation cancel | 跨 retry 保持不变 |
| `requestId` | execute、execute response/event、attempt cancel/status | 每次 retry 生成新的值 |
| `sessionId` | 按需 | 需要跨模块会话上下文时传递 |
| `turnId` | 按需 | 需要跨模块 turn 上下文时传递 |

### 3.3 条件字段

| 字段 | 仅在以下场景使用 |
| --- | --- |
| `streamId`、`sequence` | streaming execute 的 accepted response 和 event |
| `idempotencyKey` | 有副作用的 execute |
| `toolCallId` | 工具相关 event 和唯一 `tool_result` 投影 |
| `operationDeadline`、`attemptDeadline` | execute request；retry 不得重置 operation deadline |
| `final`、`outcome` | response/event 的终态表达 |
| `error` | 结构化业务失败或错误响应 |

`stepId` 不属于公共 envelope。需要步骤标识的模块将其放入业务 `payload` 或自己的扩展 Schema。

### 3.4 连接和恢复字段

`protocolVersion`、`moduleId`、`moduleInstanceId`、`connectionGeneration` 只在 `hello`、能力协商和 stream binding 中出现。普通业务 event 不重复携带连接字段；当前 binding 由 transport 上下文保存。

`previousBinding` 至少包含旧的 `moduleInstanceId` 和 `connectionGeneration`。模块重启必须生成新的 `moduleInstanceId`，每次连接建立必须生成新的 `connectionGeneration`。恢复后的重放 event 保留原 `runId`、`operationId`、`requestId`、`toolCallId` 和 `streamId`，但使用当前连接 binding 发送。

完整 Schema：[`docs/pilotdeck-module-protocol-v2.schema.json`](pilotdeck-module-protocol-v2.schema.json)。

## 四、消息 profile

字段只按消息类型和能力 profile 出现，不能用一个包含所有字段的宽 envelope 代替下面的约束。

### 4.1 Unary execute

request 至少包含：

```json
{
  "kind": "request",
  "messageId": "msg-1",
  "method": "execute",
  "runId": "run-1",
  "operationId": "op-1",
  "requestId": "req-1",
  "payload": {}
}
```

成功 response 必须包含 `messageId`、`inReplyTo`、`requestId`、`ok: true`、`final: true` 和 `outcome: completed`。请求尚未接受时使用 `response(ok: false)`；连接级故障使用 `kind: error`，不能把它当作 execute 终态。

execute `payload` 可包含宿主无关的 `contextOverride`：

```json
{
  "contextOverride": {
    "systemPrompt": "宿主显式选择的系统提示",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "..."}]}],
    "metadata": {"source": "host"},
    "tools": []
  }
}
```

override 的字段优先于普通 `agent`、`messages`、`tools` 字段；显式提供
`messages`（包括空数组）时不得再拼接 `task.prompt`。sidecar 只处理 canonical
消息和通用 metadata，不识别宿主业务类型或字段。

需要由宿主动态组装上下文或批量调度工具时，execute `payload` 使用 `hostModules`
声明宿主实际支持的能力：

```json
{
  "hostModules": {
    "context": {
      "methods": ["prepare_for_model", "apply_tool_results", "recover_from_model_error", "capture_turn"]
    },
    "capability": {
      "methods": ["execute", "execute_batch"]
    }
  }
}
```

sidecar 仅代理宿主显式声明的方法。未声明 context 时继续使用本地默认 context；未声明
`execute_batch` 时继续使用兼容的单工具调用。`tryAutoCompact` 依赖进程内
`budgetEvaluator`，当前不能跨协议声明或代理。

### 4.2 Streaming execute

accepted response 在 unary 字段之外返回 `streamId` 和初始 `cursor`。后续 event 至少包含：

```json
{
  "kind": "event",
  "eventType": "model.delta",
  "streamId": "stream-1",
  "sequence": 3,
  "runId": "run-1",
  "operationId": "op-1",
  "requestId": "req-1",
  "final": false,
  "payload": {}
}
```

event 中的 `messageId` 可选，因为 `(streamId, sequence)` 已经提供去重身份。终态 event 必须有 `final: true` 和 `outcome`：`completed`、`failed`、`cancelled` 或 `result_unknown`。工具 event 额外携带 `toolCallId`；attempt 失败不能直接投影 `tool_result`。

### 4.3 Side effect

副作用 execute 在 request 中增加稳定的 `idempotencyKey`，并由实际副作用 owner 提供 `SideEffectStatus.query(idempotencyKey)`。不能因为 transport 断开就自动重试非幂等操作。

### 4.4 Tool

工具调用在同一 `runId` 内使用稳定的 `toolCallId`。不同 retry 只改变 `requestId`；operation 终态只能为每个 `toolCallId` 投影一次 `tool_result`。

支持批量执行的宿主接收一个 capability module call：

```json
{
  "operation": "execute_batch",
  "calls": [
    {"toolCallId": "call-1", "name": "lookup", "arguments": {}},
    {"toolCallId": "call-2", "name": "summarize", "arguments": {}}
  ],
  "context": {},
  "execution": {}
}
```

宿主必须将整批请求交给自己的 scheduler，并按输入顺序返回 `results`。permission preflight、
并发策略和副作用控制属于宿主 ToolRuntime；sidecar 不逐项重排或重新实现权限判断。

工具 descriptor 的 `requiresUserInteraction` 是宿主计算后的能力元数据。AgentLoop 使用它和
`canPrompt` 过滤当前模型可见工具；sidecar 不按具体工具名称做特殊判断。

### 4.5 Context

context module call 使用 `{ operation, input }`，响应使用 `{ result }`。宿主将
`prepare_for_model`、`apply_tool_results`、`recover_from_model_error` 和 `capture_turn` 转发给当前
session 的 ContextRuntime。系统提示、skill catalog、上下文裁剪和工具结果投影策略仍由宿主拥有；
sidecar 只负责调用和验证响应。`AbortSignal` 不进入 JSON，由宿主绑定当前 execution 的取消信号。

## 五、控制方法和能力

### 5.1 控制消息

`cancel`、`status`、`resume` 和 `ack` 都是 `kind: request` 的 method，不创建新的 operation、request 或 tool identity。

```text
cancel(operationId, runId, reason, requestId?)
status(requestId)
resume(streamId, previousBinding, lastAppliedSequence)
ack(streamId, lastAppliedSequence)
```

operation-level cancel 不带 `requestId`；attempt-level cancel 带目标 `requestId`。控制 response 使用自身 `messageId`，通过 `inReplyTo` 关联控制请求。

### 5.2 能力 profile

所有模块必须支持 `hello`、`capabilities` 和 `execute`。其余能力按 descriptor 声明：

```yaml
capabilitiesVersion: "2.0"
methods:
  - name: execute
    profiles: [unary, streaming, side_effect, tool]
    cancel: false
    resumeSupport: none
    retry: safe
    sideEffectClass: none
    concurrency: { mode: parallel, limit: 8 }
  - name: status
    enabled: false
  - name: resume
    enabled: false
  - name: ack
    enabled: false
```

支持 streaming 的模块才声明 `resume`/`ack`；需要模块侧查询的模块才声明 `status`；需要取消的模块才声明 `cancel`。`hello` 返回 `moduleId`、当前实例/连接 binding、协议版本和 `capabilitiesVersion`；宿主必须校验该版本与 `capabilities` response 一致。

## 六、状态、取消、超时和恢复

attempt 状态为：

```text
pending -> running
running -> completed | failed | cancelled | result_unknown
```

operation 状态为：

```text
pending -> running
running -> completed | failed | cancelled | resolving
resolving -> completed | failed | cancelled | result_unknown
```

任一 attempt 为 `result_unknown` 时 operation 进入 `resolving`，暂停 retry，并通过 `ModuleAttemptStatus.status(requestId)` 或 `SideEffectStatus.query(idempotencyKey)` 查询。只有宿主可以提交 operation 的不可变最终 outcome。

operation cancel 的线性化点在宿主：先原子写入 `cancel_requested`，再向所有未终态 request 广播 cancel。宿主已经接受的 `completed` 胜过之后的 cancel；cancel 之后到达的 completed 只能丢弃或写入审计。

`operationDeadline` 到期时，如果没有 attempt 执行则可提交 `failed`；已有 attempt 或副作用状态未知则进入 `resolving`。出现 `resolving`、`cancel_requested`、`cancelled` 或 `completed` 后不得自动创建新 attempt。

## 七、适配、版本和 Mapping

- Module Adapter 对上层暴露 transport-independent port；具体 transport 可以是 direct adapter、stdio、Unix Socket、HTTP/RPC 或 WS event stream。
- HTTP 命令通道与 WS event 通道必须绑定同一 `streamId`，不能形成两个无法关联的调用。
- `sessionKey` 只留在 Gateway 内部；跨模块使用 `sessionId` 时必须稳定映射且不能包含机器绝对路径。
- Gateway 的 `requestId`、`runId`、event `seq` 与 Module Protocol 字段的映射必须在接口 Mapping 中写明。
- 改变字段必填关系或语义时升级 Module Protocol 主版本；本次瘦身使用 v2.0。未知主版本必须拒绝连接。
- 旧版全量 envelope 如果仍有消费者，由 adapter 做 v1 -> v2 转换；转换不得改变 `runId`、operation 终态或 Gateway identity。

## 八、模块接入验收

每个模块接入前必须验证：

- 明确选择 `unary`、`streaming`、`side_effect` 或 `tool` profile，并有对应 Schema；
- `hello` 的能力版本与 `capabilities` 一致；未启用的 `status`、`resume`、`ack` 不得被强制实现；
- execute response/event 的 `requestId`、`operationId`、`runId` 作用域明确；普通消息不要求 `attemptId` 或 `stepId`；
- streaming 事件按 `(streamId, sequence)` 去重，旧 run/binding 不得覆盖当前状态；
- 每个 request 只有一个终态，operation 只有一个最终 snapshot；
- 取消、deadline、retry、`result_unknown` 和副作用确认按适用 profile 测试；
- 有重复、乱序、断线、重连和 cursor gap 的测试；
- adapter 与业务实现分离，外部进程退出不会污染新 run；
- 没有把绝对路径、token 或内部文件格式写入公共契约。

## 九、落地顺序和验证

1. 冻结 v2.0 profile Schema、错误码和身份 Mapping。
2. 更新 adapter 的 v1 全量 envelope 兼容转换（仅当存在旧消费者）。
3. 使用 fake module 验证四种 profile 的正常、失败、取消、超时、retry 和恢复边界。
4. 先在进程内 adapter 使用；有明确隔离需求时再增加 stdio/Unix Socket，最后才考虑 HTTP/RPC。

定向验证命令：

```text
pnpm exec tsc --noEmit
node --test dist/tests/protocol/module-protocol-contract.spec.js
pnpm run check:docs
git diff --check
git status --short
```

## 版本记录

| 版本 | 状态 | 主要变化 |
| --- | --- | --- |
| v0.1 | 归档 | 建立进程内、外部 worker 和远程服务的通信规则 |
| v0.2 | 归档 | 收敛跨语言模块接入规则，补充 retry、resume 和唯一终态 |
| v0.3 | 执行稿 | Module Protocol v2.0；按 profile 瘦身字段，移除 `attemptId`/`stepId` 的公共必填性 |
