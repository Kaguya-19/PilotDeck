# Tool Registry TRD

状态：评审中　维护者：Tool Runtime 团队

## 代码边界

覆盖 `src/tool/registry/createBuiltinRegistry.ts`、`ToolRegistry.ts` 和 availability registry。

## 核心契约

- 每个注册工具有稳定 name、kind、description、inputSchema 和 availability。
- opt-in/opt-out 必须明确；禁用工具返回 unavailable reason。
- 注册顺序和重复 name 行为必须确定。
- registry 不执行工具，也不绕过 permission。

## 测试

映射 `tests/tool/registry-scheduler.spec.ts`、`tests/tool/unavailable-tool.spec.ts`、`tests/tool/builtin/**` 和 execute code tests。当前覆盖 alias、重复注册、clone/replace/unregister、availability 缓存和 unavailable 诊断，证据为 `CURRENT_ONLY`；所有 builtin 的完整注册矩阵仍需补充。

## 验收

配置不同 feature 时 registry 可预测；未知工具返回结构化错误；没有 test-only 导出。
