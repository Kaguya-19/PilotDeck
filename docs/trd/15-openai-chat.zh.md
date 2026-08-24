# OpenAI Chat Adapter TRD

状态：评审中　维护者：Model Protocol 团队

## 代码边界

覆盖 OpenAI Chat Completions request/response/stream adapter、tool call 和 usage mapping。

## 核心契约

- canonical request 不得被 provider builder 原地修改。
- message、tool、reasoning、multimodal 和 finish reason 映射必须稳定。
- SSE 断流、HTTP error、tool call 分片和 abort 必须归一化。
- provider 原始错误不直接泄露到用户或 telemetry。

## 测试

映射 `src/model/providers/openai/**`、model request/stream tests 和 external nightly。离线测试使用固定 fixture，不访问公网。

## 验收

正常文本、tool call、usage、错误、取消和断流都有 request/response/stream 断言。
