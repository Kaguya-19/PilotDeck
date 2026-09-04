# AgentLoop Modular Framework 文档总览

状态：执行稿　维护者：Agent Runtime 团队

本文是 PilotDeck AgentLoop 模块化框架的文档入口。协议和 AgentLoop 核心规范归
PilotDeck；宿主产品的 session、turn、permission、tool、checkpoint、SOP/Harness
和最终状态仍由宿主维护。

## 阅读顺序

1. [AgentLoop 接入开发 SOP](agent-loop-development-sop.zh.md)

   面向开发者的阶段流程、DSH 能力族模块划分、代码修改范围、mapping/TRD 产物、分层测试、真实部署、对拍和发布检查。

2. [Module Communication SOP](pilotdeck-module-communication-sop.zh.md)

   规范身份字段、operation/attempt 状态、终态、取消、deadline、重试、恢复、profile
   和 transport-independent adapter 约定。当前文档版本为 v0.3，协议版本为 v2.0。

3. [Module Protocol v2 Schema](pilotdeck-module-protocol-v2.schema.json)

   机器可读的 request、response、event、error、module_call 和 host module 字段定义。

4. [AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md)

   说明 `ModelInvokerPort`、`ToolPort`、`AgentContextRuntime`、sidecar factory、
   context module 和 capability module 的实现边界。

5. [StaffDeck AgentLoop Integration](https://github.com/Kaguya-19/StaffDeck/tree/codex/pilotdeck-agent-loop/docs/pilotdeck-agent-loop-integration.md)

   StaffDeck 的具体 glue、TaskFrame/Harness mapping、checkpoint 投影、权限聚合和
   result_unknown 处理只在 StaffDeck 仓库维护，不成为 PilotDeck core contract。

6. [PilotDeck Native / Sidecar 对拍 SOP](pilotdeck-agent-loop-parity-sop.zh.md)

   PilotDeck 原生与 sidecar 的比较范围、adapter 契约、scenario 矩阵、canonical trace、
   normalization、退出码和 gateway 验收门槛。

   实际运行记录见 [PilotDeck AgentLoop 对拍结果](pilotdeck-agent-loop-parity-results.zh.md)。

7. [AgentLoop parity README](https://github.com/Kaguya-19/StaffDeck/tree/codex/pilotdeck-agent-loop/tools/agent-loop-parity/README.md)

   跨宿主对拍 harness、mock provider/tool、canonical trace 和 StaffDeck 真实部署验证方法；
   PilotDeck-only 工具则位于本仓库的 `tools/agent-loop-parity/`。

## 架构边界

```text
宿主 Session/Turn/Run
        |
        +-- context module  -> 宿主 ContextRuntime
        +-- capability      -> 宿主 ToolRuntime/PermissionRuntime
        +-- model           -> 宿主 Model provider
        +-- checkpoint      -> 宿主持久化和恢复逻辑
        |
        +-- PilotDeck AgentLoop
              +-- canonical messages
              +-- model/tool loop
              +-- unique terminal outcome
              +-- sidecar protocol adapter
```

AgentLoop 不识别 StaffDeck 的 TaskRequirement、HarnessAction、TaskFrame 或租约字段。
宿主将自己的业务状态投影为通用 payload；sidecar 只消费 canonical messages、tool
descriptors、permission context、seed state 和 execution identity。

## 跨语言和 transport 约定

- Module Protocol 使用 JSON/NDJSON wire format，字段和终态由 v2 Schema 定义，语言实现
  不受 TypeScript 限制。
- AgentLoop 核心只依赖 ports；stdio sidecar 是当前提供的跨进程实现，不是协议唯一 transport。
- 其他语言或通道可以实现自己的 adapter，但必须保持 `hello`、`capabilities`、`execute`
  以及适用的 `cancel`、`status`、`resume`、`ack` profile 语义。
- 宿主必须拥有 session/turn/run/operation 最终状态；模块不得创建第二套公共状态。
- permission、tool 并发、checkpoint 持久化和最终结果聚合由宿主负责，不能在 sidecar 内复制
  宿主业务规则。

## 接入开发 SOP

每次新增或修改模块能力时同步更新：

1. JSON Schema 中的字段/profile 定义；
2. 本 SOP 的身份、终态、错误和 Mapping 章节；
3. TRD 中的 port、adapter 和 ownership 说明；
4. 协议单元测试，包括 malformed message、duplicate、乱序、sequence gap、cancel、
   deadline、断线和恢复边界；
5. 至少一个真实宿主 adapter 的端到端验证记录。

接入前必须明确 module profile、能力版本、request/event identity、错误码、retryability、
副作用和恢复策略。不得把宿主专属字段放进 PilotDeck 默认 factory，也不得用宽泛的
normalization 规则隐藏 semantic diff。

## 当前验收状态

- PilotDeck native vs sidecar：`core-regression` 10/10、`core-resilience` 20/20，当前
  对拍为零 semantic diff。
- `auto_compact` 仍是显式 known gap：host context overflow 与 sidecar 完成路径不同。
- StaffDeck workflow 对拍已能真实进入 Harness，但 SOP step/slot/handoff、deadline、
  unknown result 等宿主状态仍有差异，不能作为 PilotDeck core 已完全验收的依据。
- 完整生产级跨语言 SDK、Schema runtime validator 和断线 resume/status/ack 仍是后续工作，
  本文不将其表述为已完成能力。

## 验证命令

在 Node 22 环境运行：

```text
pnpm build
node --test dist/tests/agent/modules/*.js \
  dist/tests/agent/session/agent-loop-factory.spec.js \
  dist/tests/protocol/module-protocol-contract.spec.js
git diff --check
```

对拍和真实部署命令、版本、退出码及临时产物位置见 StaffDeck 的实验记录，不将 trace、
SQLite、日志或 token 提交到 PilotDeck。
