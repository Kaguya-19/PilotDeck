# PilotDeck AgentLoop 模块接入开发 SOP

状态：执行稿
适用范围：PilotDeck AgentLoop 的新模块、sidecar、跨语言 adapter，以及 StaffDeck、DSH 或其他宿主的接入。
维护者：Agent Runtime 团队

本 SOP 规定一次模块接入从需求到发布的执行顺序。它不替代通信协议和架构文档：

- [Module Communication SOP](pilotdeck-module-communication-sop.zh.md) 定义 wire protocol、身份、状态、终态和恢复语义；
- [Module Protocol v2 Schema](pilotdeck-module-protocol-v2.schema.json) 是机器可校验的字段契约；
- [AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md) 定义 ports、adapter 和宿主 ownership；
- 本文定义开发活动、产物、测试门槛和发布检查。

## 1. 先确定问题和边界

开始改代码前，必须写出一页接入说明，回答以下问题：

1. 接入的是哪个宿主、哪个运行模式和哪个模块 profile：`unary`、`streaming`、`side_effect` 或 `tool`？
2. 哪些状态由宿主持有：session、turn、run、operation、transcript、checkpoint、lease 和最终结果？
3. 哪些能力由宿主提供：context、model、capability/tool、permission、持久化和状态查询？
4. 哪些字段是宿主业务字段，如何投影到通用 payload？
5. 是否需要跨语言、隔离、独立部署或不同生命周期？如果没有实际收益，优先使用进程内 adapter。
6. 取消、deadline、重试、断线、恢复和副作用确认由谁负责？

边界规则：

- AgentLoop 不识别宿主的 `TaskRequirement`、`TaskFrame`、Harness、租约或数据库对象；
- sidecar 不创建第二套 session/turn/run 状态，不聚合宿主最终 operation 状态；
- permission、tool 调度、checkpoint 持久化和用户可见结果的最终语义由宿主负责；
- 宿主专属字段只出现在宿主 glue 和 mapping，不进入 PilotDeck 默认 factory。

产物：`scope.md` 或设计任务单，包含 ownership 图、状态边界和明确的非目标。

## 2. 参考模块分层：DSH v0.1.2-alpha.2

PilotDeck 的模块划分参考 DeepSeek Harness DSH `v0.1.2-alpha.2` 的能力族设计，但不复制 DSH 的包名或 Cordis 实现。接入时应先确定功能属于哪一层，再决定它是 AgentLoop port、宿主 module 还是应用组合层。

| DSH 能力族 | 典型职责 | PilotDeck 对应边界 | 接入规则 |
| --- | --- | --- | --- |
| `core` | scope、session、system-prompt、tools、agent、agent-loop | AgentLoop 核心和宿主 session/context/tool port | 核心只消费 port；不依赖具体 provider |
| `llm` | 消息词汇、LLM registry、provider adapter、retry、token meter | `ModelInvokerPort` 和 model module | provider 协议只在 adapter 内转换为 canonical model events |
| `context` | workspace 指令、文件/会话引用、时间和运行位置 | `AgentContextRuntime` / context module | 模型可见上下文由宿主组装并可恢复，sidecar 不自行拼接宿主提示词 |
| `interaction` | approval、permission preset、user question、ask-user tool | permission module、交互能力和 `canPrompt` | 决策由宿主持有；未配置时不得默认放行 |
| 执行能力族 | fs、shell、terminal、code-runtime、subprocess、sandbox、web、lsp、skill、subagent、jobs、workflow、goal、todo、plan、attachment、spill | capability/tool module | 通过 `ToolPort` 或 capability descriptor 暴露；副作用、并发和超时由宿主执行层控制 |
| `session` / `storage` | 持久化、checkpoint、projection、query、telemetry、workspace、credentials、settings | 宿主数据平面 | 不下沉到 AgentLoop；seed state 只传可验证投影，宿主 opaque 状态由宿主恢复 |
| `api` / `host` / `client` | gateway、remote controller、HTTP、Web UI、SDK | transport 和产品入口 | 只负责路由和呈现，不在 Gateway 复制 AgentLoop 状态机 |
| `bundle` / `boot` / `extensions` / `hooks` | profile 组合、启动、动态插件和事件桥 | 部署组合和生命周期 | 通过 profile/capabilities 选择模块，不在默认 factory 写宿主特例 |

DSH 的三个可复用约定必须保留：

1. **Definition / Provider / Consumer 分离。** 先定义稳定的 service/port，再分别实现提供方和消费方；消费方不得依赖某个具体 provider。
2. **能力族独立演进。** 新功能加入已有能力族；只有存在清晰 ownership 和生命周期时才建立新 module/profile。
3. **组合代替分叉。** 用 profile、bundle、capability descriptor 和 adapter 组合模块，不复制一套带有相同 session 或最终状态的平行 runtime。

事件也按 DSH 的三类边界处理：持久事实进入宿主 session/event 日志；AgentLoop 运行状态使用实时 agent/stream event；能力策略通过 context、model、capability、permission 等 module seam 注入。模型可见输入必须能由宿主日志或显式恢复投影重建。

需要特别区分“能力族”和“协议模块”：DSH 的一个 package group 可以包含多个 provider、consumer 和持久化实现，不要求每个包都成为一个 Module Protocol endpoint。开发时按下面的顺序判定归属：

1. 改变消息循环、步骤边界或 AgentLoop 终态，才属于 `core/agent-loop`；没有明确核心语义变更时，优先放在 port 或 adapter。
2. 组装模型可见内容、系统提示词、引用或压缩策略，属于 `context`/`system-prompt`，由宿主提供 context module。
3. 访问模型提供方属于 `llm`/`model`，访问工具、文件、网络、sandbox 或外部副作用属于 `capability/tool`，两者都通过 provider port 接入。
4. 审批、问答和权限预设属于 `interaction`/`permission`，最终 allow/deny/ask 决策不能在 sidecar 复制。
5. 日志、checkpoint、投影、恢复、Gateway、UI 和 profile 组装属于宿主数据平面或应用层，不下沉到 AgentLoop。

因此，DSH 的 `core`、`llm`、`context`、`interaction` 等能力族是 PilotDeck 的模块设计参考；`session`、`api`、`bundle` 等仍然是宿主或部署层。只有在需要跨进程调用时，才把对应能力投影为 `hostModules.context`、`hostModules.capability` 或 model module，并通过 capabilities 协商。

产物：模块归属表、Definition/Provider/Consumer 关系图、profile/capability 选择说明。

## 3. 代码修改范围控制

每个开发任务必须先选定一个 DSH 能力族。PilotDeck 的代码修改只能落在 PilotDeck 语义上属于该能力族的文件、port、module adapter、协议类型或测试中；不能为了接入一个宿主而顺手修改其他能力族或复制宿主状态机。

| 目标能力族 | PilotDeck 可修改范围 | 默认禁止修改 |
| --- | --- | --- |
| `core` / AgentLoop | 类型、port contract、AgentLoop 工厂和 core 相关测试 | `src/agent/loop/AgentLoop.ts` 循环、重试、消息组装、工具调度和终态语义 |
| `llm` | `ModelInvokerPort`、model module、canonical model mapping 和 provider adapter | 宿主 provider 的业务重试、session 持久化或工具权限规则 |
| `context` | `AgentContextRuntime`、context module、messages/图片 mapping 和 context contract | 在 sidecar 拼接宿主专属 system prompt 或自行实现压缩/恢复状态机 |
| `capability` / tool | `ToolPort`、capability module、descriptor、batch/context mapping 和 adapter 测试 | 在 sidecar 重写 permission preflight、scheduler、工具副作用或宿主 tool policy |
| `interaction` / permission | permission context contract、module call 和 fail-closed mapping | 按工具名硬编码 allow/ask/bypass，或在 AgentLoop 外复制审批流程 |
| transport / protocol | Schema、协议 parser、sidecar lifecycle、identity/filter 和控制消息 | 修改宿主 session/turn/run 最终状态或用 transport 错误伪造业务成功 |
| 宿主集成 | 不在 PilotDeck core 修改；由 StaffDeck/DSH/第三方 glue 完成 | 把宿主 TaskFrame、Harness、租约、数据库对象加入 PilotDeck 默认 factory |

“不改 AgentLoop”是本 SOP 的默认门槛：接入、跨语言、sidecar 和 parity 修复不得修改
`src/agent/loop/AgentLoop.ts`。如果确实需要改变核心循环语义，必须另开 core 设计任务，先更新 TRD、协议影响分析和 direct/native 回归，再与宿主接入任务分开评审。

### 历史实现审计

本仓库已有的模块化基础提交需要与后续接入规则区分：

| 提交 | 事实 | 与当前 SOP 的关系 |
| --- | --- | --- |
| `e9f0cfb44` | 首次引入 ports、sidecar 和协议，并在 `AgentLoop.ts` 中把 Router/ToolScheduler 调用接到可替换 port | 文件范围上属于历史例外；改动目标是 seam wiring，不是宿主业务语义 |
| `bd9aad50d` | 完善 sidecar/factory mapping 和协议出口 | 未修改 AgentLoop 核心循环；符合 adapter/协议修补范围 |
| `07797eda0` | 补齐 context、batch、终态和对拍契约，并保留 port 接入 | 该提交本身未再修改 `AgentLoop.ts`，但所在分支包含前一基础提交的 seam wiring；不应作为以后宿主接入的先例 |

因此，历史记录不能表述为“从未修改过 `AgentLoop.ts`”。可验证的结论是：基础提交对
`AgentLoop.ts` 做了 88 行新增、40 行删除的 port wiring；当前分支已有 modular/native
对拍和 focused tests 用于证明默认 adapter 的语义保持。此后新增宿主、跨语言 sidecar 或
parity 修复必须遵守本节前述门槛，不再修改该文件；若必须改变核心语义，应另开 core
设计任务并单独评审。

代码评审必须检查 `git diff --name-only` 是否只包含所选能力族及其测试、文档；发现跨族修改时，提交必须拆分或给出明确的 ownership 和语义理由。

## 4. 阅读通信 SOP 并冻结版本

实现前按以下顺序阅读并记录适用版本：

1. 本文；
2. 与目标能力族对应的通信 SOP 章节；
3. JSON Schema；
4. 模块化 TRD；
5. 目标宿主的 integration 文档、现有 adapter 和回归测试；
6. 仓库 `AGENTS.md`、构建命令和运行环境说明。

模块通信必须以 [Module Communication SOP](pilotdeck-module-communication-sop.zh.md) 为准：

- model、capability/tool、permission、context 分别使用对应的 module profile 和 `module_call` 语义；
- transport adapter 不得自定义另一套 request/event/final envelope；
- `runId`、`operationId`、`requestId`、`streamId`、`sequence`、`toolCallId` 必须按 SOP 映射；
- cancel、deadline、resume、ack、`result_unknown` 和 idempotency 只在适用 profile 中实现；
- Schema、SOP、TRD、mapping 和测试不一致时，先修正契约和设计，再修改代码。

在设计任务中冻结：

- `protocolVersion`、`capabilitiesVersion` 和 profile；
- `runId`、`operationId`、`requestId`、`streamId`、`sequence` 和 `toolCallId` 的来源与作用域；
- 错误码、`retryability`、副作用等级和恢复方式；
- 必填、可选、未知字段和向后兼容策略。

改变字段必填关系或语义时必须升级协议版本或新增 profile，不得只修改实现后继续声称兼容。

## 5. 设计 mapping、TRD 和接口文档

### 5.1 Mapping 设计

先建立宿主字段到通用字段的逐项表，不直接在 sidecar 中猜测宿主对象：

| 宿主输入 | 通用 AgentLoop 输入 | 所有权和注意事项 |
| --- | --- | --- |
| session/turn/run identity | execution identity | 宿主生成，sidecar 原样透传 |
| prompt/transcript | canonical `messages` | 保持顺序；显式 messages 时不得重复拼接 task prompt |
| model config | `agent` 和 model module request | provider、model、limits 由宿主选择 |
| tool registry | tool descriptors | 透传 schema、交互能力、并发元数据 |
| permission state | `permissionContext` | 不能默认提升为 bypass，缺失时 fail closed 或按约定拒绝 |
| checkpoint | 可支持的 `seedState` + host opaque state | 不把宿主 checkpoint 强制伪装成 AgentLoop 状态 |
| cancel/deadline | control request / deadline fields | 宿主负责线性化和最终聚合 |

图片或其他媒体只在本次执行的 canonical message 中传输。需要持久化的宿主状态不能包含短生命周期 data URL。

### 5.2 TRD 和接口文档

TRD 至少说明：

- port 和 adapter 的职责；
- context、model、capability、permission 的调用方向；
- unary/streaming/batch 的时序；
- 正常、失败、取消、超时、`result_unknown` 和恢复路径；
- idempotency、并发、重试和副作用确认；
- direct/native 与 sidecar 的语义保持范围。

接口文档必须同时给出：

- Schema 引用；
- `hello`/`capabilities` 示例；
- execute、module_call、event、final response 示例；
- 错误码表和 retryability；
- cancel、status、resume、ack 的适用 profile；
- 一次成功、一次失败、一次断线恢复的完整消息序列。

产物：mapping 表、TRD 变更、接口示例、协议版本变更说明。

## 6. 先写契约失败测试

在实现前增加能够暴露错误映射的测试，至少覆盖：

- 缺字段、未知版本、非法终态和非法能力声明；
- 错误 `runId`、`operationId`、`requestId`、`streamId`；
- 重复 event、sequence gap、乱序和旧连接事件；
- 一个 request 多个 final、`ok: false` 被当作成功；
- `completed`、`failed`、`cancelled`、`result_unknown` 的分类；
- cancel/deadline 之后的迟到 completed；
- toolCallId、batch 结果数量和结果顺序；
- 图片 MIME/data、消息顺序和恢复消息顺序；
- permission 缺失、拒绝和 `canPrompt=false`；
- sidecar 断线、进程退出、非法 JSON 和重复 idempotency key。

这些测试应在 adapter 或协议层失败，而不是依赖真实模型才能发现问题。

## 7. 实现模块和 adapter

推荐顺序：

1. 更新 Schema 和协议类型；
2. 实现或更新宿主 client、module bridge 和 context/model/tool/permission port；
3. 实现 sidecar 输入 mapping 和终态出口；
4. 添加 transport adapter（stdio、Unix Socket、HTTP/RPC 或 WS）；
5. 接入真实宿主状态、持久化和取消信号；
6. 保留 direct/native 路径，确保 feature flag 关闭时行为不变。

实现约束：

- 不修改 `AgentLoop.ts` 核心循环来补宿主业务语义；
- 不在 sidecar 内生成宿主专属 system prompt、Harness action 或 permission 规则；
- 不静默吞掉模型、工具或权限错误；
- 不把 `AbortSignal` 序列化，取消应通过协议传播并由宿主重新绑定；
- tool batch 由宿主 scheduler 决定 permission preflight、并发和结果顺序；
- final payload 保留结构化 result、stop reason、usage、errors 和 structured output。

### 7.1 当前 PilotDeck 实现参考

下面的代码片段对应当前仓库的模块化实现，目的是说明“宿主如何接入”，不是要求每个宿主复制
同一份实现。接入第三方宿主时，只替换 host module、port provider 和 transport adapter；
`AgentLoop` 的循环、重试和终态逻辑继续复用。

#### A. 先定义宿主无关 execute payload

默认 sidecar factory 接收的是通用 payload。宿主业务对象在自己的 glue 中投影为
`agent`、`messages`、`tools`、`permissionContext`、`seedState` 和 `executionContext`：

```json
{
  "kind": "request",
  "messageId": "execute-1",
  "method": "execute",
  "runId": "run-1",
  "operationId": "operation-1",
  "requestId": "attempt-1",
  "sessionId": "session-1",
  "turnId": "turn-1",
  "payload": {
    "agent": {
      "provider": "openai-compatible",
      "model": "model-id",
      "cwd": "/workspace",
      "systemPrompt": "宿主显式提供的系统提示",
      "permissionMode": "default"
    },
    "messages": [
      {"role": "user", "content": [{"type": "text", "text": "执行任务"}]}
    ],
    "tools": [{
      "name": "lookup",
      "description": "查询信息",
      "kind": "custom",
      "inputSchema": {"type": "object"},
      "readOnly": true,
      "concurrencySafe": true,
      "requiresUserInteraction": false
    }],
    "permissionContext": {
      "mode": "default",
      "canPrompt": false,
      "bypassAvailable": false,
      "rules": {"allow": [], "deny": []}
    },
    "seedState": {"allowedReadFiles": ["/workspace/input.txt"]},
    "executionContext": {"source": "host", "remainingActions": 1}
  }
}
```

对应实现入口是 [`createSidecarExecution`](../src/cli/pilotdeck-agent-loop-default-factory.ts)。
它只读取通用字段，并将其转换为 `AgentRuntimeConfig`、canonical messages、tool
descriptors 和 `AgentLoop` input；不能在这里读取 `TaskFrame`、Harness 或其他宿主对象。

#### B. 在宿主侧实现 model/tool/context module

sidecar 通过 `module_call` 请求宿主能力。下面是宿主 adapter 的最小 dispatch 形态：

```ts
async function dispatchModule(call: ModuleCall, signal: AbortSignal) {
  if (call.module === "model") {
    const prepared = await modelPort.prepare({
      request: call.payload.request,
      context: { ...call.payload.context, abortSignal: signal },
    });
    const events = [];
    for await (const event of modelPort.stream({
      prepared,
      context: { ...call.payload.context, abortSignal: signal },
    })) events.push(event);
    return { events };
  }

  if (call.module === "capability") {
    const calls = call.payload.operation === "execute_batch"
      ? call.payload.calls
      : [{ toolCallId: call.payload.toolCallId, name: call.payload.name,
          arguments: call.payload.arguments }];
    const results = await toolPort.executeAll(calls, {
      ...call.payload.context,
      abortSignal: signal,
    }, { ...call.payload.execution, abortSignal: signal });
    return call.payload.operation === "execute_batch" ? { results } : results[0];
  }

  if (call.module === "context") {
    return { result: await contextRuntime.prepareForModel({
      ...call.payload.input,
      abortSignal: signal,
    }) };
  }

  throw new Error(`Unsupported host module: ${call.module}`);
}
```

当前 sidecar host adapter 的完整参考见 [`createSidecarPorts`](../src/agent/modules/sidecar.ts)
和对拍 gateway adapter 的 [`dispatchModule`](../tools/agent-loop-parity/adapters/pilotdeck_gateway_impl.mjs)。
真实宿主应把 `modelPort`、`toolPort`、`contextRuntime` 和 permission runtime 绑定到自己的
session/operation；sidecar 不自行执行宿主工具，也不自行决定权限。

#### C. 声明能力并保持兼容回退

宿主只有实现了对应方法，才在 execute payload 声明能力：

```json
{
  "hostModules": {
    "context": {"methods": ["prepare_for_model", "capture_turn"]},
    "capability": {"methods": ["execute", "execute_batch"]}
  }
}
```

`execute_batch` 未声明时，sidecar 回退到 unary capability call；context 未声明时使用
默认 context runtime。这个协商逻辑位于 [`pilotdeck-agent-loop-default-factory.ts`](../src/cli/pilotdeck-agent-loop-default-factory.ts)
和 [`sidecar.ts`](../src/agent/modules/sidecar.ts)，不要在宿主业务代码中复制一套判断。

#### D. 取消、deadline 和终态只通过协议传递

宿主发送控制消息，sidecar 返回协议终态；宿主负责将终态写入自己的 operation 状态：

```json
{"kind":"request","messageId":"cancel-1","method":"cancel",
 "runId":"run-1","operationId":"operation-1","reason":"user_cancelled"}
```

```json
{"kind":"event","eventType":"execute.final","final":true,
 "runId":"run-1","operationId":"operation-1","requestId":"attempt-1",
 "outcome":"failed","code":"DEADLINE_EXCEEDED",
 "payload":{"result":{"type":"error","stopReason":"deadline_exceeded"}}}
```

宿主 adapter 必须校验 identity、sequence 和唯一 final；连接断开或副作用状态未知时使用
`result_unknown`/reconciliation，而不是根据最后一段文本猜测成功。参考实现见
[`AgentLoopSidecarServer`](../src/agent/modules/sidecar.ts)。

#### E. 最小接入和验证顺序

以当前 PilotDeck 模块接入为例，代码提交应按以下顺序落地：

1. 在宿主 glue 中生成上面的通用 payload 和 identity mapping；
2. 实现 model、capability、context module dispatch，并声明 `hostModules`；
3. 只在必要时实现 stdio/HTTP/WS transport adapter，先保留 direct/native 路径；
4. 增加 malformed、cancel、deadline、permission、batch、seedState 和终态契约测试；
5. 运行 `pnpm build`、modular focused tests 和 gateway native/sidecar 对拍；
6. 将命令、commit、运行时版本、退出码和 known gap 记录到实验结果文档。

对拍工具的具体入口是 [`tools/agent-loop-parity/README.md`](../tools/agent-loop-parity/README.md)。
它使用本地确定性 mock provider/tool；真实宿主接入仍必须额外执行本地 Gateway、session、
permission、tool 和 sidecar 进程的端到端验证。

## 8. 分层验证

按风险从小到大运行：

### 8.1 静态和构建检查

```text
pnpm build
pnpm exec tsc --noEmit
```

当前 `package.json` 没有名为 `check` 的 script；不要把不存在的 `pnpm check` 当作通过条件。
协议和文档检查使用 focused tests、`pnpm exec tsc --noEmit` 与 `git diff --check`。

Python 宿主同时运行项目约定的 Ruff、类型检查和 focused pytest。确认 sidecar 使用要求的 Node 版本，宿主使用指定的 Python virtualenv。

### 8.2 单元和协议契约测试

覆盖 parser、identity filter、sequence 去重、deadline timer、终态 mapping、seedState、图片 message、tool batch 和 permission adapter。

### 8.3 Direct/native 回归

关闭 sidecar feature flag，运行原有 AgentLoop、session、tool、permission、context 和 checkpoint 测试。任何 legacy 行为变化都必须单独解释，不能归因给 sidecar。

### 8.4 确定性 mock 对拍

使用相同的 `q`、scenario、模型响应和工具响应，比较 native/direct 与 sidecar：

- system prompt、messages 和媒体 block；
- 模型请求/响应和 attempt；
- 工具名称、参数、开始/完成顺序和结果；
- permission decision、错误码和 retryability；
- checkpoint/seed 恢复投影；
- terminal outcome、stop reason、usage 和用户输出。

只忽略随机 ID、时间戳和 transport envelope。任何其他差异都必须输出最早分叉路径、两侧规范化值和上下文。

### 8.5 真实端到端部署

mock 对拍通过后，启动真实 Gateway、HTTP/WebSocket、Session、ContextRuntime、ToolRuntime、PermissionRuntime、持久化和 sidecar 进程。验证：

- sidecar 启停和连接断开；
- cancel、deadline 和迟到事件；
- sidecar 重启、status/resume/ack 和 cursor；
- 副作用未知时的 `result_unknown`、lease、fencing、requeue 和幂等恢复；
- 前端发起请求到最终用户回复的完整链路。

## 9. 场景矩阵和差异归因

每次接入至少运行以下场景：

- 纯文本、单工具、多工具和批量工具；
- permission allow/ask/deny、`canPrompt=false`；
- 模型临时错误、不可重试错误、非法响应和流中断；
- tool error、超大工具结果和工具执行取消；
- attempt/operation deadline；
- 图片/多模态消息；
- 模型前、工具后和工具结果回写后的 checkpoint 恢复；
- duplicate execute、旧 request/stream event、进程退出和重启；
- 宿主特有的 SOP、handoff、team、scheduled、slot、dependency 和 action budget。

差异必须归类为：

1. mapping/adapter 缺陷；
2. 协议实现缺陷；
3. PilotDeck core 行为差异；
4. 宿主 legacy 行为差异；
5. 测试设施缺陷；
6. 明确的 known gap。

不得通过宽泛 normalization 隐藏未声明差异。known gap 必须稳定复现、单独列出，并不计入零差异 gate。

## 10. 发布前检查和回滚

提交前必须确认：

- 文档、Schema、测试和实现同步；
- direct/native 回归通过；
- 适用场景的真实对拍和端到端部署通过；
- 没有 token、真实 API key、数据库、trace、日志、coverage 或临时 worktree；
- `git diff --check` 无输出；
- `git status --short --branch` 只包含预期文件。

建议拆分提交：

1. Schema/协议和契约测试；
2. PilotDeck 通用 adapter/sidecar；
3. 宿主 glue 和真实部署 harness；
4. 文档和实验结果。

发布时记录 commit、Node/pnpm/Python 版本、命令、退出码、适用 profile、known gaps 和产物目录。出现严重行为回归时，关闭 sidecar feature flag 或回滚 adapter 提交；不得删除宿主 checkpoint 或盲目重试非幂等副作用。

## 11. 接入任务模板

每个接入任务至少附带以下清单：

```text
[ ] 宿主和 AgentLoop ownership 已确认
[ ] protocol/profile/version 已冻结
[ ] mapping 表和 TRD 已完成
[ ] Schema、接口示例和错误码已更新
[ ] 契约失败测试已先添加
[ ] context/model/tool/permission adapter 已实现
[ ] direct/native 回归通过
[ ] mock provider/tool 对拍通过
[ ] 真实 Gateway/sidecar 端到端通过
[ ] cancel/deadline/resume/idempotency 已验证
[ ] known gap 已单独记录
[ ] 文档、提交范围和敏感产物检查通过
```

完成上述清单后，才可以将接入标记为“可验收”。只完成编译或单个成功案例，不能视为模块化接入完成。
