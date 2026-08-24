# Agent Loop 技术设计与建设路线图

文档状态：评审中
维护者：Agent Runtime 团队
目标读者：Agent Runtime、Gateway、Router、Tool、Session、UI 和测试维护者
适用版本：当前 `main` 分支及后续 Agent Loop 相关改动

## 1. 背景与目标

PilotDeck 的 Agent Loop 负责把一次用户 turn 变成可恢复的模型/工具执行过程。它不是单独的模型调用函数，而是连接 Gateway、Session、Context、Router、Model Provider、Tool Runtime、Permission 和 Transcript 的核心编排边界。

当前实现已经支持：

- 多轮模型请求与工具调用循环；
- Router 决策、fallback/retry 和 provider stream 事件归一化；
- 自动 compaction、上下文预算和模型输出截断恢复；
- permission/elicitation、abort、timeout 和 session busy 约束；
- tool result 配对、失败恢复、subagent 和文件 artifact 收集；
- transcript 持久化、session title 和 Agent 状态事件。

本 TRD 的目标是把这些行为写成可维护的功能契约，并按风险安排后续测试和重构。目标不是重写 `AgentLoop`，也不是把所有外部模型或平台链路塞进普通单元测试。

细粒度边界已拆分到 [`docs/trd/03-agent-loop.zh.md`](trd/03-agent-loop.zh.md)、[`docs/trd/07-token-budget.zh.md`](trd/07-token-budget.zh.md)、[`docs/trd/08-prompt-projection.zh.md`](trd/08-prompt-projection.zh.md)、[`docs/trd/09-compaction-engine.zh.md`](trd/09-compaction-engine.zh.md)、[`docs/trd/10-micro-compaction.zh.md`](trd/10-micro-compaction.zh.md)、[`docs/trd/11-context-recovery.zh.md`](trd/11-context-recovery.zh.md)、[`docs/trd/12-memory-runtime.zh.md`](trd/12-memory-runtime.zh.md) 和 [`docs/trd/13-attachment-context.zh.md`](trd/13-attachment-context.zh.md)。

## 2. 非目标

- 不新增第二套 Agent 状态机；Gateway 仍是 session、turn、active-run 的事实来源。
- 不改变现有 Gateway RPC、事件名称、模型 provider 协议或持久化字段，除非另有独立协议变更。
- 不承诺真实模型、网络、浏览器、Docker、桌面或平台账号在普通 PR 中运行。
- 不用 snapshot 自动写回、扩大 `any`、关闭 strict 或删除失败测试来提高通过率。
- 不把 Router、Context、Tool 或 Session 的所有实现细节复制进本文件；本文件只定义 Agent Loop 的边界和交互契约。

## 3. 系统边界与调用链

```text
WebSocket / REST client
        |
        v
InProcessGateway.submitTurn / GatewayWsConnection
        |
        v
RouterRuntime.getOrCreate
        |
        v
AgentSession.submit
        |
        v
TurnRunner.run
        |
        v
AgentLoop.run
   |              |
   v              v
ContextRuntime   RouterRuntime.decide/execute
                  |
                  v
          Model Provider stream
                  |
                  v
          ToolScheduler/ToolRuntime
```

### 3.1 代码边界

| 边界 | 当前实现 | 职责 |
| --- | --- | --- |
| Gateway 入口 | `src/gateway/client/InProcessGateway.ts`、`src/gateway/server/GatewayWsConnection.ts` | 鉴权、busy-session、run identity、事件流和 abort 生命周期 |
| Session 编排 | `src/agent/session/AgentSession.ts` | 管理 session 状态、turn ID、abort controller、累计消息和 usage |
| Turn 包装 | `src/agent/turn/TurnRunner.ts` | 接受输入、写 transcript、生命周期 hook、title 和 artifact |
| 核心循环 | `src/agent/loop/AgentLoop.ts` | context、模型请求、工具调用、恢复和最终结果 |
| Router/模型 | `src/router/RouterRuntime.ts` 及 `src/model/**` | 模型选择、请求执行、provider 事件和 fallback |
| 工具执行 | `src/tool/**` | registry、permission、scheduler、tool result |
| 持久化 | `src/session/transcript/**`、`src/session/artifacts/**` | accepted input、事件、消息、artifact 和 replay |

## 4. 核心状态机

### 4.1 Turn 状态

```text
idle
  -> accepting
  -> running_model
  -> tool_pending
  -> running_model       (tool result 已配对，继续下一轮)
  -> completed

任意运行态 -> aborting -> aborted
任意运行态 -> failed
任意运行态 -> timed_out -> failed/aborted
```

状态由 `AgentSession`、Gateway active-run 记录和事件流共同表达。`AgentLoop` 负责产生结果和事件，但不得创建独立的 session 状态来源。

### 4.2 一轮模型/工具循环

`AgentLoop.run()` 的每次循环必须按以下顺序执行：

1. 检查 `abortSignal`，已取消时不得发起新的模型或工具调用。
2. 根据当前 messages 执行 pre-routing context 检查和 auto-compaction。
3. 创建 canonical model request，并发出 `model_request_started`。
4. 调用 `RouterRuntime.decide()`，必要时按路由后的上下文窗口再次 compaction。
5. 调用 `RouterRuntime.execute()`，消费 provider stream 并组装 assistant message。
6. 对 stream 终态、usage、finish reason、malformed 内容和 provider error 做归一化。
7. 提取和修复合法 tool calls；没有 tool call 时进入完成/恢复/失败分支。
8. 有 tool call 时交给 `ToolScheduler.executeAll()`，持续转发 tool/subagent 状态事件。
9. 对每个 tool call 生成恰好一个 result，写入下一轮 messages。
10. 重新进入循环，或生成唯一的 `turn_completed` 终态。

### 4.3 终态契约

每次 `AgentLoop.run()` 必须返回 `AgentLoopRunResult`，并满足：

- `success`：有可接受的完成结果，允许没有文本但必须有明确状态事件；
- `error`：错误被归一化为稳定的 agent error/stop reason；
- `aborted`：由 abort signal、连接关闭或用户 Stop 导致，不得伪装成模型失败；
- 工具调用不可安全执行时，必须生成缺失/失败 result，不得让模型上下文出现悬空 tool call；
- 终态事件最多一次，且 `sessionId`、`turnId`、`runId` 在适用时保持一致。

## 5. 功能契约

### 5.1 输入接受与消息边界

- `TurnRunner` 先通过 `TurnInputProcessor` 规范化输入，再记录 accepted input。
- `AgentLoop` 接收 canonical messages；不得修改调用方持有的原始数组或历史对象。
- synthetic prompt 必须带 `synthetic/transient` metadata，并在被消费后清理。
- `modelOverride` 只影响当前 turn，不能覆盖持久化的全局配置或 Router sticky 状态。

### 5.2 Context 与 compaction

- pre-routing 和 post-routing 的 context budget 都必须使用实际目标模型的窗口。
- compaction 失败不能把可恢复的旧 snapshot 替换为空内容。
- compaction 后必须持久化边界并重新建立 model request；不能继续使用旧 messages。
- 超出 emergency compaction 能力时，返回结构化 `prompt_too_long` 错误并结束 turn。

### 5.3 Router 与模型协议

- Router 只决定 provider/model 和执行策略，不得修改用户消息或历史。
- `decide()` 与 `execute()` 分离，以便在路由后重新计算 context budget。
- provider stream 必须转换为 canonical assistant message；重复、乱序、malformed 和终态错误交由模型协议层处理。
- fallback、retry 和 zero-usage retry 必须保留可审计的 request identity，不得把失败 attempt 当成最终成功结果。

### 5.4 Tool 与权限

- tool calls 进入 `ToolScheduler` 前必须经过 registry 和 permission/safety 约束。
- plan、bypass、session allow 不能绕过 safety deny 或显式拒绝。
- 工具结果必须按 tool call ID 配对；scheduler 异常时为未完成调用生成失败结果。
- 工具执行期间应继续泵出 `pre_tool_execute`、`post_tool_execute`、subagent 和 heartbeat 状态，避免 UI 看起来无响应。

### 5.5 输出恢复

Agent Loop 当前包含多种单次或有界恢复策略：

| 场景 | 恢复行为 | 终止条件 |
| --- | --- | --- |
| `prompt_too_long` | compaction 后重试 | emergency compaction 仍失败 |
| `max_output_reached` | 增加受限 output cap 或注入 continuation prompt | 达到恢复上限 |
| 空 assistant 输出 | 注入 visible-output prompt | 连续空响应达到上限 |
| partial/unparsed tool call | 修复或要求模型重新输出 | 修复上限耗尽 |
| 重复 tool failure | 注入纠错提示或停止 | 相同 fingerprint 达到阈值 |
| 图片请求失败 | 一次性移除图片并重试 | 已尝试 image-strip recovery |
| 大文件/截断结果 | 结构化恢复提示和受限输出 | `LargeFileRepair` 判定不可恢复 |

所有恢复都必须有明确计数器、事件或 status，不能无限循环。

### 5.6 Transcript、artifact 与 title

- accepted input、assistant message、tool result、compaction boundary 和终态必须按 turn 顺序写入 transcript。
- 文件 artifact 收集失败不得使主 turn 崩溃；成功收集的 artifact 必须与 session/turn 绑定。
- session title 生成是辅助流程；provider、解析或超时失败不得使主 turn 失败。
- title 生成不能覆盖并发产生的手工 title，也不能阻塞 agent loop 的终态交付。

## 6. 并发、取消与资源释放

- Gateway 层保证一个 `sessionKey` 同时最多一个 active turn；Agent Loop 不负责接受第二个并发 turn。
- abort 必须向 Router stream、ToolScheduler、permission/elicitation waiter 和 subagent 传播。
- WebSocket close、Gateway shutdown、用户 Stop 和 timeout 都必须最终释放 active state、pending request、tool waiter 和 timer。
- 旧 run 的迟到事件不得覆盖新 run；所有跨边界事件应带有可验证的 run/turn identity。
- 工具 scheduler 可以并发执行相互独立的调用，但结果合并和 transcript 配对必须确定性。

## 7. 可观测性

每个 turn 至少应能关联：`sessionId/sessionKey`、`turnId`、`runId`、provider、model、turn 次数、finish reason、stop reason、usage、tool call ID 和最终 outcome。日志和 telemetry 不得包含 API key、原始 transcript、绝对用户路径或未经脱敏的模型响应。

关键事件包括：

- `turn_started`、`input_accepted`、`model_request_started`；
- `model_event`、`tool_calls_detected`、tool start/finish；
- `turn_continued`、`context_budget`、恢复 status；
- `permission_request`、`elicitation_request` 及回答；
- `stop_requested`、`stop_failure`、`turn_failed`、`turn_completed`。

## 8. 测试映射

| 契约 | 当前测试/入口 | 证据层 |
| --- | --- | --- |
| AgentLoop context、compaction、model override | `tests/agent/loop/context-cap.spec.ts`、`tests/agent/loop/model-override-defaults.spec.ts` | Node 单元测试 |
| image-strip 和模型恢复 | `tests/agent/loop/image-strip-recovery.spec.ts`、`tests/model/**` | Node 单元测试 + provider fixture |
| session/turn/artifact | `tests/session/turn-file-artifacts.spec.ts`、`tests/session/turn-metadata-tail.spec.ts` | transcript/临时目录测试 |
| subagent loop | `tests/agent/sub/SubAgentSession.spec.ts` | 隔离 Agent Loop 测试 |
| Gateway busy/abort/replay/close | `tests/gateway/execution-lifecycle.spec.ts`、`tests/gateway/websocket-contract.spec.ts` | Gateway contract/process smoke |
| Router/fallback/stream recovery | `tests/regressions/model-router-regressions.spec.ts`、`tests/router/streaming-recovery.spec.ts` | deterministic + mutation |
| Tool 配对与权限 | `tests/tool/**`、`tests/permission/**` | tool/permission contract |

当前只证明测试通过，不自动等于历史回归证明。高风险行为必须补 `mutation proof` 或修复提交父版本的可复现失败证据。

当前独立覆盖测量（Node 25 环境，仅用于缺口审计）为 `AgentLoop.ts` 行 76.27%、分支 61.03%、函数 61.25%。现有测试已覆盖文本、tool loop、abort、model error、context cap、image strip、model override 和 subagent 基础路径；尚缺重试/继续、复杂 tool scheduler、权限与 elicitation 等待、终态去重、持久化失败和完整恢复矩阵。不得将这些当前通过测试写成 `PARENT_FAIL` 或 `MUTATION_FAIL`。

## 9. 分阶段建设路线图

### P0：基线与入口可观测性

- **目标**：建立 Agent Loop 的事件、终态和请求 identity 基线。
- **工作**：为每个 turn 统一规范化 `sessionId/turnId/runId`；补充唯一终态、abort 和异常路径测试；输出每轮 model/tool/stop 摘要。
- **验收**：正常、模型失败、tool 失败、abort、timeout 各有一条确定性测试；无悬空 tool call 或重复终态。
- **证据**：`pnpm test`、Gateway contract、artifact smoke。

### P1：模型请求与恢复矩阵

- **目标**：覆盖四协议请求/响应/stream 规范化和 Agent Loop 恢复策略。
- **工作**：补齐 empty output、max output、partial tool call、malformed stream、图片降级、retry/fallback 的表驱动测试；为关键修复添加 reverse mutation。
- **验收**：纯协议模块按路线图达到 100% lines/functions/branches；恢复有界且事件顺序稳定。
- **延期**：真实 provider 准确率进入 external nightly。

### P2：Tool、Permission 与 Subagent

- **目标**：证明 tool call/result 配对、权限优先级和 subagent 生命周期。
- **工作**：覆盖并发工具、scheduler 异常、permission/elicitation 等待、回答、取消、subagent heartbeat 和嵌套 abort。
- **验收**：每个 tool call 恰有一个终态；deny/safety 优先；父 loop 不会因子 loop 的异常泄漏状态。
- **证据**：公开入口测试、fake tool registry、mutation proof。

### P3：Context、Transcript 与持久化恢复

- **目标**：让 compaction、transcript、artifact 和 session reload 在失败时 fail closed。
- **工作**：补充损坏/截断 transcript、compaction 后重启、文件 artifact rollback、session title 并发和失败隔离测试。
- **验收**：reload 后 messages、usage、file state、metadata 可恢复；主 turn 不被辅助 title/artifact 失败阻塞。
- **证据**：临时目录、replay fixture、artifact smoke。

### P4：Gateway 与真实进程生命周期

- **目标**：验证 Agent Loop 在 Gateway、WebSocket 和进程边界上的完整行为。
- **工作**：启动本地 Gateway，覆盖 hello/auth、submit turn、busy、abort、close、replay、shutdown 和端口释放；验证旧 run 迟到事件隔离。
- **验收**：客户端断开必然中止在途 turn；abort 完成后才能接受新 turn；无遗留 timer/process。
- **证据**：`tests/gateway/**`、`pnpm test:contract`、`pnpm test:artifact`。

### P5：UI 与外部链路

- **目标**：验证 UI bridge、queued send、permission/elicitation、history/live 和 reconnect 对 Agent Loop 事件的消费。
- **工作**：公开 UI 入口 fake Gateway/Provider smoke；真实 provider、浏览器、平台 adapter 和 Docker 进入独立 nightly。
- **验收**：跨 session 状态隔离，迟到事件不覆盖当前 turn，最终 history/live 一致；普通 PR 不依赖外部账号。
- **证据**：Vitest、非阻塞 Playwright smoke、credentialed External Nightly。

## 10. 发布与回滚策略

- 发布前必须使用同一份已验证的 `dist` 构建运行 artifact smoke，不在发布阶段重新生成不同构建。
- Agent Loop、Gateway protocol、事件字段或持久化格式变化必须在 PR 中列出兼容性和迁移策略。
- 发现终态、tool pairing、abort 或 transcript 破坏时，优先回滚到上一份已验证 artifact；不得通过删除测试或吞掉错误恢复绿灯。

## 11. 完成定义

- 核心 loop 正常、失败、取消、重试、恢复和并发行为都有源码边界及测试映射。
- 高风险状态机至少有 mutation proof 或明确的 parent failure；`CURRENT_ONLY` 不得标成历史回归已证明。
- Node 22、锁定的 pnpm 版本下确定性 gate 通过；外部依赖缺失时明确失败或标记 `DEFER_EXTERNAL`。
- 文档、Agent Note、测试审计和 CI gate 同步更新；不提交临时配置、token、日志或构建产物。

## 12. 变更记录

| 日期 | 变更 | 维护者 |
| --- | --- | --- |
| 2026-08-21 | 新增 Agent Loop 功能 TRD、契约和分阶段测试路线图 | Agent Runtime 团队 |
