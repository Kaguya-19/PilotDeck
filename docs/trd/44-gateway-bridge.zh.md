# Gateway Bridge TRD

状态：评审中　维护者：UI/Runtime 团队　目标读者：Web bridge 和 Gateway 维护者

## 代码边界

覆盖 `ui/server/pilotdeck-bridge.js`、`ui/server/pilotdeck-message.js` 和 `src/web/client/GatewayBrowserClient.ts`。Bridge 只能连接独立 Gateway，不得创建第二套 Agent Runtime。

## 核心契约

- sessionId 到 Gateway sessionKey 必须稳定一对一映射，并在 resume 时复用。
- RPC request/response、GatewayEvent 到 NormalizedMessage 的映射必须保留 runId、requestId、seq 和终态 identity。
- 连接失败、旧连接迟到 close、abort 失败和 Gateway busy 都必须向 UI 发送可区分状态。
- bridge stop 或客户端断开后必须清理 active runs、pending permission/elicitation、重连 timer 和 socket listener。

## 流程与恢复

启动时按退避连接 Gateway；发送请求前确保握手完成；事件按 seq 转发；complete/failure 结束对应 run。旧 socket 的迟到事件不得覆盖新连接状态。abort 失败时保留旧 run 为 active，直到 Gateway 明确终态。

## 测试与证据

源码映射：`ui/server/pilotdeck-bridge.js`、`ui/server/pilotdeck-message.js`、`src/web/client/GatewayBrowserClient.ts`。测试映射：`ui/server/pilotdeck-bridge.test.js`、`tests/gateway/remote-gateway-contract.spec.ts`、`tests/gateway/websocket-contract.spec.ts`。当前为 `CURRENT_ONLY`，关键回归进入 mutation proof；浏览器交互归 Browser Smoke。

## 验收与变更

验收覆盖连接、握手、RPC 排序、事件映射、abort、重连和 shutdown。任何 NormalizedMessage 字段变化必须同步 UI reducer TRD 和 keyless event contract 测试。
