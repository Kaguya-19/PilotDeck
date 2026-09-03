# LLM 调用日志存储 TRD

文档状态：评审中　优先级：P0　维护者：Runtime / Data Loop 团队

## 1. 背景与目标

当前 `inference_request_logs` 已能承载一次推理调用的基础统计，但缺少模型边界上的完整 request/response。需求一要求主 session、子 session 的每次真实 LLM 调用都可离线还原，尤其不能丢失 Anthropic thinking block 的顺序和 signature。

本 TRD 定义：

- 一次模型调用的日志粒度、字段和 session 关联关系；
- 在 provider 请求边界捕获原始 request/response 的时机；
- retry、fallback、流式中断和子 agent 的记录语义；
- 持久化失败时对 Agent 主流程的影响、幂等和验收方式。

本 TRD 不定义 workspace 快照文件内容、训练集加工、线上查询页面和具体数据库/对象存储供应商的采购方案。存储后读下载权限沿用数据存储总方案的白名单策略。

## 2. 设计决策

1. **以 provider boundary 为唯一采集点。** 日志必须在最终 provider-native body 形成后、发送 HTTP/SDK 请求前创建；不得从 canonical request 或 normalize 后的响应反推。
2. **一次真实 provider attempt 一条记录。** retry、fallback 和流式 continuation 都会产生独立记录，并用 `logical_call_id` 聚合到同一次 Agent 模型步骤。
3. **原始 payload 是事实来源。** `llm_request` 和 `llm_response` 保存发送/接收的 UTF-8 原始字节；不 trim、URL decode、改写 `+` `/` `=`，不把 Anthropic 格式转换成 OpenAI 格式。解析后的结构只能作为查询投影，不能覆盖原文。
4. **完整性优先于主流程成功。** 日志写入采用异步 outbox；数据库或对象存储短暂不可用时，Agent 请求、重试、取消和返回结果不被日志写入阻塞。
5. **主 session 与子 session 使用同一张逻辑表。** 子 agent 的记录归属子 session，同时保留父 tool call 关联，能够从主调用跳转到完整子调用链。

### 2.1 存储目标与身份配置

存储目标不得写死在代码、镜像或请求参数中，由部署配置注入并带版本号：

| 配置项 | 类型 | 说明 |
|---|---|---|
| `database.url` | secret/reference | `inference_request_logs` 和 outbox 的数据库地址；通过 secret/config provider 提供，不写入日志。 |
| `database.schema` / `database.table` | string | 目标 schema/table，默认值由部署配置显式给出。 |
| `payloadStore.type` | enum | `database`、`private_fs` 或 `object_store`；决定超长 payload 的正文落点。 |
| `payloadStore.endpoint` / `payloadStore.root` | string | 私有路径或对象存储 endpoint/bucket/prefix；必须是受部署信任的配置，禁止请求覆盖。 |
| `workspace_id` | string | 逻辑 workspace 归属；由 Gateway 根据 PilotDeck 当前 workspace/project 解析，不能用用户消息覆盖。 |
| `session_id` | string | 当前 session 归属；由 Agent/Gateway 运行时注入，不能由存储适配器生成。 |

配置来源可为环境变量、配置文件或配置中心，优先级和热更新规则由部署平台统一定义。启动时校验数据库地址和 payload store 可达性；运行时缺少 `workspace_id`、`session_id`、`turn_id` 或 `run_id` 时拒绝创建完整日志，不能静默写入默认 workspace/session。每次 attempt 记录 `storage_config_version`，配置切换不影响已提交记录的读取。`workspace_id` 与 `session_id` 是写入目标的运行时路由键，不接受用户消息直接覆盖。

## 3. 记录模型

### 3.1 逻辑字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `request_log_id` | 是 | 单条 attempt 的全局唯一 ID。 |
| `logical_call_id` | 是 | 一次 Agent 模型步骤的 ID；同一逻辑调用的 retry/continuation 共用。 |
| `request_id` | 是 | 单次 provider 请求身份；每个真实 HTTP/SDK attempt 独立生成。 |
| `workspace_id` | 是 | 逻辑 workspace 归属，由运行时上下文注入。 |
| `session_id` | 是 | 当前拥有该调用的 session。主 agent 使用主 session，子 agent 使用子 session。 |
| `sub_session_id` | 否 | 子 agent 调用填写子 session ID；主 agent 为 `NULL`。首期与子 session 的 `session_id` 相同，保留该字段便于跨 session 查询。 |
| `parent_tool_call_id` | 条件必填 | 子 agent 必填，指向父 session 发起 fork 的 tool call；主 agent 为 `NULL`。 |
| `turn_id` | 是 | Agent turn ID。 |
| `run_id` | 是 | Gateway active run ID。当前 `RouterExecuteContext` 尚未携带该字段，接入时需由 Gateway 向 Router/ModelRuntime 透传。 |
| `attempt` | 是 | 同一 `logical_call_id` 内从 1 开始递增，不能复用。 |
| `retry_reason` | 否 | `network_error`、`server_error`、`continuation`、`fallback` 等；首次调用为 `NULL`。 |
| `caller` | 是 | `agent`、`subagent` 或 `router_judge`，用于区分 Agent 主链和路由器内部 LLM。 |
| `provider` / `protocol` / `model` | 是 | 实际选中的 provider、协议和模型，不使用原始请求中的候选值。 |
| `stream` | 是 | 是否使用流式传输。 |
| `llm_request` | 是 | provider-native 请求原文；见 3.2。 |
| `llm_response` | 条件必填 | provider-native 响应原文；收到响应后写入。无响应的传输错误为 `NULL`。 |
| `request_bytes` / `response_bytes` | 是 | 原始字节数，便于完整性检查和容量分析；不用于截断。 |
| `http_status` | 否 | 收到 HTTP 响应时记录状态码，包含非 2xx。SDK 无 HTTP 状态时可为空。 |
| `outcome` | 是 | `success`、`provider_error`、`transport_error`、`aborted`、`timeout`、`incomplete`。 |
| `response_complete` | 是 | 是否收到完整 provider 响应；流式中断、超时或解析失败为 `false`。 |
| `started_at` / `completed_at` | 是 | provider attempt 的开始和结束时间。 |
| `traffic_type` / `eval_run_id` / `eval_case_id` | 按 session 继承 | 评测入口产生的调用必须继承 session 的 `eval` 标识，线上流量不得填成 `eval`。 |

`request_log_id`、`request_id`、`logical_call_id` 使用不可预测的应用层 ID；建议唯一约束为 `(logical_call_id, attempt)`，并以 `request_id` 作为重试写入的幂等键。

### 3.2 原始 payload 存储

- `llm_request` 必须是最终发送内容：包括 provider-specific 字段、`extraBody` 合并结果、工具 schema 和历史 thinking block。请求落库点位于 `sendProviderRequest` 或等价 SDK transport 之前。
- `llm_response` 对非流式请求保存收到的完整响应 body，包括非 2xx 的 provider 错误 body。解析器只消费 body 的副本。
- 数据库字段不能使用有固定长度上限的 `VARCHAR(n)`，也不能在 ORM/序列化层设置静默截断。优先使用无长度上限的 `TEXT/BYTEA`；若平台不适合存放超长内容，则按当前 `payloadStore` 配置写入私有对象存储，字段保存不可歧义的对象指针、媒体类型、编码和字节数，指针本身不得替代完整对象。
- 对象 key 必须由 `request_log_id`、payload 类型和版本组成，写入采用临时对象加原子提交；数据库记录只有在对象可读后才标记为 `available`。历史对象不得因同一路径覆盖而删除。
- 原始 payload 与查询投影分离。可选的 `parsed_request`/`parsed_response` 只用于检索，不参与回放，也不得删除 `signature`、数组顺序或未知字段。

### 3.3 流式响应语义

HTTP/SSE 流本身不是单个 JSON 文档，因此流式 attempt 必须保存：

1. `llm_response` 对应的完整原始 SSE 字节序列（含事件顺序、换行和终止 sentinel）；
2. `response_content_type`、`response_complete` 和 `received_until` 等元数据；
3. 可选的 provider-native assembled response 投影，用于查询，不作为原文。

收到完整终止事件后才写 `response_complete=true`。网络断开、idle timeout、最大时长、用户取消或 parser error 均保留已收到的字节并写 `response_complete=false`，同时记录 `outcome` 和错误码。

## 4. 调用链集成

### 4.1 ModelRuntime / provider transport

在 `src/model/streaming/streamModel.ts` 的 `complete`、`streamModel` 以及 Google SDK 分支统一接入 `ModelInvocationLogSink`：

1. 由调用方传入 `InvocationContext`（session、sub session、turn、run、logical call、caller）。
2. 构造 provider-native body，并合并 provider 额外 body 后生成 `request_id` 和 `attempt` 记录。
3. 调用 `sendProviderRequest` 或 Google SDK 前提交 request outbox；提交失败只写本地可重试 outbox，不阻断发送。
4. 非流式先读取原始 bytes，再分别交给错误归一化和成功解析器；将同一 bytes 写入 response outbox。Google SDK 若只返回已解析对象，必须增加 transport/raw-response hook，不能用重新序列化对象冒充 provider 原文。
5. 流式对 `Response.body`/SDK iterator 做 tee 或受控缓冲，parser 与原始字节收集器各消费一份；结束、异常和 abort 路径都必须 flush 一次且只能完成一次。
6. 发送失败且没有 response 时仍完成该 attempt 记录，`llm_response=NULL`；后续 retry 不更新旧记录。

`ModelRuntimeOptions` 需要新增日志 sink、调用上下文和已解析的存储配置，但不得让 provider adapter 自行生成第二套 session/turn 状态。存储配置只在 Gateway/Runtime 边界解析一次，底层 adapter 只接收不可变配置快照。

### 4.2 Router

`RouterRuntime.execute` 是主 Agent 调用模型的统一入口。它负责把 `RouterExecuteContext` 中的 `sessionId`、`turnId`、`runId` 和 `isMainAgent` 转成 `InvocationContext`，并传递实际 decision 的 provider/model。Router 的 token-saver/judge 若直接调用 LLM，也使用同一 sink，`caller=router_judge`，不能冒充 Agent attempt。

路由 fallback 只改变后续 attempt 的 provider/model；前一个 attempt 保留原记录。统计事件仍由 Router 负责，完整 payload 不在 Router 另存一份。

### 4.3 AgentLoop 与子 agent

- 主 AgentLoop 使用其 `run({ sessionId, turnId })` 的身份创建调用上下文。
- `SubAgentSession` 已生成独立的 `subagentSessionId`，并持有 fork 参数中的 `toolCallId`。创建子 AgentLoop 时将二者作为 `sub_session_id` 和 `parent_tool_call_id` 透传到 ModelRuntime。
- 子 agent 的每次模型调用写入子 session；父 session 只记录发起子 agent 的 tool call，不把子 agent response 复制到父 request log。
- 子 agent 结束、失败或中断后，已提交的 attempt 日志保持不变；不得因父 turn 结束而删除或改写子 session 历史。

## 5. 生命周期与异常处理

```text
created(request) -> request_staged -> sent
sent -> response_staged -> persisted
sent -> transport_error|timeout|aborted
response_staged -> persisted(success|provider_error|incomplete)
```

- `request_staged` 必须发生在 provider 请求发送前；没有该事件不得发送“成功调用”日志。
- response 持久化失败进入 outbox 重试，按 `request_id` 幂等；达到重试上限转入 dead-letter 并告警，但不重放 provider 请求。
- 进程在 request/response 之间崩溃时，由 outbox 恢复任务补齐 `outcome=unknown` 或已有的 partial 状态，不能伪造完整 response。
- 日志 sink、数据库、对象存储的超时使用独立预算，不复用模型请求的 AbortSignal；用户取消模型请求时仍尽力保存已收到内容。
- 日志不参与 Agent 的 retry 判定。模型请求是否 retry 仍由现有 provider error/stream interruption 逻辑决定。

## 6. 数据访问与容量

- 业务库只开放白名单环境的读和下载能力；写入由服务账号完成。新增集群通过配置/策略白名单加入，不改业务代码。数据库地址、schema/table 和 payload store 均由部署配置决定，不允许在代码中内置线上地址。
- 超长 payload 的下载接口必须根据 `request_log_id` 返回完整原文或对象指针，不返回截断预览冒充原文。
- 生产日志和评测日志按 `env`/`traffic_type` 可完整过滤；评测入口写入的 `eval_run_id`、`eval_case_id` 在 session 与每条 request log 上保持一致。
- 需要在上线前确认数据库单行上限、对象存储生命周期、保留期限、并发上传上限和告警阈值；这些参数不作为代码中的隐式截断条件。

## 7. 测试与验收

### 7.1 确定性测试

| 场景 | 验收点 |
|---|---|
| 主 session 非流式成功 | request 在发送前写入，response 完整写入，session/turn/run/request identity 全部一致。 |
| 子 session 成功 | `sub_session_id` 和 `parent_tool_call_id` 正确，父子记录可关联，未复制 response。 |
| Anthropic 多轮 thinking | request 中历史 thinking block 的顺序、`type` 和 signature 原样存在。 |
| 非 2xx / provider error | 保留完整错误 body、HTTP 状态和错误码。 |
| 流式成功 | 原始 SSE 字节顺序和 sentinel 保留，`response_complete=true`。 |
| 流式 timeout/abort/parser error | 保留 partial bytes，`response_complete=false`，只完成一次 attempt。 |
| retry/fallback/continuation | 每个真实 attempt 一条记录，attempt 单调递增，request body 不互相覆盖。 |
| sink/DB/OSS 故障 | Agent 主流程仍返回原有结果；outbox 可重试且重复消费幂等。 |
| 超长 payload | 不发生静默截断；inline 或对象指针均可下载完整原文。 |
| 配置切换/隔离 | 不同 `workspace_id`/`session_id` 按配置前缀隔离；切换配置后旧记录仍可按 `storage_config_version` 读取。 |
| eval 标识 | eval session 及其所有 request log 带有一致的 `traffic_type` 和 run/case ID。 |

### 7.2 验收标准

- 随机抽取的主 session、子 session 和 retry 链均可从日志还原 provider 请求顺序及完整原文。
- 对同一 attempt 重复投递不会产生重复记录，也不会覆盖其他 attempt。
- 日志落库异常不会改变模型请求的成功、失败、取消、超时和 retry 结果。
- 读白名单环境可以直接下载 inline 或对象存储中的完整 request/response；无写权限。

## 8. 实施拆分与待确认项

1. **Schema/存储适配器**：扩展 `inference_request_logs` 和 outbox，增加 `workspace_id`、`storage_config_version`，确定 TEXT/BYTEA 与对象指针的阈值和状态字段。
2. **ModelRuntime 埋点**：覆盖普通 provider、Google SDK、非流式、流式、错误和 abort 路径。
3. **上下文透传**：Gateway -> AgentLoop -> Router -> ModelRuntime 补齐 `workspace_id`、`session_id`、`run_id`、`logical_call_id` 和子 agent lineage；同时透传不可变的 storage config snapshot。
4. **回归与连调**：先用本地 mock provider 验证原文和异常路径，再由本周本地连调确认数据库/对象存储读写，下周验证线上版本。

上线前由数据平台确认：现有 `inference_request_logs` 的真实 schema、数据库地址配置方式、workspace/session identity 来源、私有对象存储的可用写入接口、超长对象阈值和保留策略；在这些信息确认前不提交生产 schema migration。
