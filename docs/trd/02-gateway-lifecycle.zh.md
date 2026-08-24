# Gateway Runtime Lifecycle TRD

状态：评审中　维护者：Gateway 团队

## 代码边界

负责 `InProcessGateway.submitTurn()`、`abortTurn()`、active snapshot、session router 和 `GatewayWsConnection` 的生命周期，不负责 AgentLoop 内部策略。

## 核心契约

- 同一 `sessionKey` 同时最多一个 active turn。
- abort 返回前，在途 AgentSession、tool waiter 和 stream 必须完全退出。
- WebSocket close、server shutdown、timeout 和用户 Stop 必须清理 active state、pending request 和 timer。
- 旧 run 的迟到事件不得覆盖新 run。

## 状态机

`idle -> active -> aborting -> idle`；模型/工具失败进入 `failed -> idle`；连接关闭进入 `aborting`。busy 请求必须返回可恢复错误，不得启动第二个 turn。

## 测试和证据

代码边界：`src/gateway/client/InProcessGateway.ts`、`src/gateway/SessionRouter.ts`、`src/gateway/server/GatewayWsConnection.ts`。

映射 `tests/gateway/execution-lifecycle.spec.ts`、`tests/gateway/active-turn-snapshot.spec.ts`、`tests/gateway/websocket-contract.spec.ts`、`tests/gateway/process-smoke.spec.ts`、`tests/gateway/gateway-server-boundaries.spec.ts`、`tests/gateway/gateway-bridge-boundaries.spec.ts`、`tests/gateway/gateway-ws-client.spec.ts`、`tests/gateway/session-router-boundaries.spec.ts`、`tests/gateway/in-process-optional-apis.spec.ts`、`tests/gateway/map-agent-event-boundaries.spec.ts` 和 `tests/gateway/in-process-telemetry-boundaries.spec.ts`。当前测试覆盖 busy、abort unwind、replay filtering、close abort、health/auth、真实 WebSocket turn framing、HTTP Feishu/static/404、广播通知、端口释放、可选 capability 委托、AgentEvent 映射和 telemetry 事件，以及 permission/elicitation bus、reload response parser、隔离 token、probe 超时和远端连接失败短路。`GatewayServer.ts` 行覆盖为 97.66%，`GatewayWsClient.ts` 行覆盖为 96.58%，`SessionRouter.ts` 行覆盖为 100%，`InProcessGateway.ts` 行覆盖为 97.54%；当前仍以 `CURRENT_ONLY` 为主，InProcess 分支、abort/close 的 mutation proof 和 shutdown timer 的独立变异仍需补齐。

## 验收

验证 abort 后新 turn 可提交、close 后无遗留 timer/process、active replay 只包含未完成事件，并通过 `pnpm test:contract` 和 `pnpm test:artifact`。
