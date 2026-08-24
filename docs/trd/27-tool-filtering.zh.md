# Tool Filtering TRD

状态：评审中　维护者：Tool/Permission 团队

## 代码边界

覆盖 `allowedTools`、plan mode、ask mode、bypass、session allow、subagent 和 orchestration tool filtering。

## 核心契约

- `undefined`、空数组、无匹配数组和多匹配数组语义不同且可测试。
- safety deny 优先于所有 allow 规则。
- plan/ask/subagent 过滤不能扩权。
- 过滤后的空数组必须真正传给模型，而不是保留原工具集合。

## 测试

映射 `tests/tool/registry-scheduler.spec.ts`、`tests/tool/unavailable-tool.spec.ts` 和 permission/orchestration tests。availability 过滤、诊断保留和 alias 映射当前为 `CURRENT_ONLY`；`allowedTools` 空集合、无匹配集合和优先级仍需 mutation proof。

## 验收

生成的 tool schema 与 runtime registry 一致，模型看不到被禁止的工具，执行层再次校验权限。
