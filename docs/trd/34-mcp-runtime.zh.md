# MCP Runtime TRD

状态：评审中　维护者：MCP/Extension 团队

## 代码边界

覆盖 `src/mcp/client/**`、`src/mcp/runtime/**`、`src/mcp/config/**` 和 PluginToToolBridge。

## 核心契约

- MCP server 配置、placeholder 和 project/session scope 必须显式校验。
- client connect、request、notification、disconnect 和 restart 有明确生命周期。
- sanitize、wire name、image/file content 和 unsupported block 不得改变安全语义。
- MCP 保存或 reload 失败不覆盖上一份有效配置。

## 测试

映射 `tests/mcp/expand-placeholders.spec.ts`、`tests/mcp/mcp-runtime-pure.spec.ts`、`tests/mcp/client/McpClient.spec.ts`、`tests/mcp/client/McpClient.lifecycle.spec.ts` 和 `tests/extension/**`。已覆盖配置合并、Unicode/名称安全、描述截断、McpClient 握手、instructions、listTools 缓存、tool call、重连、timeout recycle、关闭和 unsupported transport；McpRuntime、PluginToToolBridge、配置 reload 和完整公开入口仍需补齐。

## 验收

fake MCP client 可验证正常调用、失败、取消、重建和资源清理；真实 MCP server 属于 external/deferred。
