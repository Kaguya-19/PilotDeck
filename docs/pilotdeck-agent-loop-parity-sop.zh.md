# PilotDeck AgentLoop Native / Sidecar 对拍 SOP

状态：执行稿
适用范围：PilotDeck AgentLoop 原生（native/direct）链路与 Module Protocol sidecar 链路的语义对拍。
维护者：Agent Runtime 团队

本文只规定 PilotDeck 侧的对拍口径。PilotDeck 仓库内的 `tools/agent-loop-parity/` 提供 PilotDeck-only runner、mock、trace 和 native/sidecar adapter；StaffDeck 测试仓库另行维护跨宿主 orchestrator、Gateway runner 和 Harness/TaskFrame/SOP adapter。StaffDeck 的 Harness/TaskFrame/SOP 对拍不属于本文的验收范围。

## 1. 目标和边界

对拍回答一个问题：在相同 AgentLoop 输入、相同宿主 modules、相同模型和工具响应下，native 与 sidecar 是否产生相同的 AgentLoop 语义。

被比较的 PilotDeck 语义包括：

- system prompt、canonical messages、图片和其他媒体 block；
- model request、model response、attempt 和 stream interruption；
- tool descriptor、tool call 名称/参数、permission decision、开始/完成顺序和结果；
- context/module call、`seedState` 和恢复后的消息顺序；
- `completed`、`failed`、`cancelled`、`result_unknown` 终态；
- `stopReason`、错误码、retryability、usage、structured output 和用户可见输出。

不属于 PilotDeck core 对拍的内容：

- StaffDeck `TaskRequirement`、`TaskFrame`、Harness action、SOP、lease 和 fencing；
- 宿主数据库 schema、Gateway sessionKey、前端布局和宿主最终 operation 聚合；
- 随机 ID、时间戳、进程号、NDJSON envelope 和 provider 私有字段布局。

sidecar 必须保持宿主无关。context、model、capability/tool 和 permission 由 host module 或 port 提供；对拍不能用 sidecar 内置的宿主逻辑替代真实 host module。

## 2. 被测链路

| 链路 | 入口 | 唯一执行差异 |
| --- | --- | --- |
| native | 真实 `createAgentSession` / Gateway -> 原生 `AgentLoop` | 无 sidecar |
| sidecar | 同一 Gateway/Session -> stdio 或其他 Module Protocol adapter -> `AgentLoop` | AgentLoop 通过 sidecar transport 运行 |

推荐使用同一版本进行主对拍：当前 native vs 当前 sidecar。`origin/main` 只用于记录产品版本漂移，应单独运行 current native vs baseline native，不能把 baseline 漂移算作 sidecar 差异。

PilotDeck 对拍可以使用两种表面：

- **direct**：直接构造真实 AgentLoop/session，适合快速定位 mapping 和协议问题；
- **gateway**：启动真实 HTTP/WebSocket Gateway、Session、ContextRuntime、ToolRuntime 和 PermissionRuntime，适合最终验收。

最终验收必须包含 gateway 表面；direct 通过不能替代真实部署验证。

## 3. 测试设施和 adapter 契约

PilotDeck-only 对拍代码位于本仓库：

```text
tools/agent-loop-parity/run.py
tools/agent-loop-parity/scenarios.json
tools/agent-loop-parity/mock_backend.py
tools/agent-loop-parity/adapters/pilotdeck_native.py
tools/agent-loop-parity/adapters/pilotdeck_sidecar.py
tools/agent-loop-parity/adapters/pilotdeck_gateway_impl.mjs
```

StaffDeck fork 中的 `tools/agent-loop-parity/` 是跨宿主版本，额外包含 StaffDeck adapter 和真实 Harness 部署设施；两套 PilotDeck adapter 共享同一协议和 trace 口径，但 PilotDeck 版本不依赖 StaffDeck 代码。

PilotDeck adapter 必须：

1. 从指定 checkout/ref 加载产品代码，不导入当前工作树的隐式模块；
2. 接收 `PARITY_SCENARIO_ID`、`PARITY_Q`、mock endpoint 和 trace 输出路径；
3. 调用真实 native 或 sidecar 入口，不通过 reply 文本伪造终态；
4. 每个逻辑事件写出一个 JSONL 对象，至少包含 `kind`、`scenarioId`、`q`、`sequence`；
5. 启动、导入、执行或 trace 写入失败时返回非零并标记 `BLOCKED`；
6. 不写入 token、真实 API key、数据库或持久化图片 data URL。

统一事件类型建议包括：`model.request`、`model.response`、`tool.call`、`tool.result`、`permission.decision`、`checkpoint`、`terminal` 和 `user.output`。对拍器必须能定位最早分叉事件，而不是只报告最终文本不同。

## 4. 场景矩阵

### 4.1 核心回归

- 纯文本模型响应；
- 单工具调用；
- 多工具调用，比较 batch、permission preflight、并发策略和结果顺序；
- 图片/多模态输入，比较 MIME、data、消息分组和顺序；
- `canPrompt=true/false`、permission allow/ask/deny；
- `max_turns`、模型临时错误、不可重试错误、非法响应和流中断。

### 4.2 可靠性和恢复

- attempt/operation deadline；
- 模型请求中取消、工具执行中取消、取消后迟到 completed；
- sidecar 在副作用前退出、在副作用后退出、重启和 `result_unknown`；
- duplicate execute、相同 idempotency key 重试、旧 request/stream event；
- checkpoint 位于模型调用前、工具执行后和工具结果回写后；
- 合法 `seedState` 恢复、非法 seedState 拒绝、历史消息顺序保持。

每个 suite 至少连续运行两次，语义投影必须一致。mock provider/tool 必须由 `scenarioId + q + normalized input` 决定结果，不得依赖 wall clock 或随机值。

## 5. Trace 和比较规则

比较前先做显式 canonical projection：

- 保留消息 role、content block、文本、图片 MIME/data、tool call/result、错误码和终态；
- 保留逻辑 sequence、permission decision、checkpoint/seed 投影和用户输出；
- 仅删除随机 ID、时间戳、进程号、transport envelope 和 provider 私有包装；
- canonical image block 中允许忽略派生 `bytes` 字段；普通对象里的 `bytes` 不能被全局忽略；
- StaffDeck 或其他宿主的业务包装必须由宿主 adapter 显式归一化，PilotDeck comparator 不做宽泛吞差异。

比较结果分类：

| 分类 | 含义 | 退出码 |
| --- | --- | ---: |
| `PASS` | 只有已声明 normalization 差异，无语义分叉 | 0 |
| `FAIL` | 存在未声明的消息、工具、权限、错误、终态或用户输出差异 | 1 |
| `BLOCKED` | 环境、入口、依赖、进程或 trace 缺失导致无法完成执行 | 2 |
| `WARNING` | 仅 provider/transport 格式差异，且 downstream 语义一致 | 不改变 gate |

`completed`、`failed`、`cancelled` 和 `result_unknown` 永远不能互相归一化。缺失 event、sequence gap、错误 requestId、重复 final 或 sidecar 退出也不能用最终文本相同来掩盖。

## 6. 运行顺序

### 6.1 环境准备

```bash
source ~/.nvm/nvm.sh
nvm use 22
pnpm build
```

确认 PilotDeck 使用 Node 22 和仓库固定的 pnpm；确认 StaffDeck adapter 使用其 `backend/.venv`。运行前检查存在可用的临时目录和 localhost 端口范围。

### 6.2 运行 PilotDeck 对拍

从 PilotDeck 仓库根目录执行：

```bash
python tools/agent-loop-parity/run.py \
  --pilotdeck-root /path/to/PilotDeck-current \
  --pilotdeck-baseline working-tree \
  --comparison same-version \
  --surface gateway \
  --scenario all \
  --output /tmp/agent-loop-parity-pilotdeck
```

对照 `origin/main` 的版本漂移运行：

```bash
python tools/agent-loop-parity/run.py \
  --pilotdeck-root /path/to/PilotDeck-current \
  --pilotdeck-baseline origin/main \
  --comparison both \
  --surface gateway \
  --scenario all \
  --output /tmp/agent-loop-parity-pilotdeck-baseline
```

`working-tree` 结果用于 sidecar parity gate；`origin/main` 结果单独报告产品版本漂移。两次运行都必须保留命令、checkout/ref、运行时版本、退出码和输出目录。

### 6.3 结果分析

按以下顺序分析：

1. 先检查是否 `BLOCKED`；
2. 再检查 fixture/oracle 是否通过；
3. 找到最早 semantic divergence；
4. 根据 ownership 判断属于 core、module adapter、host module、transport 或 harness；
5. 修复后先跑 focused test，再跑受影响 suite，最后重跑完整 gateway 对拍。

不得先扩大 normalization，也不得以“模型最终回答相同”作为通过理由。

## 7. 验收门槛

PilotDeck native/sidecar 对拍只有同时满足以下条件才可标记通过：

- 所有适用场景均有两条完整 trace，无 `BLOCKED`；
- fixture/oracle 校验通过；
- system prompt、messages、图片、工具、权限、checkpoint、终态和用户输出无未声明差异；
- cancel、deadline、断线、重启、`result_unknown` 和迟到事件分类正确；
- 两次连续运行的 canonical projection 一致；
- native direct/gateway 回归、sidecar module tests 和项目 build/check 通过；
- `git diff --check` 通过，临时 trace、数据库、日志和凭证未进入 Git。

若仍有差异，报告必须分成“已确认对齐”“确认不一致”“测试设施问题”“known gap”，并给出最早分叉路径和两侧规范化值。

## 8. 相关文档

- [AgentLoop 接入开发 SOP](agent-loop-development-sop.zh.md)
- [Module Communication SOP](pilotdeck-module-communication-sop.zh.md)
- [Module Protocol v2 Schema](pilotdeck-module-protocol-v2.schema.json)
- [AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md)
- StaffDeck [AgentLoop parity README](https://github.com/Kaguya-19/StaffDeck/tree/codex/pilotdeck-agent-loop/tools/agent-loop-parity/README.md)
- StaffDeck [实验结果](https://github.com/Kaguya-19/StaffDeck/tree/codex/pilotdeck-agent-loop/tools/agent-loop-parity/EXPERIMENT_RESULTS.zh.md)
