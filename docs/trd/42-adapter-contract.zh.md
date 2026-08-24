# Adapter and IM Contract TRD

状态：评审中　维护者：Channel 团队　目标读者：平台适配器和 Gateway 维护者

## 代码边界

公共边界位于 `src/adapters/channel/protocol/ChannelAdapter.ts`、`ChannelRuntimeStatus.ts`、`ImChatSessionState.ts` 与 `ImAttachment*`。平台差异见 `platforms/`，本文件不复制平台 SDK 细节。

## 核心契约

- 每个 adapter 必须通过公开 `start/stop` 管理连接、poll、heartbeat、SSE 和 reconnect 资源。
- 入站消息必须稳定映射为 session key 和一个 Gateway turn；busy 时不得重复启动，duplicate delivery 必须幂等。
- 出站文本、附件、permission/elicitation 回答必须保持 request/response identity，并在失败时返回可见错误。
- stop、主动 close 和异常 close 的重连语义必须区分，所有 pending 状态和 timer 都必须清理。

## 流程与恢复

典型时序为 `start -> connected -> receive -> gateway turn -> deliver -> idle`。鉴权失败进入不可重试错误；网络断开进入受控重连；Gateway close 必须中止在途 turn。附件下载、加密解码或平台限流失败只影响当前 delivery，不得污染其他 session。

## 测试与证据

源码映射：`src/adapters/channel/protocol/**` 与各平台目录。测试映射：`tests/adapters/im-permission-helper.spec.ts`、`tests/adapters/channel/feishu-render.test.ts`、`tests/adapters/feishu-permission-reply.spec.ts`；平台入口和真实账号链路标记 `DEFER_EXTERNAL`。CI 归属：Node deterministic gate；入口 smoke 和 nightly 见平台附录。

## 验收与变更

验收覆盖 start/stop、busy、duplicate、permission、elicitation、附件、重连和 cleanup。证据状态：公共 helper 已有当前测试，入口证据为 `CURRENT_ONLY`，真实平台为 `DEFER_EXTERNAL`。
