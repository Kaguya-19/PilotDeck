# OpenAI Responses Adapter TRD

状态：评审中　维护者：Model Protocol 团队

## 代码边界

覆盖 `src/model/providers/openai-responses/**` 的 item/event 生命周期。

## 核心契约

- response item 顺序映射为 canonical assistant/tool 事件。
- `response.failed` 只能产生一个完整失败终态。
- output text、reasoning、function call、function result 和 usage 不得重复。
- abort 和 provider failure 必须保持错误类别。

## 测试

直接映射 `tests/model/providers/google-and-responses.spec.ts`，覆盖 request input/tool/result 投影、文本/推理/函数调用响应、JSON repair、重复 completion、item-done、incomplete 和 failed event。现阶段证据为 `CURRENT_ONLY`；重复 item、失败终态和工具参数修复仍需单独 mutation proof。

## 验收

覆盖文本、工具、失败、取消、usage 和多 item 顺序；artifact smoke 加载编译后 adapter。
