# Tool Execution Result TRD

状态：评审中　维护者：Tool Runtime 团队

## 代码边界

本 TRD 的生产边界是：

- `src/tool/execution/ToolRuntime.ts`：工具名修复、输入校验、plan/ask 约束、生命周期 hook、权限决策、执行、结果限制、审计和嵌套调用。
- `src/tool/execution/validateToolInput.ts`、`formatValidationError.ts`：schema 校验和模型可读诊断。
- `src/tool/execution/errorRecovery.ts`：错误分类、恢复建议和敏感信息约束。
- `src/tool/execution/repairToolName.ts`：配置别名、内置别名和模糊匹配。
- `src/tool/protocol/result.ts`：结果 content、预览截断和 canonical 投影。

不包含 builtin 工具内部的文件、网络或平台实现；这些实现由对应 builtin/adapter TRD 负责，统一经过 `ToolRuntime.execute()` 进入本边界。

## 核心契约

- 输入校验失败不得执行命令或修改无关状态。
- tool result 必须包含 toolCallId、成功/失败状态和可消费内容。
- 大结果使用引用/预览，不能无界注入下一轮 context。
- binary、Office、image 和 file result 使用明确 content type。

## 状态机与失败恢复

```text
model tool_call
  -> 名称修复/不可用诊断
  -> abort、plan/ask、schema 和 prompt 能力检查
  -> PreToolUse（block 或更新 input）
  -> PermissionRuntime（allow/deny/ask/cancel）
  -> execute
  -> PostToolUse 或 PostToolUseFailure
  -> tool_result + audit
```

任何前置失败都不得执行工具；hook 更新后的 input 必须再次校验；工具抛错必须规范化为可消费的 error result；旧的 progress 不能替代终态 result。

## 测试与证据

当前确定性入口：

- `tests/tool/tool-runtime.spec.ts`：成功、截断、别名、不存在/不可用、abort、schema、plan/ask、prompt 缺失、hook block/update、todo gate、permission hook、cancel/ask、异常恢复、progress、审计和嵌套执行。
- `tests/tool/unavailable-tool.spec.ts`、`tests/tool/registry-scheduler.spec.ts`：可用性、registry 和 scheduler。
- `tests/tool/**`：builtin 的文件、网络和附件边界。

`scripts/check-module-coverage.mjs` 已将 `src/tool/execution/**` 纳入覆盖率入口。当前证据为 `CURRENT_ONLY`；尚未有父提交失败或精确 mutation 失败证明。真实平台工具、模型二次调用和浏览器入口属于 `DEFER_EXTERNAL`/entry smoke。

## 验收

失败结果可被下一轮模型安全消费；tool pairing、路径和引用均有 contract 断言。修改执行边界时必须运行定向 ToolRuntime 测试、`pnpm run test:coverage`、`pnpm run check:docs` 和 `git diff --check`。
