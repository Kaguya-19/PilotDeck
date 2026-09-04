# AgentLoop 模块化开发人类交互 SOP

状态：执行稿
适用范围：人类开发者通过 coding agent 进行 PilotDeck AgentLoop 模块解耦、sidecar 接入或宿主适配。

本文只规定“人类如何和 agent 协作”。模块边界、协议字段和技术验收规则分别以：

- [AgentLoop 接入开发 SOP](agent-loop-development-sop.zh.md)
- [Module Communication SOP](pilotdeck-module-communication-sop.zh.md)
- [Module Protocol v2 Schema](pilotdeck-module-protocol-v2.schema.json)
- [AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md)

为准。

## 1. 第一次消息

推荐开场模板：

```text
请在开一个新的WorkTree 中处理以下模块化任务，实现以下模块的sidecar方案：

目标：<要拆分的模块（语义边界，如tool，权限等）>
禁止修改：src/agent/loop/AgentLoop.ts 核心循环，以及<其他范围>
语义要求：native/direct 行为保持不变；sidecar 不生成宿主专属语义。

请先阅读：
1. docs/agent-loop-human-operation-sop.zh.md
2. docs/agent-loop-development-sop.zh.md
3. docs/pilotdeck-module-communication-sop.zh.md
4. docs/pilotdeck-module-protocol-v2.schema.json
5. docs/trd/03-agent-loop-modular.zh.md

先不要改代码。请先返回：问题理解、DSH 能力族归属、ownership、mapping、允许/禁止修改文件、测试计划和风险。
```

## 2. 等 agent 先做边界确认

agent 第一次回复必须能回答：

- 这个问题属于哪个 DSH 能力族；
- 哪些逻辑属于 PilotDeck core，哪些属于宿主 glue；
- 哪些字段进入通用 payload，哪些字段留在宿主；
- 哪些模块由宿主提供：context、model、capability、permission等等；
- 是否会改变 native/direct 语义**（一般不允许）**；
- 是否需要更新 Schema、SOP、TRD 或接口文档；
- 哪些测试能证明问题，而不是只证明最终文本相同。

如果 agent 直接开始大范围重构，没有先给出这些内容，应回复：

```text
先暂停实现。请先给出 ownership、DSH 能力族、mapping、允许修改文件、禁止修改文件和测试计划。
确认后再开始编辑。
```

## 3. 指定修改范围

每次交互只推进一个能力族或一个明确的协议问题。推荐这样约束：

```text
本轮只处理 context module 的输入 mapping。
可以修改：<列出文件>
禁止修改：AgentLoop.ts、capability、permission、Gateway 状态机和宿主数据库。
若发现需要改变核心循环，请停止实现并报告，不要自行扩大范围。
```

常用范围示例：

```text
本轮只处理 capability/tool：检查 descriptor、toolCallId、execute_batch、执行上下文和结果顺序。
```

```text
本轮只处理 interaction/permission：检查 permissionContext、canPrompt、allow/ask/deny 和 fail-closed。
```

```text
本轮只处理 transport：检查 requestId、streamId、sequence、cancel、deadline、final 和 result_unknown。
```

## 4. 对拍有差异时让 agent 修复

当 native/sidecar 对拍出现差异时，直接把对拍结果和差异报告交给 agent：

```text
请根据这次对拍结果修复 semantic diff：<粘贴 summary、最早分叉事件或差异报告>

只修复与该差异直接相关的模块或 adapter。
禁止修改：src/agent/loop/AgentLoop.ts 核心循环，以及本任务已列出的其他禁止文件。
不要通过扩大 normalization、删除断言或只比较最终回答来隐藏差异。
修复后重新运行受影响场景和完整 PilotDeck 对拍，并报告仍存在的差异。
```

如果 agent 发现必须修改禁止文件，要求它先停下：

```text
不要修改禁止文件。请说明为什么当前差异无法在批准范围内修复，并给出需要单独评审的 core 语义影响。
```

## 5. 审查 agent 的回报

不要只看“测试通过”。要求 agent 按以下格式回报：

```text
问题和归因：
能力族和 ownership：
修改文件：
未修改但审计过的文件：
mapping/协议变化：
native/direct 语义是否变化：
测试命令和实际结果：
对拍结果和最早差异：
known gap：
未解决风险：
是否满足提交条件：
```

人类重点复核四件事：

1. 修改文件是否超出批准范围；
2. 是否把宿主语义塞进 PilotDeck 默认 factory 或 sidecar；
3. 是否通过放宽比较规则掩盖差异；
4. 失败、取消、超时和副作用不明是否被错误地当成成功。

## 6. 接受、返工或停止

### 可以接受

```text
确认 ownership、diff 范围、测试和对拍结果符合要求。
请最后执行 git diff --check、git status --short --branch，并给出提交摘要。
```

### 需要返工

```text
不要继续扩大范围。以下问题需要修正：<列出具体差异>。
请先补回归测试，再修改对应 adapter/module；保留当前差异证据。
```

### 发现核心语义变化

```text
暂停当前任务。这个改动可能改变 AgentLoop core/direct 语义。
请撤回未批准的核心修改（不要覆盖其他用户改动），并单独输出 core 设计影响分析。
```

### 环境阻塞

```text
不要伪造通过。请明确区分 BLOCKED、FAIL 和 PASS，记录缺失的 Node/依赖/服务/凭证，
并继续完成不依赖该环境的静态、契约和单元验证。
```

## 7. 提交和推送交互

只有人类明确授权后，才让 agent commit/push：

```text
现在只提交本任务批准范围内的文件。
提交前列出 staged 文件、git diff --cached --check、commit message 和目标 remote/branch。
确认没有 trace、数据库、日志、coverage、__pycache__、token 或真实 API key 后再 commit。
commit 后执行 git status、git log -1 和 git ls-remote 核对远端分支。
```

如果只需要提交而不推送：

```text
只 commit，不 push。完成后返回 commit id 和工作树状态。
```

## 8. 最小人类交互闭环

```text
给目标和约束
  -> 要求 agent 先读 SOP 并返回边界
  -> 确认 DSH 能力族和 mapping
  -> 批准实现范围
  -> 运行对拍
  -> 有差异就让 agent 修复，且不得修改禁止文件
  -> 审查 diff 和剩余差异
  -> 明确接受、返工或停止
  -> 最后单独授权 commit/push
```

人类的核心职责是确认范围、把对拍差异交给 agent 修复，并守住禁止修改的文件边界。只要对拍
仍有未解释差异，就不要接受任务完成；也不要因为最终回答相同而放宽比较规则。
