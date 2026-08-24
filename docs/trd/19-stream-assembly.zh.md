# Stream Assembly TRD

状态：评审中　维护者：Model Protocol 团队

## 代码边界

覆盖 `src/model/streaming/**` 的 SSE parsing、event normalization、assistant assembly、tool-call format 和 continuation。

## 核心契约

- 重复、乱序、空 chunk 和 malformed chunk 必须有确定处理。
- partial tool call 不得直接执行；必须进入恢复或失败。
- stream 恢复必须保留 continuation context 和已有有效文本。
- 终态、usage 和 finish reason 只能结算一次。

## 测试

映射 `tests/model/streaming/assembleModelMessage.test.ts`、`tests/model/streaming/openaiReasoningContent.spec.ts` 和 `tests/model/providers/google-and-responses.spec.ts`。Google 与 OpenAI Responses 的 provider stream 已覆盖 start、文本/推理、tool-call 聚合、重复完成、incomplete 和 failed；当前证据为 `CURRENT_ONLY`，mutation proof 仍覆盖丢事件、重复事件和错误终态。

## 验收

建立 keyless stream fixture，规范化动态 request/run ID 和时间，验证断流恢复顺序。
