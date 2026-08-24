# PilotDeck 细粒度 TRD 建设路线图

状态：评审中　维护者：PilotDeck 工程团队

## 目标

把 Agent、Context、Model、Router、Tool、Permission、Extension、Session、Automation、Adapter、Web、UI 和运行时支持拆成独立可维护的功能 TRD。每份 TRD 只拥有一个主责任边界，跨边界行为通过接口、事件、状态机和测试映射连接。

## 交付波次

### Wave 1：核心状态和协议

完成 01-06。先固定 Gateway frame、turn identity、AgentLoop 终态和 AgentEvent 配对。

### Wave 2：Context、Compaction 和 Model

完成 07-19。先写预算和 projection，再写 compaction/recovery，最后补四协议和 stream assembler。

### Wave 3：Router、Tool 和 Permission

完成 20-31。明确路由、重试、tool description/schema、过滤优先级、执行结果和权限交互。

### Wave 4：扩展、持久化和自动化

完成 32-41。覆盖 plugin、skill、MCP、transcript、文件安全、Always-On、Cron 和 background task。

### Wave 5：入口、UI 和运维

完成 42-50 以及 `platforms/` 附录。覆盖 adapter、Web API、bridge、UI、CLI、配置、网络和 telemetry。

## 每份 TRD 的固定章节

1. 文档状态、维护者、目标读者和适用范围。
2. 背景、目标、非目标、术语和边界。
3. 源码边界、依赖和数据流。
4. 状态机、正常流程、失败/取消/重试/恢复流程。
5. 并发、幂等、超时、资源释放和安全边界。
6. 可观测性、脱敏和兼容性。
7. 当前测试、mutation、parent、external、deferred 证据。
8. CI、artifact、browser smoke、nightly 归属。
9. 验收标准、延期项和变更记录。

## 依赖关系

```text
Gateway/Agent identity
  -> Context/Model/Router
  -> Tool/Permission/Extension
  -> Session/File/Automation
  -> Adapter/Web/Bridge/UI
  -> CLI/Config/Network/Telemetry
```

下游 TRD 不得重新定义上游事实来源；发现冲突时回到 Gateway、canonical model 或持久化契约处理。

## 完成定义

- 所有主 TRD 在索引中有 owner、状态和源码/测试映射。
- 关键状态机覆盖正常、失败、取消、超时、重试和恢复。
- `CURRENT_ONLY` 不冒充 `PARENT_FAIL` 或 `MUTATION_FAIL`。
- 外部模型、平台账号、浏览器和 Docker 明确标记 `DEFER_EXTERNAL`。
- `git diff --check` 和 `pnpm run check:docs` 通过。
