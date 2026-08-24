# Google Gemini Adapter TRD

状态：评审中　维护者：Model Protocol 团队

## 代码边界

覆盖 `src/model/providers/google/**` 的 request、response、stream、function call 和 SDK client。

## 核心契约

- Gemini object union 必须展平为 canonical block，不泄露 provider union 结构。
- function call/result 顺序和 name/id 映射稳定。
- SDK abort、HTTP error 和 malformed object 保持正确错误类别。
- multimodal 内容遵守 capability 和大小限制。

## 测试

直接映射 `tests/model/providers/google-and-responses.spec.ts`，覆盖 model id、request role/tool/media projection、thinking、JSON schema 清理、response text/thinking/function call/usage、stream start/text/thinking/tool/finish，以及 malformed payload。适配器集合当前行覆盖率为 `95.28%`，证据为 `CURRENT_ONLY`；真实 Google provider 进入 external nightly。

## 验收

覆盖正常文本、tool call、union、usage、abort、错误和空 payload。
