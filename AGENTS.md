# PilotDeck 工程与测试规范

## 核心事实来源

- Gateway 是 `session`、`turn`、`message` 和 `active-run` 的唯一事实来源。UI、adapter 和 bridge 只能投影或转发，不得各自创建另一套执行状态。
- 同一 session 同时最多一个 active turn。事件必须保留 session、turn、run 和 request identity；旧 run 的迟到事件不得覆盖新 run。
- RPC、协议事件、持久化格式、模型可见输入和用户可见输出发生变化时，必须同步更新契约文档和确定性测试。

## 修改与回归

- bug 必须先建立当前代码上的失败复现，再修改生产代码。
- 测试必须验证正常、失败、取消、超时、重试、并发和恢复中适用的行为。
- 不得删除、跳过或弱化失败测试来获得全绿；fixture、配置、secret 或外部依赖缺失时必须明确失败或标记延期，不得静默通过。
- 不得通过扩大 `any`、关闭 `strict`、添加 `@ts-ignore`、排除源码或伪造 test-only 生产导出来消除错误。
- 只修改完成任务所需的文件；保留无关的用户改动，不提交 `dist`、`node_modules`、coverage、trace、临时 `PILOT_HOME`、token 或测试产物。

## 证据与交付

- 当前测试通过只能记为 `CURRENT_ONLY`；只有父提交复现失败才记为 `PARENT_FAIL`，精确反向 mutation 使目标测试失败才记为 `MUTATION_FAIL`。
- 交付前运行最小相关测试；跨模块变更运行 `pnpm check`。交付说明必须列出实际命令、Node/pnpm 版本、环境限制和 deferred 项。
- 不能只依据 agent 输出判断成功：重新读取实际生成文件，运行真实构建产物入口，并检查 `git diff --check` 和 `git status`。

## 文档同步

代码边界、状态机、协议字段、错误恢复或测试证据变化时，必须更新对应 `docs/trd/` 文档和索引。文档中不得写入真实 token、用户本机绝对路径、临时配置或未脱敏日志。
