# Extension Plugin TRD

状态：评审中　维护者：Extension 团队

## 代码边界

覆盖 `src/extension/plugins/**`、manifest、marketplace、PluginRegistry、PluginRuntime 和 reload policy。

## 核心契约

- plugin discovery 只加载合法 manifest 和允许来源。
- contribution 的 owner、类型、优先级和冲突处理稳定。
- reload 失败保留上一份有效 snapshot，不影响在途 turn。
- plugin 停止必须清理 MCP、hook、tool 和 timer。

## 测试

映射 `tests/extension/**`、config reload tests 和 MCP/skill integration tests。补充 malformed manifest、冲突、reload failure 和 cleanup。

## 验收

插件从发现、加载、贡献、reload 到卸载均有状态和错误映射，外部插件留在 deferred/nightly。
