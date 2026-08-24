# Gateway Wire Protocol TRD

状态：评审中　维护者：Gateway 团队

## 背景与代码边界

Gateway WebSocket 是本地客户端、UI bridge 和 Agent Runtime 的协议边界。权威实现位于 `src/gateway/protocol/frames.ts`、`src/gateway/protocol/types.ts` 和 `src/gateway/server/GatewayWsConnection.ts`。

## 核心契约

- 客户端必须先发送正确版本和 token 的 `hello`。
- request/response 使用稳定 request ID；stream event 使用递增 `seq` 和唯一 `final` frame。
- `submit_turn` 的中间事件不得伪装为最终完成。
- 错误必须包含稳定 code；客户端不得解析自然语言判断错误类型。

## 失败和恢复

版本或鉴权失败关闭连接；非法 frame 返回结构化错误；连接关闭时由运行时处理在途 turn。旧协议字段不得静默映射为新语义。

## 测试和证据

当前测试：`tests/gateway/websocket-contract.spec.ts`、`tests/gateway/remote-gateway-contract.spec.ts`、`tests/gateway/websocket-frame-boundaries.spec.ts` 和 `tests/gateway/static-assets.spec.ts`。已覆盖 hello/auth、非法 JSON/frame、未知 method、能力缺失结构化错误、RPC dispatch、stream seq/final、原生掩码 frame、分片、ping/pong、close、payload 长度和静态资源回退。`websocket.ts` 当前行覆盖 98.63%，`staticAssets.ts` 为 100%；`pnpm test:p1-proof --case gateway-error-code` 可证明错误 code 变异会失败；完整 RPC 错误矩阵和 parent failure 仍待补齐。

## 验收和后续

完成后必须覆盖 hello、auth、request/response、event seq/final、非法 JSON、非法 method 和错误结构；协议变化同步更新 `docs/gateway-protocol.zh.md`。外部网络不属于本 TRD。
