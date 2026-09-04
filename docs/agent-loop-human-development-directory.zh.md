# AgentLoop 模块化开发文档目录

面向人类开发者的阅读入口。本文只列出开发阶段、对应文档和交付物，不重复正文。

## 0. 项目入口

1. [AgentLoop Modular Framework 文档总览](agent-loop-modular-index.zh.md)
   - 了解文档关系、核心边界和当前验收状态。
2. [AgentLoop 接入开发 SOP](agent-loop-development-sop.zh.md)
   - 了解完整开发流程、禁止事项和验收门槛。

## 1. 需求与边界

1. 需求说明与非目标
2. DSH v0.1.2-alpha.2 能力族归属
3. AgentLoop 与宿主的 ownership 划分
4. 允许修改文件与禁止修改文件

参考：

- [AgentLoop 接入开发 SOP：问题和边界](agent-loop-development-sop.zh.md#1-先确定问题和边界)
- [AgentLoop 接入开发 SOP：DSH 能力族](agent-loop-development-sop.zh.md#2-参考模块分层dsh-v012-alpha2)
- [AgentLoop 接入开发 SOP：代码修改范围](agent-loop-development-sop.zh.md#3-代码修改范围控制)

交付物：`scope.md`、ownership 图、能力族归属、明确的非目标。

## 2. 协议与接口设计

1. 冻结 Module Protocol 版本和 profile
2. 定义身份字段：`runId`、`operationId`、`requestId`、`streamId`、`sequence`
3. 定义终态、错误码、retryability、取消、deadline 和恢复
4. 编写宿主字段到通用 payload 的 mapping
5. 编写 context、model、capability、permission 的调用接口
6. 更新 Schema、接口示例和兼容策略

参考：

- [Module Communication SOP](pilotdeck-module-communication-sop.zh.md)
- [Module Protocol v2 Schema](pilotdeck-module-protocol-v2.schema.json)
- [AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md)
- [AgentLoop 接入开发 SOP：Mapping/TRD](agent-loop-development-sop.zh.md#5-设计-mappingtrd-和接口文档)

交付物：mapping 表、TRD 章节、接口文档、Schema 变更、版本影响说明。

## 3. 契约测试设计

1. malformed message、未知版本和非法能力声明
2. identity 过滤、重复、乱序和 sequence gap
3. 唯一 final、`ok: false`、错误终态和 `result_unknown`
4. cancel/deadline 后迟到事件
5. toolCallId、batch 数量和结果顺序
6. 图片、消息顺序、checkpoint 和 seed state
7. permission 缺失、拒绝和 `canPrompt=false`

参考：

- [AgentLoop 接入开发 SOP：先写契约失败测试](agent-loop-development-sop.zh.md#6-先写契约失败测试)
- `tests/agent/modules/`
- `tests/protocol/`

交付物：先失败的契约测试、测试 fixture、预期终态表。

## 4. 模块实现

1. 定义或扩展 `ModelInvokerPort`、`ToolPort`、`AgentContextRuntime`
2. 实现宿主 module/provider/consumer
3. 实现通用 execute payload mapping
4. 实现 `hostModules` 能力协商和兼容回退
5. 实现 transport adapter：stdio、Unix Socket、HTTP/RPC 或 WS
6. 保留 native/direct 路径，确保 sidecar 只替换接入方式

当前 PilotDeck 参考代码：

- [`createSidecarExecution`](../src/cli/pilotdeck-agent-loop-default-factory.ts)
- [`createSidecarPorts`](../src/agent/modules/sidecar.ts)
- [`AgentLoopSidecarServer`](../src/agent/modules/sidecar.ts)
- [`HostModuleCapabilities`](../src/agent/modules/protocol.ts)
- [当前 PilotDeck 实现参考](agent-loop-development-sop.zh.md#71-当前-pilotdeck-实现参考)

交付物：adapter/module 实现、协议类型、focused tests、变更说明。

## 5. 语义回归

1. 运行 native/direct 回归
2. 运行 sidecar module/protocol 测试
3. 检查模型输入、工具、权限、终态和用户输出
4. 确认 legacy/native feature flag 关闭时行为不变

参考：

- [AgentLoop 接入开发 SOP：分层验证](agent-loop-development-sop.zh.md#8-分层验证)
- `tests/agent/loop/`
- `tests/agent/session/`
- `tests/agent/modules/`

交付物：构建日志、测试结果、native 行为回归结论。

## 6. 真实部署与对拍

1. 启动真实 Gateway、Session、ContextRuntime、ToolRuntime、PermissionRuntime
2. 接入 sidecar 进程和控制消息
3. 使用确定性 mock provider/tool
4. 运行 PilotDeck native vs sidecar gateway 对拍
5. 检查 cancel、deadline、断线、恢复、幂等和副作用状态
6. 将差异归因到 mapping、协议、core、宿主、测试设施或 known gap

参考：

- [PilotDeck Native / Sidecar 对拍 SOP](pilotdeck-agent-loop-parity-sop.zh.md)
- [PilotDeck 对拍工具 README](../tools/agent-loop-parity/README.md)
- [PilotDeck 对拍结果](pilotdeck-agent-loop-parity-results.zh.md)

交付物：canonical trace、差异报告、场景摘要、known-gap 记录、可复现命令。

## 7. 文档、提交与发布

1. 同步 SOP、Schema、TRD、mapping 和测试文档
2. 记录 commit、运行时版本、命令、退出码和产物目录
3. 检查没有 token、数据库、trace、日志或临时 worktree
4. 执行 `git diff --check` 和 `git status --short --branch`
5. 按协议、adapter、宿主 glue、文档拆分提交
6. 准备回滚或关闭 sidecar 的操作路径

参考：[AgentLoop 接入开发 SOP：发布前检查和回滚](agent-loop-development-sop.zh.md#10-发布前检查和回滚)

交付物：发布说明、提交清单、验收结论、回滚说明。

## 8. 人类审查顺序

```text
需求/边界
  -> DSH 能力族
  -> 通信 SOP / Schema
  -> Mapping / TRD
  -> 契约失败测试
  -> 模块与 adapter 实现
  -> native 回归
  -> 真实部署对拍
  -> 文档与发布审查
```

任何一步缺少对应交付物，都不能仅凭“编译通过”或“最终回答相同”标记模块接入完成。
